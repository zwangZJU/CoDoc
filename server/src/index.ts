/**
 * CoDoc 后端入口
 * - Fastify 提供 HTTP 接口（文档元数据、创建）
 * - 原生 ws 在 /ws/:docName 升级为 Yjs 协同房间
 */
import Fastify from 'fastify'
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 分享链接对外地址：自动推导 + 可显式覆盖 ----
// 推导规则（满足零配置）：
//   nginx 反代（docker 部署）：X-Forwarded-Proto/Host 已由 nginx.conf 传入真实域名 → 直接用
//   直连（本地 dev）：Host = localhost:1234 → 本机可打开
//   无代理直连 :1234：优先 localhost:1234，避免拼出内网 IP / 公网 IP 导致外部打不开
// PUBLIC_BASE 显式设置后，不再自动推导（用于域名固定、且不希望被请求头干扰的场景）
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').trim()
// 分享链接 = base + 应用路径。若前端代理到子路径下，用 PUBLIC_APP_PATH 覆盖，默认根路径 /
const PUBLIC_APP_PATH = (process.env.PUBLIC_APP_PATH || '').trim() || '/'
const SHARE_APP_SUFFIX = PUBLIC_APP_PATH.startsWith('/') ? PUBLIC_APP_PATH : '/' + PUBLIC_APP_PATH

/** 依据请求头还原"前端可达"的地址；找不到协议时回退 http（wss 场景由 nginx 统一处理） */
function shareBaseOf(req: { headers: Record<string, string | string[] | undefined> }): string {
  const h = (k: string) => {
    const v = req.headers[k]
    return Array.isArray(v) ? v[0] : v
  }
  if (PUBLIC_BASE) {
    return PUBLIC_BASE.replace(/\/+$/, '') + SHARE_APP_SUFFIX
  }
  const proto = h('x-forwarded-proto') || h('x-forwarded-scheme') || 'http'
  const host = h('x-forwarded-host') || h('host') || 'localhost:1234'
  return proto + '://' + host + SHARE_APP_SUFFIX
}
import {
  setupWSConnection,
  getVersions,
  saveVersion,
  restoreVersion,
  renameVersion,
  readVersionPreview,
  autoSaveVersionIfStale,
  getLiveRooms,
} from './wsserver.ts'

const PORT = Number(process.env.PORT || 1234)
const HOST = process.env.HOST || '0.0.0.0'

// ---- 轻量 .env 读取（server/.env，若存在则加载；Node 原生无 dotenv）----
{
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env')
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (m && !(m[1] in process.env)) {
        let v = m[2]
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        process.env[m[1]] = v
      }
    }
  }
}

// ---- 智能助手后端直连 Hermes 的 OpenAI 兼容 API（API Server 网关适配器）----
// 说明：Hermes 的 API Server 会暴露 /v1/chat/completions、/v1/responses、/v1/runs 等 HTTP 接口，
// 默认监听 127.0.0.1:8642，鉴权用 Bearer API_SERVER_KEY。这就是 Open WebUI 等“云端 Hermes”
// 对外提供的 HTTP 接入方式。codoc 侧只需在 server/.env 配好地址与密钥即可。
// 本地（WSL 与 hermes 同机）填 http://127.0.0.1:8642/v1；远端（云端 Hermes）填云主机地址。
const HERMES_BASE = (process.env.HERMES_API_URL || 'http://127.0.0.1:8642/v1').trim().replace(/\/+$/, '')
const HERMES_KEY = (process.env.HERMES_API_KEY || '').trim()
// 单文档独立会话以文档为单位记忆，避免互相串台；留空则关闭（每次为无记忆单轮）
const HERMES_SESSION_KEY_PREFIX = (process.env.HERMES_SESSION_KEY || 'codoc').trim()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')

/** 简单 JSON 持久化：团队 / 文档元数据落盘，重启不丢（Yjs 内容已由 wsserver 落盘） */
function loadJson<T>(file: string, fallback: T): T {
  try {
    const f = path.join(DATA_DIR, file)
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8')) as T
  } catch {
    /* ignore */
  }
  return fallback
}
function saveJson(file: string, data: unknown) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2))
  } catch (e) {
    console.error('[persist] write failed', file, e)
  }
}

const fastify = Fastify({ logger: false })

