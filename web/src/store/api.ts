/**
 * CoDoc 前端 API 封装：登录会话 / 文档 CRUD / 分享权限 / 历史版本
 * 全部走相对路径，经 vite 代理到后端。
 *
 * 身份不再由前端拼装：登录态放在后端下发的 HttpOnly Cookie 里，
 * 同源请求与 WebSocket 握手都会自动带上，前端不需要也不能伪造身份。
 */


/** 权限档位：三档 + 所有者 + 无权限（与后端 perm.ts 对齐） */
export type PermLevel = 'owner' | 'manage' | 'edit' | 'view' | 'none'
export type Perm3 = 'manage' | 'edit' | 'view'
export type LinkPerm = 'edit' | 'view'
/** off = 仅协作者可访问（对应飞书的"未开启链接分享"） */
export type ShareScope = 'off' | 'org' | 'any'

export interface DocMeta {
  id: string
  name: string
  kind: 'sheet' | 'doc'
  createdAt: number
  updatedAt: number
  owner: string
  /** 归属团队 id；为空表示个人空间 */
  teamId?: string
  /** 成员数量（含 owner） */
  members?: number
  /** 当前在线人数（awareness 去重用户数，含自己） */
  online?: number
  /** 当前在线用户名 */
  onlineUsers?: string[]
  /** 当前身份在这份文档上的权限 */
  myLevel?: PermLevel
  ownerName?: string
}

export interface TeamMember {
  id: string
  name: string
  role: 'admin' | 'member'
}

export interface Team {
  id: string
  name: string
  desc: string
  createdAt: number
  members: TeamMember[]
  /** 该团队文件数（后端统计） */
  fileCount?: number
  /** 成员数（含管理员） */
  memberCount?: number
}

export interface ShareMember {
  id: string
  name: string
  /** owner 是身份而非档位，单独列出便于 UI 展示"所有者"角标 */
  perm: PermLevel
  via: 'owner' | 'invite' | 'link' | 'request'
  owner: boolean
}

export interface AccessRequestItem {
  id: string
  name: string
  want: LinkPerm
  note: string
  ts: number
}

export interface ShareInfo {
  scope: ShareScope
  linkPerm: LinkPerm
  members: ShareMember[]
  myLevel: PermLevel
  canManage: boolean
  ownerName: string
  link: string
  requests: AccessRequestItem[]
}

/** 我在这份文档上的访问状态（分享链接直达 / 权限轮询都用它） */
export interface MyAccess {
  docId: string
  name: string
  kind: 'sheet' | 'doc'
  level: PermLevel
  via?: 'owner' | 'invite' | 'link' | 'request' | null
  /** granted 已授权 / pending 已申请待批准 / rejected 被拒绝 / none 未申请 */
  status: 'granted' | 'pending' | 'rejected' | 'none'
  ownerName: string
  canRequest: boolean
  /** 链接分享是否对外开放（false = 仅协作者，访客登记后需申请） */
  linkOpen?: boolean
  pendingRequests?: AccessRequestItem[]
}

export interface JoinResult {
  status: 'granted' | 'need-approval'
  perm: Perm3 | null
  docId: string
  name: string
  kind: 'sheet' | 'doc'
  ownerName: string
}

/** 登录用户（后端下发的账号信息） */
export interface AccountUser {
  id: string
  name: string
  email?: string
  avatar?: string
  provider?: string
}

/** 登录方式配置：前端据此渲染"企业账号登录"还是"本地一键登录" */
export interface AuthConfig {
  mode: 'dev' | 'oidc'
  devLogin: boolean
  providerLabel: string
  appOrigin: string
}

export interface DocVersion {
  id: string
  ts: number
  auto: boolean
  label?: string
  peers: number
  author?: string
}

export interface VersionPreview {
  kind: 'doc' | 'sheet' | 'empty'
  lines: string[]
  sheetName?: string
}

/**
 * 请求头：只放 content-type。
 * 身份由浏览器自动携带的会话 Cookie 提供，前端不再拼任何身份头——
 * 这既避免了"换入口就换人"，也杜绝了前端伪造身份的可能。
 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...(extra || {}) }
}

/**
 * 关于凭据：所有 /api 与 /collab 请求都是同源（经 vite 代理到后端），
 * fetch 与 WebSocket 默认就会带上会话 Cookie，因此这里不需要显式 credentials。
 * 将来若前后端分离跨域部署，需要在两端同时打开 credentials / CORS 才行。
 */

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = res.statusText
    try {
      const d = await res.json()
      if (d?.error) msg = d.error
    } catch {
      /* ignore */
    }
    throw new Error(msg || '请求失败')
  }
  return res.json() as Promise<T>
}

export interface LiveRoom {
  conns: number
  users: string[]
  editing: string[]
}

