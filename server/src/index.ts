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
import { SHEET_AGENT_SKILL } from './aiSkill'
import {
  setupWSConnection,
  getVersions,
  saveVersion,
  restoreVersion,
  renameVersion,
  readVersionPreview,
  autoSaveVersionIfStale,
  getLiveRooms,
  refreshRoomPerms,
  kickUsers,
} from './wsserver.ts'
import * as auth from './auth.ts'
import type { User } from './auth.ts'
import { runAiStream, resolveApproval, stopRun, type AiStreamCfg, type AiRequestBody } from './aiStream.ts'
import * as perm from './perm.ts'
import type { Perm, Scope, LinkPerm } from './perm.ts'

/**
 * 身份识别：登录用户由会话（HttpOnly Cookie / Bearer）解析，得到账号 userId。
 * 权限一律锚定 userId —— 换浏览器、换访问入口都不影响归属。
 */
function meOf(req: { headers: Record<string, string | string[] | undefined> }): User | null {
  return auth.userOfRequest(req)
}

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
  /** 所有者账号 userId（权限归属的真正锚点） */
  ownerId?: string
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

/** 成员/权限统一由 perm 模块管理（持久化到 data/share.json），这里只保留计数辅助 */
const memberCountOf = (docId: string) => perm.getShare(docId).members.length

/**
 * 历史文档迁移：docs.json 里有、但 share.json 里没有权限记录的文档，
 * 由第一个登录访问的人认领为所有者。仅在本地部署的迁移路径上触发一次。
 */
function migrateLegacy(docId: string, me: User | null) {
  if (me && !perm.hasOwner(docId)) {
    perm.claimLegacyOwner(docId, me)
  }
}

fastify.get('/', async () => ({ name: 'CoDoc server', ok: true }))

// ---- 登录与会话 ----
// 身份锚点 = 账号 userId；会话凭证放 HttpOnly Cookie，WebSocket 握手也会自动带上。
// 登录方式可插拔：未配 OIDC 时用 dev 一键登录，配了就走标准 OIDC 授权码流程（IdP 由环境变量决定）。
fastify.get('/api/auth/config', async () => auth.authConfig())

fastify.get('/api/auth/me', async (req, reply) => {
  const me = meOf(req)
  if (!me) {
    reply.code(401)
    return { error: '未登录' }
  }
  return {
    user: { id: me.id, name: me.name, email: me.email, avatar: me.avatar, provider: me.provider },
  }
})

fastify.post<{ Body: { name?: string } }>('/api/auth/dev-login', async (req, reply) => {
  if (!auth.devLoginEnabled()) {
    reply.code(403)
    return { error: '当前已启用 SSO，请使用企业账号登录' }
  }
  const name = (req.body?.name || '').trim()
  if (!name) {
    reply.code(400)
    return { error: '请填写姓名' }
  }
  const u = auth.upsertUser({ provider: 'dev', sub: name, name })
  const s = auth.createSession(u.id)
  reply.header('set-cookie', auth.sessionCookieHeader(s.token, s.expiresAt))
  return { ok: true, user: { id: u.id, name: u.name } }
})

/** 发起登录：OIDC 模式跳转 IdP；未配 OIDC 时回前端登录页自己填名字 */
fastify.get<{ Querystring: { next?: string } }>('/api/auth/login', async (req, reply) => {
  const next = req.query?.next || '/'
  if (auth.authMode() !== 'oidc') {
    reply.redirect(auth.appOrigin() + '/?login=1&next=' + encodeURIComponent(next))
    return
  }
  try {
    reply.redirect(await auth.beginOidc(next))
  } catch (e) {
    reply.code(500)
    return { error: e instanceof Error ? e.message : 'OIDC 配置有误' }
  }
})

/** OIDC 回调：换令牌 -> 拉资料 -> 建会话 -> 回前端 */
fastify.get<{ Querystring: { code?: string; state?: string } }>(
  '/api/auth/callback',
  async (req, reply) => {
    const code = req.query?.code || ''
    const state = req.query?.state || ''
    if (!code) {
      reply.code(400)
      return { error: '缺少授权码 code' }
    }
    try {
      const r = await auth.completeOidc(code, state)
      reply.header('set-cookie', auth.sessionCookieHeader(r.session.token, r.session.expiresAt))
      reply.redirect(auth.appOrigin() + (r.next || '/'))
    } catch (e) {
      const msg = e instanceof Error ? e.message : '登录失败'
      reply.redirect(auth.appOrigin() + '/?login=failed&msg=' + encodeURIComponent(msg))
    }
  }
)