// 文档元数据：内存为主，元数据落盘到 data/docs.json（内容由 Yjs 二进制负责）
type DocMeta = {
  id: string
  name: string
  kind: 'sheet' | 'doc'
  createdAt: number
  updatedAt: number
  owner: string
  /** 归属团队 id；为空表示个人空间 */
  teamId?: string
}
const meta = new Map<string, DocMeta>(
  Object.entries(loadJson<Record<string, DocMeta>>('docs.json', {}))
)
const saveDocs = () => saveJson('docs.json', Object.fromEntries(meta))

// ---- 团队 / 团队成员（文件持久化到 data/teams.json） ----
type TeamMember = { id: string; name: string; role: 'admin' | 'member' }
type Team = {
  id: string
  name: string
  desc: string
  createdAt: number
  members: TeamMember[]
}
const teams = new Map<string, Team>(
  Object.entries(loadJson<Record<string, Team>>('teams.json', {}))
)
const saveTeams = () => saveJson('teams.json', Object.fromEntries(teams))

// 每个文档一套成员名单（演示用内存存储；真实环境应接账号系统 + 持久层）
type Member = { name: string; perm: 'edit' | 'comment' | 'view' }
const membersByDoc = new Map<string, Map<string, Member>>()

const membersOf = (docId: string) => {
  let m = membersByDoc.get(docId)
  if (!m) {
    m = new Map()
    membersByDoc.set(docId, m)
  }
  return m
}

fastify.get('/', async () => ({ name: 'CoDoc server', ok: true }))

// ---- 智能助手：反向代理到 Hermes OpenAI 兼容 API 服务 ----
// 客户端发：{ docId, context, messages, attachments }
//   - context：选区说明文本（含引用的真实单元格数据）
//   - messages：历史会话 [{ role: 'user'|'assistant', content }]
//   - attachments：本轮上传的多模态附件 [{ name, mime, dataUrl }]（图片转 data:image/ 地址，Hermes 用 vision 理解）
// 服务端把最后一条 user 消息拼成 OpenAI 多模态 content（text + image_url），带会话与鉴权头转发，
// 再把 Hermes 的回答整理成前端 AIPanel 的分步卡片结构 { steps: [{ title, body, terminal }] }。
type AiAttachment = { name: string; mime?: string; data?: string }
type AiMsg = { role: 'user' | 'assistant'; content: string }

fastify.post<{
  Body: {
    docId?: string
    context?: string
    messages?: AiMsg[]
    attachments?: AiAttachment[]
  }
}>('/api/ai/chat', async (req, reply) => {
  const { docId, context, messages = [], attachments = [] } = req.body ?? {}
  if (!HERMES_KEY) {
    reply.code(503)
    return {
      error: '尚未配置 Hermes 接入。请在 server/.env 里设置 HERMES_API_KEY（以及云端时的 HERMES_API_URL），详见 server/.env.example。',
      demo: true,
    }
  }

  // 整理 OpenAI 格式的 messages
  const openaiMsgs: any[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const isLast = i === messages.length - 1
    // 最后一条 user 消息：拼上选区上下文 + 多模态附件（图片 image_url）
    if (role === 'user' && isLast) {
      const parts: any[] = []
      const textParts: string[] = []
            if (context) textParts.push(context)
            textParts.push(m.content || '')
      const textBlob = textParts.filter(Boolean).join('\n\n')
      if (textBlob.trim()) parts.push({ type: 'text', text: textBlob })
      // 附件：仅 data:image/ 形式可被 Hermes API 理解；其余忽略并提示
      for (const a of attachments || []) {
        const d = a.data || ''
        if (d.startsWith('data:image/')) {
          parts.push({ type: 'image_url', image_url: { url: d } })
        }
      }
      openaiMsgs.push({ role: 'user', content: parts })
    } else {
      openaiMsgs.push({ role, content: m.content || '' })
    }
  }
  // 没有任何可见内容时兜底给出提示而非空转发
  if (!openaiMsgs.length) {
    reply.code(400)
    return { error: '消息内容为空' }
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${HERMES_KEY}`,
  }
  // 按文档隔离会话记忆：X-Hermes-Session-Key 让 Hermes 记住本文档对话，多轮不散
  if (docId && HERMES_SESSION_KEY_PREFIX) {
    headers['x-hermes-session-key'] = `${HERMES_SESSION_KEY_PREFIX}:${docId}`
  }

  let upstream: { choices?: { message?: { content?: string } }[] }
  try {
    const r = await fetch(`${HERMES_BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: openaiMsgs,
        stream: false,
      }),
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      console.error(`[ai] upstream ${r.status}: ${txt.slice(0, 300)}`)
      reply.code(502)
      return { error: `Hermes 服务出错（${r.status}）：${txt.slice(0, 200)}` }
    }
    upstream = (await r.json()) as any
  } catch (e: any) {
    reply.code(502)
    return {
      error: `无法连接 Hermes（${HERMES_BASE}）。请确认 Hermes 的 API Server 已启用且在运行，或检查 server/.env 的 HERMES_API_URL。`,
    }
  }

  const text = (upstream?.choices?.[0]?.message?.content || '').trim()
  if (!text) {
    reply.code(502)
    return { error: 'Hermes 没有返回内容（可能图片不被当前模型接受或上游异常）' }
  }

  return {
    steps: [{ title: '智能助手回复', body: text }],
    ok: true,
  }
})

