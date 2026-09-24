/**
 * CoDoc 前端 API 封装：文档 CRUD / 分享成员 / 历史版本
 * 全部走相对路径，经 vite 代理到后端。
 */

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
  /** 当前在线人数（含自己，来自后端的协同房间连接数） */
  online?: number
  /** 当前在线用户名 */
  onlineUsers?: string[]
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
  /** 成员数（后端统计，含管理员） */
  memberCount?: number
}

export interface ShareMember {
  id: string
  name: string
  perm: 'edit' | 'comment' | 'view'
}

export interface ShareInfo {
  scope: 'specified' | 'org' | 'any'
  defaultPerm: 'edit' | 'comment' | 'view'
  members: ShareMember[]
  link: string
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
  listDocs: (team?: string) =>
    fetch('/api/docs' + (team ? '?team=' + encodeURIComponent(team) : '')).then((r) =>
      j<{ docs: DocMeta[] }>(r)
    ),
  /** 按 id 取单个文档（分享链接直达用），不存在时后端返回 404 */
  getDoc: (id: string) => fetch('/api/docs/' + id).then((r) => j<DocMeta>(r)),
  /** 实时在线情况：{ rooms: { [docId]: LiveRoom } } */
  getLive: () => fetch('/api/live').then((r) => j<{ rooms: Record<string, LiveRoom> }>(r)),
  createDoc: (name: string, kind: 'sheet' | 'doc', owner?: string, teamId?: string) =>
    fetch('/api/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, kind, owner, ...(teamId ? { teamId } : {}) }),
    }).then((r) => j<{ id: string; name: string; kind: 'sheet' | 'doc' }>(r)),
  renameDoc: (id: string, name: string) =>
    fetch('/api/docs/' + id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => j<{ id: string; name: string }>(r)),
  deleteDoc: (id: string) =>
    fetch('/api/docs/' + id, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),

  getShare: (id: string) =>
    fetch('/api/docs/' + id + '/share').then((r) => j<ShareInfo>(r)),
  updateShare: (
    id: string,
    patch: { scope?: ShareInfo['scope']; defaultPerm?: ShareInfo['defaultPerm'] }
  ) =>
    fetch('/api/docs/' + id + '/share', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => j<{ ok: boolean; scope: ShareInfo['scope']; defaultPerm: ShareInfo['defaultPerm'] }>(r)),
  invite: (id: string, name: string, perm: ShareMember['perm']) =>
    fetch('/api/docs/' + id + '/share/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, perm }),
    }).then((r) => j<{ id: string; ok: boolean }>(r)),
  setMemberPerm: (id: string, memberId: string, perm: ShareMember['perm']) =>
    fetch('/api/docs/' + id + '/share/member', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, perm }),
    }).then((r) => j<{ ok: boolean }>(r)),
  removeMember: (id: string, memberId: string) =>
    fetch('/api/docs/' + id + '/share/member?memberId=' + encodeURIComponent(memberId), {
      method: 'DELETE',
    }).then((r) => j<{ ok: boolean }>(r)),

  getVersions: (id: string) =>
    fetch('/api/docs/' + id + '/versions').then((r) => j<{ versions: DocVersion[] }>(r)),
  previewVersion: (id: string, vid: string) =>
    fetch('/api/docs/' + id + '/versions/' + vid + '/preview').then((r) => j<VersionPreview>(r)),
  saveVersion: (id: string, label?: string, author?: string) =>
    fetch('/api/docs/' + id + '/versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(label ? { label } : {}), ...(author ? { author } : {}) }),
    }).then((r) => j<{ version: DocVersion | null; ok: boolean }>(r)),
  renameVersion: (id: string, vid: string, label: string) =>
    fetch('/api/docs/' + id + '/versions/' + vid, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    }).then((r) => j<{ ok: boolean }>(r)),
  restoreVersion: (id: string, vid: string) =>
    fetch('/api/docs/' + id + '/versions/' + vid + '/restore', {
      method: 'POST',
    }).then((r) => j<{ ok: boolean }>(r)),

  // ---- 团队管理 ----
  listTeams: () => fetch('/api/teams').then((r) => j<{ teams: Team[] }>(r)),  createTeam: (name: string, desc: string, owner?: string) =>
    fetch('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, desc, ...(owner ? { owner } : {}) }),
    }).then((r) => j<{ id: string; name: string; desc: string }>(r)),
  updateTeam: (id: string, patch: { name?: string; desc?: string }) =>
    fetch('/api/teams/' + id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => j<{ ok: boolean }>(r)),
  deleteTeam: (id: string) =>
    fetch('/api/teams/' + id, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),
  addTeamMember: (id: string, name: string, role: 'admin' | 'member') =>
    fetch('/api/teams/' + id + '/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, role }),
    }).then((r) => j<{ id: string; ok: boolean; existed?: boolean }>(r)),
  updateTeamMember: (id: string, mid: string, role: 'admin' | 'member') =>
    fetch('/api/teams/' + id + '/members/' + mid, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    }).then((r) => j<{ ok: boolean }>(r)),
  removeTeamMember: (id: string, mid: string) =>
    fetch('/api/teams/' + id + '/members/' + mid, { method: 'DELETE' }).then((r) =>
      j<{ ok: boolean }>(r)
    ),

  /**
   * 表格智能助手（接入 Hermes OpenAI 兼容 API）。
   * 后端在 /api/ai/chat 反向代理到 Hermes 的 API Server（OpenAI 兼容，/v1/chat/completions）。
   * 入参：{ docId, context, messages, attachments }，出参 { steps }。
   *  - context：选区说明文本（含引用的真实单元格数据），可选
   *  - attachments：本轮附件的多模态图片（[{ name, mime, data }]，data 为 data:image/... 地址）
   */
  aiChat: (payload: {
    docId?: string
    context?: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    attachments?: { name: string; mime?: string; data: string }[]
  }) =>
    fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => j<{ steps: { title: string; body?: string; terminal?: string }[]; ok?: boolean }>(r)),
}