fastify.post('/api/auth/logout', async (req, reply) => {
  auth.destroySession(auth.tokenOfRequest(req))
  reply.header('set-cookie', auth.clearCookieHeader())
  return { ok: true }
})

/** 用户搜索：邀请协作者时按名字/邮箱找人（只返回展示字段） */
fastify.get<{ Querystring: { q?: string } }>('/api/users', async (req, reply) => {
  const me = meOf(req)
  if (!me) {
    reply.code(401)
    return { error: '未登录' }
  }
  return {
    users: auth.searchUsers(req.query?.q || '', me.id).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatar: u.avatar,
    })),
  }
})

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

  // 整理 OpenAI 格式的 messages（首位放表格操作技能，让智能体每轮都知道自己能读写单元格）
  const openaiMsgs: any[] = [{ role: 'system', content: SHEET_AGENT_SKILL }]
  let hasVisible = false
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
      if (parts.length) hasVisible = true
    } else {
      openaiMsgs.push({ role, content: m.content || '' })
      if (m.content) hasVisible = true
    }
  }
  // 没有任何可见内容时兜底给出提示而非空转发
  if (!hasVisible) {
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

// ---- 流式会话：把 Hermes 富事件翻译成 NDJSON 逐行回传前端 ----
fastify.post<{ Body: AiRequestBody }>('/api/ai/chat/stream', async (req, reply) => {
  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const send = (row: Record<string, unknown>) => {
    try {
      raw.write(JSON.stringify(row) + '\n')
    } catch {
      /* 客户端断开等写入异常忽略 */
    }
  }
  const cfg: AiStreamCfg = {
    base: HERMES_BASE,
    key: HERMES_KEY,
    sessionKeyPrefix: HERMES_SESSION_KEY_PREFIX,
  }
  try {
    await runAiStream(cfg, (req.body as AiRequestBody) ?? {}, send)
  } catch (e: any) {
    send({ type: 'error', message: e?.message || '流式请求内部错误' })
  } finally {
    try {
      send({ type: 'done' })
      raw.end()
    } catch {
      /* ignore */
    }
  }
})

// 处理授权决策：把前端按钮映射转发给 Hermes /v1/runs/{id}/approval
fastify.post<{ Body: { runId?: string; choice?: string } }>('/api/ai/approve', async (req, reply) => {
  const { runId, choice } = req.body ?? {}
  if (!runId || !choice) {
    reply.code(400)
    return { error: '缺少 runId 或 choice' }
  }
  const r = await resolveApproval(
    { base: HERMES_BASE, key: HERMES_KEY, sessionKeyPrefix: HERMES_SESSION_KEY_PREFIX },
    runId,
    choice
  )
  if (!r.ok) {
    reply.code(502)
    return { error: r.error }
  }
  return { ok: true }
})

// 中断正在运行的智能体
fastify.post<{ Body: { runId?: string } }>('/api/ai/stop', async (req, reply) => {
  const { runId } = req.body ?? {}
  const r = await stopRun(
    { base: HERMES_BASE, key: HERMES_KEY, sessionKeyPrefix: HERMES_SESSION_KEY_PREFIX },
    runId || ''
  )
  if (!r.ok) {
    reply.code(502)
    return { error: r.error }
  }
  return { ok: true }
})

// 文档头像：无账号系统，用统一占位头像 + 名字首字
function avatarFor(name: string) {
  return { url: '', name }
}

/** 当前在线信息：房间 id → { conns, users } */
const liveSnapshot = () => getLiveRooms()

fastify.get<{ Querystring: { team?: string } }>('/api/docs', async (req, reply) => {
  const live = liveSnapshot()
  const team = req.query?.team
  const me = meOf(req)
  if (!me) {
    reply.code(401)
    return { error: '未登录' }
  }
  const source = team
    ? Array.from(meta.values()).filter((d) => d.teamId === team)
    : Array.from(meta.values())
  source.forEach((d) => migrateLegacy(d.id, me))
  return {
    docs: source
      .map((d) => {
        const room = live[d.id]
        const acc = perm.resolveAccess(d.id, true, me.id)
        return {
          ...d,
          members: memberCountOf(d.id),
          // 在线人数以 awareness 里的去重用户为准；conns 会把同一人多开标签页算成多人
          online: room ? room.users.length : 0,
          onlineUsers: room ? room.users : [],
          myLevel: acc.ok ? acc.level : 'none',
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }
})

/** 单独查询实时在线情况（工作台轮询用，返回 { rooms: { [docId]: { conns, users } } }） */
fastify.get('/api/live', async () => ({ rooms: liveSnapshot() }))

/**
 * 我的访问状态：分享链接直达 / 轮询权限变化都用它。
 * 没有权限时返回 403，但**仍然告诉对方文档标题和所有者是谁**——
 * 飞书的做法是给一个"申请权限"页而不是白屏或报错。
 */
fastify.get<{ Params: { id: string } }>('/api/docs/:id/me', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) {
    reply.code(404)
    return { error: '文档不存在或已被删除' }
  }
  const me = meOf(req)
  if (!me) {
    reply.code(401)
    return { error: '未登录' }
  }
  migrateLegacy(d.id, me)
  const acc = perm.resolveAccess(d.id, true, me.id)
  if (!acc.ok) {
    const pending = perm.pendingRequestOf(d.id, me.id)
    const rejected = perm.rejectedRequestOf(d.id, me.id)
    return {
      docId: d.id,
      name: d.name,
      kind: d.kind,
      level: 'none' as const,
      status: pending ? ('pending' as const) : rejected ? ('rejected' as const) : ('none' as const),
      ownerName: perm.getShare(d.id).members.find((m) => m.owner)?.name || d.owner,
      // 链接是否对外开放：决定了访客登记后是「直接进」还是「提交申请」
      linkOpen: perm.getShare(d.id).scope !== 'off',
      canRequest: true,
    }
  }
  return {
    docId: d.id,
    name: d.name,
    kind: d.kind,
    level: acc.level,
    via: acc.via,
    status: 'granted' as const,
    ownerName: perm.getShare(d.id).members.find((m) => m.owner)?.name || d.owner,
    canRequest: false,
    pendingRequests: perm.atLeast(acc.level, 'manage')
      ? perm.listRequests(d.id).map((r) => ({
          id: r.id,
          name: r.name,
          want: r.want,
          note: r.note,
          ts: r.ts,
        }))
      : undefined,
  }
})

/** 单文档元数据：分享链接直达 /?doc=<id> 时前端用它还原标题与类型 */
fastify.get<{ Params: { id: string } }>('/api/docs/:id', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) {
    reply.code(404)
    return { error: '文档不存在或已被删除' }
  }
  const live = liveSnapshot()[d.id]
  // 未登录也要能拿到标题/类型：分享点开后先看到登录页，登录页要显示"你要打开的是哪份文档"
  const me = meOf(req)
  const acc = perm.resolveAccess(d.id, true, me?.id || '')
  return {
    ...d,
    members: memberCountOf(d.id),
    online: live ? live.users.length : 0,
    onlineUsers: live ? live.users : [],
    myLevel: acc.ok ? acc.level : 'none',
    ownerName: perm.getShare(d.id).members.find((m) => m.owner)?.name || d.owner,
  }
})