// 文档头像：无账号系统，用统一占位头像 + 名字首字
function avatarFor(name: string) {
  return { url: '', name }
}

/** 当前在线信息：房间 id → { conns, users } */
const liveSnapshot = () => getLiveRooms()

fastify.get<{ Querystring: { team?: string } }>('/api/docs', async (req) => {
  const live = liveSnapshot()
  const team = req.query?.team
  const source = team
    ? Array.from(meta.values()).filter((d) => d.teamId === team)
    : Array.from(meta.values())
  return {
    docs: source
      .map((d) => {
        const room = live[d.id]
        return {
          ...d,
          members: membersOf(d.id).size,
          online: room ? Math.max(room.conns, room.users.length) : 0,
          onlineUsers: room ? room.users : [],
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }
})

/** 单独查询实时在线情况（工作台轮询用，返回 { rooms: { [docId]: { conns, users } } }） */
fastify.get('/api/live', async () => ({ rooms: liveSnapshot() }))

/** 单文档元数据：分享链接直达 /?doc=<id> 时前端用它还原标题与类型 */
fastify.get<{ Params: { id: string } }>('/api/docs/:id', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) {
    reply.code(404)
    return { error: '文档不存在或已被删除' }
  }
  const live = liveSnapshot()[d.id]
  return {
    ...d,
    members: membersOf(d.id).size,
    online: live ? Math.max(live.conns, live.users.length) : 0,
    onlineUsers: live ? live.users : [],
  }
})

fastify.post<{
  Body: { name?: string; kind?: 'sheet' | 'doc'; owner?: string; teamId?: string }
}>('/api/docs', async (req) => {
  const id = randomUUID().slice(0, 8)
  const name = (req.body?.name || '未命名文档').trim() || '未命名文档'
  const kind = req.body?.kind === 'doc' ? 'doc' : 'sheet'
  const now = Date.now()
  meta.set(id, {
    id,
    name,
    kind,
    createdAt: now,
    updatedAt: now,
    owner: req.body?.owner || 'local',
    ...(req.body?.teamId ? { teamId: req.body.teamId } : {}),
  })
  membersOf(id).set('owner', {
    name: req.body?.owner || '我',
    perm: 'edit',
  })
  saveDocs()
  return { id, name, kind }
})

fastify.patch<{ Params: { id: string }; Body: { name?: string } }>(
  '/api/docs/:id',
  async (req, reply) => {
    const d = meta.get(req.params.id)
    if (!d) {
      reply.code(404)
      return { error: 'not found' }
    }
    if (req.body?.name) {
      d.name = req.body.name.trim() || d.name
    }
    d.updatedAt = Date.now()
    saveDocs()
    return { id: d.id, name: d.name, kind: d.kind }
  }
)

fastify.delete<{ Params: { id: string } }>('/api/docs/:id', async (req) => {
  const d = meta.get(req.params.id)
  if (!d) return { ok: false, error: 'not found' }
  meta.delete(req.params.id)
  membersByDoc.delete(req.params.id)
  shareMeta.delete(req.params.id)
  return { ok: true }
})

// ---- 团队管理（文件持久化到 data/teams.json） ----
fastify.get('/api/teams', async () => {
  const fileCount = (id: string) =>
    Array.from(meta.values()).filter((d) => d.teamId === id).length
  return {
    teams: Array.from(teams.values()).map((t) => ({
      ...t,
      fileCount: fileCount(t.id),
      memberCount: t.members.length,
    })),
  }
})

fastify.post<{ Body: { name?: string; desc?: string; owner?: string } }>(
  '/api/teams',
  async (req, reply) => {
    const name = (req.body?.name || '').trim()
    if (!name) {
      reply.code(400)
      return { error: '团队名称不能为空' }
    }
    const id = 't' + randomUUID().slice(0, 8)
    const now = Date.now()
    const ownerName = (req.body?.owner || '我').trim() || '我'
    const team: Team = {
      id,
      name,
      desc: (req.body?.desc || '').trim(),
      createdAt: now,
      members: [{ id: 'owner', name: ownerName, role: 'admin' }],
    }
    teams.set(id, team)
    saveTeams()
    return { id, name, desc: team.desc }
  }
)

fastify.patch<{ Params: { id: string }; Body: { name?: string; desc?: string } }>(
  '/api/teams/:id',
  async (req, reply) => {
    const t = teams.get(req.params.id)
    if (!t) {
      reply.code(404)
      return { error: 'not found' }
    }
    if (req.body?.name) t.name = req.body.name.trim() || t.name
    if (req.body?.desc !== undefined) t.desc = req.body.desc.trim()
    saveTeams()
    return { ok: true }
  }
)

fastify.delete<{ Params: { id: string } }>('/api/teams/:id', async (req) => {
  teams.delete(req.params.id)
  // 文档归属置空，回到个人空间（不删文档本身）
  for (const d of meta.values()) {
    if (d.teamId === req.params.id) d.teamId = undefined
  }
  saveTeams()
  saveDocs()
  return { ok: true }
})

fastify.post<{
  Params: { id: string }
  Body: { name?: string; role?: 'admin' | 'member' }
}>('/api/teams/:id/members', async (req, reply) => {
  const t = teams.get(req.params.id)
  if (!t) {
    reply.code(404)
    return { error: 'not found' }
  }
  const name = (req.body?.name || '').trim()
  if (!name) {
    reply.code(400)
    return { error: '成员姓名不能为空' }
  }
  const existing = t.members.find((m) => m.name === name)
  if (existing) return { id: existing.id, ok: true, existed: true }
  const mid = 'm' + Math.random().toString(36).slice(2, 8)
  const role = req.body?.role === 'admin' ? 'admin' : 'member'
  t.members.push({ id: mid, name, role })
  saveTeams()
  return { id: mid, ok: true }
})

fastify.patch<{
  Params: { id: string; mid: string }
  Body: { role?: 'admin' | 'member' }
}>('/api/teams/:id/members/:mid', async (req, reply) => {
  const t = teams.get(req.params.id)
  if (!t) {
    reply.code(404)
    return { error: 'not found' }
  }
  const m = t.members.find((x) => x.id === req.params.mid)
  if (!m) {
    reply.code(404)
    return { error: 'member not found' }
  }
  if (req.body?.role) m.role = req.body.role === 'admin' ? 'admin' : 'member'
  saveTeams()
  return { ok: true }
})

fastify.delete<{ Params: { id: string; mid: string } }>(
  '/api/teams/:id/members/:mid',
  async (req) => {
    const t = teams.get(req.params.id)
    if (!t) return { ok: false, error: 'not found' }
    t.members = t.members.filter((x) => x.id !== req.params.mid)
    saveTeams()
    return { ok: true }
  }
)

// ---- 分享与权限（演示态：内存存储） ----
type ShareMeta = { scope: 'specified' | 'org' | 'any'; defaultPerm: 'edit' | 'comment' | 'view' }
const shareMeta = new Map<string, ShareMeta>()
const shareOf = (docId: string): ShareMeta => {
  let s = shareMeta.get(docId)
  if (!s) {
    s = { scope: 'specified', defaultPerm: 'edit' }
    shareMeta.set(docId, s)
  }
  return s
}

fastify.get<{ Params: { id: string } }>('/api/docs/:id/share', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) {
    reply.code(404)
    return { error: 'not found' }
  }
  const list = Array.from(membersOf(d.id).entries()).map(([k, v]) => ({ id: k, ...v }))
  const s = shareOf(d.id)
  return {
    scope: s.scope,
    defaultPerm: s.defaultPerm,
    members: list,
    // 分享链接：优先 PUBLIC_BASE 显式配置；否则按请求头自动推导（nginx 反代传 X-Forwarded-*，
    // 本地 dev 用 Host），这样本地 / WSL / 公网都能生成"前端可打开"的正确链接
    link: shareBaseOf(req) + '?doc=' + encodeURIComponent(d.id),
  }
})