export const api = {
  // ---- 登录会话 ----
  authConfig: () => fetch('/api/auth/config').then((r) => j<AuthConfig>(r)),
  me: () => fetch('/api/auth/me').then((r) => j<{ user: AccountUser }>(r)),
  devLogin: (name: string) =>
    fetch('/api/auth/dev-login', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name }),
    }).then((r) => j<{ ok: boolean; user: AccountUser }>(r)),
  logout: () =>
    fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() }).then((r) =>
      j<{ ok: boolean }>(r)
    ),
  searchUsers: (q: string) =>
    fetch('/api/users?q=' + encodeURIComponent(q), { headers: authHeaders() }).then((r) =>
      j<{ users: AccountUser[] }>(r)
    ),

  listDocs: (team?: string) =>
    fetch('/api/docs' + (team ? '?team=' + encodeURIComponent(team) : ''), {
      headers: authHeaders(),
    }).then((r) => j<{ docs: DocMeta[] }>(r)),
  /** 按 id 取单个文档（分享链接直达用），不存在时后端返回 404 */
  getDoc: (id: string) => fetch('/api/docs/' + id, { headers: authHeaders() }).then((r) => j<DocMeta>(r)),
  /** 实时在线情况：{ rooms: { [docId]: LiveRoom } } */
  getLive: () => fetch('/api/live').then((r) => j<{ rooms: Record<string, LiveRoom> }>(r)),
  createDoc: (name: string, kind: 'sheet' | 'doc', owner?: string, teamId?: string) =>
    fetch('/api/docs', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name, kind, owner, ...(teamId ? { teamId } : {}) }),
    }).then((r) => j<{ id: string; name: string; kind: 'sheet' | 'doc' }>(r)),
  renameDoc: (id: string, name: string) =>
    fetch('/api/docs/' + id, {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name }),
    }).then((r) => j<{ id: string; name: string }>(r)),
  deleteDoc: (id: string) =>
    fetch('/api/docs/' + id, { method: 'DELETE', headers: authHeaders() }).then((r) =>
      j<{ ok: boolean }>(r)
    ),

  /** 我在这份文档上的权限（无权限时返回 level=none + 状态，用于申请页） */
  getMyAccess: (id: string) =>
    fetch('/api/docs/' + id + '/me', { headers: authHeaders() }).then((r) => j<MyAccess>(r)),
  /**
   * 凭链接登记：已登录才能调。
   * 链接开放就直接进；仅协作者模式会自动建一条访问申请，转交所有者审批。
   */
  joinDoc: (id: string, want: LinkPerm, note?: string) =>
    fetch('/api/docs/' + id + '/join', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ want, note: note || '' }),
    }).then((r) => j<JoinResult>(r)),
  /** 审批访问申请（需 manage 权限） */
  resolveRequest: (id: string, rid: string, approve: boolean, perm: Perm3 = 'view') =>
    fetch('/api/docs/' + id + '/access/' + rid, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ approve, perm }),
    }).then((r) => j<{ ok: boolean }>(r)),

  getShare: (id: string) =>
    fetch('/api/docs/' + id + '/share', { headers: authHeaders() }).then((r) => j<ShareInfo>(r)),
  updateShare: (id: string, patch: { scope?: ShareScope; linkPerm?: LinkPerm }) =>
    fetch('/api/docs/' + id + '/share', {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(patch),
    }).then((r) => j<{ ok: boolean; scope: ShareScope; linkPerm: LinkPerm }>(r)),
  invite: (id: string, name: string, perm: Perm3) =>
    fetch('/api/docs/' + id + '/share/invite', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name, perm }),
    }).then((r) => j<{ id: string; ok: boolean; name: string; perm: Perm3 }>(r)),
  setMemberPerm: (id: string, memberId: string, perm: Perm3) =>
    fetch('/api/docs/' + id + '/share/member', {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ memberId, perm }),
    }).then((r) => j<{ ok: boolean; perm: Perm3 }>(r)),
  removeMember: (id: string, memberId: string) =>
    fetch(
      '/api/docs/' + id + '/share/member?memberId=' + encodeURIComponent(memberId),
      { method: 'DELETE', headers: authHeaders() }
    ).then((r) => j<{ ok: boolean; linkStillOpen: boolean }>(r)),

  getVersions: (id: string) =>
    fetch('/api/docs/' + id + '/versions', { headers: authHeaders() }).then((r) =>
      j<{ versions: DocVersion[] }>(r)
    ),
  previewVersion: (id: string, vid: string) =>
    fetch('/api/docs/' + id + '/versions/' + vid + '/preview', { headers: authHeaders() }).then((r) =>
      j<VersionPreview>(r)
    ),
  saveVersion: (id: string, label?: string, author?: string) =>
    fetch('/api/docs/' + id + '/versions', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ ...(label ? { label } : {}), ...(author ? { author } : {}) }),
    }).then((r) => j<{ version: DocVersion | null; ok: boolean }>(r)),
  renameVersion: (id: string, vid: string, label: string) =>
    fetch('/api/docs/' + id + '/versions/' + vid, {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ label }),
    }).then((r) => j<{ ok: boolean }>(r)),
  restoreVersion: (id: string, vid: string) =>
    fetch('/api/docs/' + id + '/versions/' + vid + '/restore', {
      method: 'POST',
      headers: authHeaders(),
    }).then((r) => j<{ ok: boolean }>(r)),

  // ---- 团队管理 ----
  listTeams: () => fetch('/api/teams', { headers: authHeaders() }).then((r) => j<{ teams: Team[] }>(r)),
  createTeam: (name: string, desc: string, owner?: string) =>
    fetch('/api/teams', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name, desc, ...(owner ? { owner } : {}) }),
    }).then((r) => j<{ id: string; name: string; desc: string }>(r)),
  updateTeam: (id: string, patch: { name?: string; desc?: string }) =>
    fetch('/api/teams/' + id, {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(patch),
    }).then((r) => j<{ ok: boolean }>(r)),
  deleteTeam: (id: string) =>
    fetch('/api/teams/' + id, { method: 'DELETE', headers: authHeaders() }).then((r) =>
      j<{ ok: boolean }>(r)
    ),
  addTeamMember: (id: string, name: string, role: 'admin' | 'member') =>
    fetch('/api/teams/' + id + '/members', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name, role }),
    }).then((r) => j<{ id: string; ok: boolean; existed?: boolean }>(r)),
  updateTeamMember: (id: string, mid: string, role: 'admin' | 'member') =>
    fetch('/api/teams/' + id + '/members/' + mid, {
      method: 'PATCH',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ role }),
    }).then((r) => j<{ ok: boolean }>(r)),
  removeTeamMember: (id: string, mid: string) =>
    fetch('/api/teams/' + id + '/members/' + mid, {
      method: 'DELETE',
      headers: authHeaders(),
    }).then((r) => j<{ ok: boolean }>(r)),

  /**
   * 表格智能助手（接入 Hermes OpenAI 兼容 API）。
   * 后端在 /api/ai/chat 反向代理到 Hermes 的 API Server（OpenAI 兼容，/v1/chat/completions）。
   * 入参：{ docId, context, messages, attachments }，出参 { steps }。
   */
  aiChat: (payload: {
    docId?: string
    context?: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    attachments?: { name: string; mime?: string; data: string }[]
  }) =>
    fetch('/api/ai/chat', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
    }).then((r) =>
      j<{ steps: { title: string; body?: string; terminal?: string }[]; ok?: boolean }>(r)
    ),

  /** 流式对话：发起请求并让 onEvent 消费 NDJSON 事件。返回带 abort 的控制器。 */
  aiChatStream: (
    payload: {
      docId?: string
      context?: string
      session?: string
      messages: { role: 'user' | 'assistant'; content: string }[]
      attachments?: { name: string; mime?: string; data: string }[]
    },
    handlers: {
      onEvent: (row: AiStreamEvent) => void
      onClose?: () => void
      onError?: (msg: string) => void
    }
  ) => {
    const ac = new AbortController()
    fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          handlers.onError?.(`流式接口不可用（${res.status}）`)
          return
        }
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let i: number
            while ((i = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, i).trim()
              buf = buf.slice(i + 1)
              if (!line) continue
              try {
                handlers.onEvent(JSON.parse(line) as AiStreamEvent)
              } catch {
                /* 跳过非 JSON 行 */
              }
            }
          }
        } finally {
          handlers.onClose?.()
        }
      })
      .catch((e) => {
        if (e?.name !== 'AbortError') handlers.onError?.(e?.message || '请求失败')
      })
    return ac
  },
  /** 处理一条授权（允许一次 / 会话 / 始终 / 拒绝） */
  aiApprove: (runId: string, choice: string) =>
    fetch('/api/ai/approve', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ runId, choice }),
    }).then((r) => j<{ ok: boolean }>(r)),
  /** 中断正在运行的智能体 */
  aiStop: (runId: string) =>
    fetch('/api/ai/stop', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ runId }),
    }).then((r) => j<{ ok: boolean }>(r)),
}

/** 流式事件（后端 /api/ai/chat/stream 逐行回传） */
export type AiStreamEvent =
  | { type: 'turn.start'; runId?: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool.start'; id: string; name: string; preview?: string }
  | { type: 'tool.done'; id: string; name: string; ok: boolean; duration?: number }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.done'; text?: string }
  | { type: 'todo'; items: { text: string; state?: string }[] }
  | { type: 'clarify'; question: string; options?: string[] }
  | { type: 'info'; text: string }
  | { type: 'approval'; id: string; command: string; choices?: string[] }
  | { type: 'approval.resolved'; id?: string; choice?: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