fastify.post<{
  Body: { name?: string; kind?: 'sheet' | 'doc'; owner?: string; teamId?: string }
}>('/api/docs', async (req, reply) => {
  const id = randomUUID().slice(0, 8)
  const name = (req.body?.name || '未命名文档').trim() || '未命名文档'
  const kind = req.body?.kind === 'doc' ? 'doc' : 'sheet'
  const now = Date.now()
  const me = meOf(req)
  if (!me) {
    reply.code(401)
    return { error: '未登录，无法创建文档' }
  }
  meta.set(id, {
    id,
    name,
    kind,
    createdAt: now,
    updatedAt: now,
    owner: me.name,
    ownerId: me.id,
    ...(req.body?.teamId ? { teamId: req.body.teamId } : {}),
  })
  // 创建者即所有者：归属锚定账号 userId，换设备/换浏览器仍是同一个人
  perm.initOwner(id, me)
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

fastify.delete<{ Params: { id: string } }>('/api/docs/:id', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) return { ok: false, error: 'not found' }
  // 只有所有者/可管理能删除
  const me = meOf(req)
  const acc = perm.resolveAccess(d.id, true, me?.id || '')
  if (!acc.ok || !perm.atLeast(acc.level, 'manage')) {
    reply.code(403)
    return { ok: false, error: '只有文档所有者或管理员可以删除' }
  }
  meta.delete(req.params.id)
  perm.dropDoc(req.params.id)
  saveDocs()
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

// ---- 分享与权限（持久化到 data/share.json，全部由 perm 模块裁决） ----

/** 权限校验辅助：不足 manage 直接 403 */
function needManage(
  req: { headers: Record<string, string | string[] | undefined> },
  docId: string,
  reply: any
): perm.Access | null {
  const me = meOf(req)
  const acc = perm.resolveAccess(docId, true, me?.id || '')
  if (!acc.ok || !perm.atLeast(acc.level, 'manage')) {
    reply.code(403)
    return null
  }
  return acc
}

/** 分享面板数据源。有任意权限的人都能看（只读者要看"申请编辑权限"入口），但只有 manage 能改 */
fastify.get<{ Params: { id: string } }>('/api/docs/:id/share', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) {
    reply.code(404)
    return { error: 'not found' }
  }
  const me = meOf(req)
  if (!me) {
    reply.code(401)
    return { error: '未登录' }
  }
  migrateLegacy(d.id, me)
  const acc = perm.resolveAccess(d.id, true, me.id)
  if (!acc.ok) {
    reply.code(403)
    return { error: '你没有权限查看这份文档的分享设置' }
  }
  const s = perm.getShare(d.id)
  const canManage = perm.atLeast(acc.level, 'manage')
  return {
    scope: s.scope,
    linkPerm: s.linkPerm,
    members: perm.publicMembers(d.id),
    myLevel: acc.level,
    canManage,
    ownerName: s.members.find((m) => m.owner)?.name || d.owner,
    // 分享链接：优先 PUBLIC_BASE 显式配置；否则按请求头自动推导（nginx 反代传 X-Forwarded-*，
    // 本地 dev 用 Host），这样本地 / WSL / 公网都能生成"前端可打开"的正确链接
    link: shareBaseOf(req) + '?doc=' + encodeURIComponent(d.id),
    requests: canManage
      ? perm.listRequests(d.id).map((r) => ({
          id: r.id,
          name: r.name,
          want: r.want,
          note: r.note,
          ts: r.ts,
        }))
      : [],
  }
})