// 修改链接范围 / 新成员默认权限
fastify.patch<{
  Params: { id: string }
  Body: { scope?: ShareMeta['scope']; defaultPerm?: ShareMeta['defaultPerm'] }
}>('/api/docs/:id/share', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) {
    reply.code(404)
    return { error: 'not found' }
  }
  const s = shareOf(d.id)
  if (req.body?.scope) s.scope = req.body.scope
  if (req.body?.defaultPerm) s.defaultPerm = req.body.defaultPerm
  return { ok: true, scope: s.scope, defaultPerm: s.defaultPerm }
})

fastify.post<{ Params: { id: string }; Body: { name?: string; perm?: 'edit' | 'comment' | 'view' } }>(
  '/api/docs/:id/share/invite',
  async (req, reply) => {
    const d = meta.get(req.params.id)
    if (!d) {
      reply.code(404)
      return { error: 'not found' }
    }
    const mid = 'm' + Math.random().toString(36).slice(2, 8)
    membersOf(d.id).set(mid, {
      name: req.body?.name || '新成员',
      perm: req.body?.perm || shareOf(d.id).defaultPerm,
    })
    return { id: mid, ok: true }
  }
)

fastify.patch<{ Params: { id: string }; Body: { memberId?: string; perm?: 'edit' | 'comment' | 'view' } }>(
  '/api/docs/:id/share/member',
  async (req, reply) => {
    const m = membersOf(req.params.id).get(req.body?.memberId || '')
    if (!m) {
      reply.code(404)
      return { error: 'member not found' }
    }
    m.perm = req.body.perm || 'edit'
    return { ok: true }
  }
)

fastify.delete<{ Params: { id: string }; Body: { memberId?: string }; Querystring: { memberId?: string } }>(
  '/api/docs/:id/share/member',
  async (req) => {
    membersOf(req.params.id).delete(req.body?.memberId || req.query?.memberId || '')
    return { ok: true }
  }
)

// ---- 历史版本 ----
fastify.get<{ Params: { id: string } }>('/api/docs/:id/versions', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) {
    reply.code(404)
    return { error: 'not found' }
  }
  return { versions: getVersions(d.id) }
})

// 某个版本的内容摘要预览（只读快照）
fastify.get<{ Params: { id: string; vid: string } }>(
  '/api/docs/:id/versions/:vid/preview',
  async (req, reply) => {
    const d = meta.get(req.params.id)
    if (!d) {
      reply.code(404)
      return { error: 'not found' }
    }
    return readVersionPreview(d.id, req.params.vid)
  }
)

fastify.post<{ Params: { id: string }; Body: { label?: string; auto?: boolean; author?: string } }>(
  '/api/docs/:id/versions',
  async (req, reply) => {
    const d = meta.get(req.params.id)
    if (!d) {
      reply.code(404)
      return { error: 'not found' }
    }
    const v = saveVersion(d.id, req.body?.label, req.body?.author)
    return { version: v, ok: !!v }
  }
)

// 给版本命名 / 改名
fastify.patch<{ Params: { id: string; vid: string }; Body: { label?: string } }>(
  '/api/docs/:id/versions/:vid',
  async (req, reply) => {
    const d = meta.get(req.params.id)
    if (!d) {
      reply.code(404)
      return { error: 'not found' }
    }
    return { ok: renameVersion(d.id, req.params.vid, req.body?.label || '') }
  }
)

fastify.post<{ Params: { id: string; vid: string } }>(
  '/api/docs/:id/versions/:vid/restore',
  async (req, reply) => {
    const d = meta.get(req.params.id)
    if (!d) {
      reply.code(404)
      return { error: 'not found' }
    }
    const ok = restoreVersion(d.id, req.params.vid)
    d.updatedAt = Date.now()
    return { ok }
  }
)

// ---- 导出支持的静态信息（方便前端提示合并版本）：
// 导出时由前端读取当前在线人数，此处不做额外处理。

// WebSocket 升级：任意路径即房间名（开发期经 vite /collab 代理后落到这里）
const wss = new WebSocketServer({ noServer: true })

fastify.server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', 'http://localhost')
  const docName = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!docName) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    try {
      setupWSConnection(ws, docName)
      // 连接建立后有机会触发一次自动版本快照（若距上次 ≥60s）
      autoSaveVersionIfStale(docName)
    } catch (e) {
      console.error('[ws] setup failed', e)
      ws.close()
    }
  })
})

fastify.listen({ port: PORT, host: HOST }, () => {
  console.log(`CoDoc server listening on http://${HOST}:${PORT} (ws: /ws/:docName)`)
})