/** 修改链接分享范围与链接权限（需 manage） */
fastify.patch<{
  Params: { id: string }
  Body: { scope?: Scope; linkPerm?: LinkPerm }
}>('/api/docs/:id/share', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) {
    reply.code(404)
    return { error: 'not found' }
  }
  if (!needManage(req, d.id, reply)) return { error: '只有所有者或管理员可以修改分享设置' }
  if (req.body?.scope) {
    // 关闭链接分享会清掉所有凭链接进来的人——这才是真正的"收回链接"
    const dropped = perm.setScope(d.id, req.body.scope)
    if (dropped.length) kickUsers(d.id, dropped)
  }
  if (req.body?.linkPerm) perm.setLinkPerm(d.id, req.body.linkPerm)
  refreshRoomPerms(d.id)
  const s = perm.getShare(d.id)
  return { ok: true, scope: s.scope, linkPerm: s.linkPerm }
})

/** 邀请协作者（需 manage）。按账号邀请，不能授予高于自己的权限——飞书的硬规则 */
fastify.post<{ Params: { id: string }; Body: { userId?: string; name?: string; perm?: Perm } }>(
  '/api/docs/:id/share/invite',
  async (req, reply) => {
    const d = meta.get(req.params.id)
    if (!d) {
      reply.code(404)
      return { error: 'not found' }
    }
    const acc = needManage(req, d.id, reply)
    if (!acc) return { error: '只有所有者或管理员可以邀请成员' }
    const want = req.body?.perm || 'view'
    if (acc.level !== 'owner' && perm.PERM_RANK_OF(want) >= perm.PERM_RANK_OF('manage')) {
      reply.code(403)
      return { error: '不能授予高于自己的权限' }
    }
    // 按账号邀请：传 userId 直接定位；dev 模式下也允许按名字即时建一个账号，方便本地演示
    let target = req.body?.userId ? auth.getUser(req.body.userId) : null
    if (!target && req.body?.name && auth.devLoginEnabled()) {
      target = auth.upsertUser({
        provider: 'dev',
        sub: (req.body.name || '').trim(),
        name: (req.body.name || '').trim(),
      })
    }
    if (!target) {
      reply.code(404)
      return { error: '找不到这个用户，请先让对方登录一次，或从搜索结果里选择' }
    }
    const m = perm.inviteMember(d.id, target, want)
    refreshRoomPerms(d.id)
    return { id: m.id, ok: true, userId: m.userId, name: m.name, perm: m.perm }
  }
)

/** 修改成员权限（需 manage） */
fastify.patch<{ Params: { id: string }; Body: { memberId?: string; perm?: Perm } }>(
  '/api/docs/:id/share/member',
  async (req, reply) => {
    const d = meta.get(req.params.id)
    if (!d) {
      reply.code(404)
      return { error: 'not found' }
    }
    const acc = needManage(req, d.id, reply)
    if (!acc) return { error: '只有所有者或管理员可以修改成员权限' }
    const want = req.body?.perm || 'view'
    if (acc.level !== 'owner' && perm.PERM_RANK_OF(want) >= perm.PERM_RANK_OF('manage')) {
      reply.code(403)
      return { error: '不能授予高于自己的权限' }
    }
    const ok = perm.setMemberPerm(d.id, req.body?.memberId || '', want)
    if (!ok) {
      reply.code(404)
      return { error: '成员不存在，或所有者的权限不可修改' }
    }
    refreshRoomPerms(d.id)
    return { ok: true, perm: want }
  }
)

/** 移除成员（需 manage）。注意：移除 ≠ 收回链接权限，返回值会提示前端 */
fastify.delete<{
  Params: { id: string }
  Body: { memberId?: string }
  Querystring: { memberId?: string }
}>('/api/docs/:id/share/member', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) {
    reply.code(404)
    return { error: 'not found' }
  }
  if (!needManage(req, d.id, reply)) return { error: '只有所有者或管理员可以移除成员' }
  const memberId = req.body?.memberId || req.query?.memberId || ''
  const target = perm.getShare(d.id).members.find((m) => m.id === memberId)
  const ok = perm.removeMember(d.id, memberId)
  if (ok && target) {
    kickUsers(d.id, [target.userId])
    refreshRoomPerms(d.id)
  }
  return {
    ok,
    // 飞书的关键防错：链接仍开着时，被移除的人还能凭链接进来
    linkStillOpen: perm.getShare(d.id).scope !== 'off',
  }
})

/**
 * 访客登记（凭分享链接进入时调用）。必须先登录——登记的同样是账号 userId，
 * 这样同一个人在任何设备上凭链接进来都是同一个人。
 * scope≠off → 登记为链接成员；scope=off → 建一条访问申请，返回等待。
 */
fastify.post<{ Params: { id: string }; Body: { name?: string; want?: LinkPerm; note?: string } }>(
  '/api/docs/:id/join',
  async (req, reply) => {
    const d = meta.get(req.params.id)
    if (!d) {
      reply.code(404)
      return { error: '文档不存在或已被删除' }
    }
    const me = meOf(req)
    if (!me) {
      reply.code(401)
      return { error: '请先登录后再申请访问' }
    }
    const r = perm.joinByLink(d.id, me, req.body?.want === 'edit' ? 'edit' : 'view', req.body?.note || '')
    refreshRoomPerms(d.id)
    return {
      status: r.status,
      perm: r.perm || null,
      docId: d.id,
      name: d.name,
      kind: d.kind,
      ownerName: perm.getShare(d.id).members.find((m) => m.owner)?.name || d.owner,
    }
  }
)

/** 审批访问申请（需 manage） */
fastify.post<{
  Params: { id: string; rid: string }
  Body: { approve?: boolean; perm?: Perm }
}>('/api/docs/:id/access/:rid', async (req, reply) => {
  const d = meta.get(req.params.id)
  if (!d) {
    reply.code(404)
    return { error: 'not found' }
  }
  if (!needManage(req, d.id, reply)) return { error: '只有所有者或管理员可以审批申请' }
  const r = perm.resolveRequest(
    d.id,
    req.params.rid,
    req.body?.approve !== false,
    req.body?.perm || 'view'
  )
  refreshRoomPerms(d.id)
  return { ok: r.ok }
})

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
  // 协同连接必须带登录身份：优先 Cookie（浏览器握手时自动带上），也兼容 ?t=<token> 便于调试。
  // 未登录或对该文档无权限的连接会被直接拒绝。
  const user =
    auth.userOfRequest(req) || auth.userOfToken((url.searchParams.get('t') || '').trim())
  const userId = user?.id || ''
  wss.handleUpgrade(req, socket, head, (ws) => {
    try {
      setupWSConnection(ws, docName, userId)
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
