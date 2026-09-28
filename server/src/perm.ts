/**
 * CoDoc 权限与共享模型（唯一权威来源）
 *
 * 设计依据（飞书云文档 + 本项目的精简取舍）：
 *  1. 权限三档 + 所有者：manage / edit / view，另有 owner 身份。
 *     不设「可评论」档——飞书也没有这个协作者档位，评论能力是"最低需要什么权限"的阈值，
 *     而不是一种角色。本项目 MVP 阶段评论能力跟随 edit。
 *  2. 两种授权渠道并存：显式协作者（members）与链接分享（scope + linkPerm）。
 *     同一个人同时命中两者时取较高权限（飞书规则：取两种授权方式的最大值）。
 *  3. 身份 = userId。归属一律锚定账号，不认设备、不认浏览器、不认访问入口。
 *     早期版本拿客户端随机 token 当身份，换浏览器或换 localhost/127.0.0.1 入口就变成陌生人，
 *     导致创建者本人被判成无权访问——这个坑已经填掉，不要再往回退。
 *     访客也必须登录后再凭链接登记，登记的同样是 userId。
 *  4. 「移除协作者 ≠ 收回链接权限」：两者独立。关闭链接分享（scope=off）会清除
 *     所有经由链接进入的成员，这才是真正的"收回"。
 *  5. 所有权限数据落盘 data/share.json，重启不丢。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const SHARE_FILE = 'share.json'

/** 协作者权限档位（三档，与飞书一致） */
export type Perm = 'manage' | 'edit' | 'view'
/** 链接分享可授予的权限（不给 manage，链接不应当产生管理员） */
export type LinkPerm = 'edit' | 'view'
/** 链接分享范围：off = 仅协作者（飞书的"未开启"） */
export type Scope = 'off' | 'org' | 'any'
/** 成员是怎么来的：owner 所有者 / invite 被邀请 / link 凭链接进入 / request 申请获批 */
export type MemberVia = 'owner' | 'invite' | 'link' | 'request'

export interface Member {
  id: string
  /** 归属锚点：账号 userId */
  userId: string
  /** 姓名快照：协作者列表直接渲染，不必回查用户表 */
  name: string
  perm: Perm
  owner: boolean
  via: MemberVia
  createdAt: number
  lastSeen?: number
}

export interface AccessRequest {
  id: string
  userId: string
  name: string
  want: LinkPerm
  note: string
  ts: number
  status: 'pending' | 'approved' | 'rejected'
}

export interface DocShare {
  scope: Scope
  linkPerm: LinkPerm
  members: Member[]
  requests: AccessRequest[]
}

/** 解析结果：level 决定能做什么；via 说明权限从哪来（用于 UI 提示） */
export type Access =
  | { ok: true; level: 'owner' | 'manage' | 'edit' | 'view'; via: MemberVia | 'link'; member: Member }
  | { ok: false; reason: 'notfound' | 'noperm'; level: 'none'; via: null }

const store = new Map<string, DocShare>()

function load(): void {
  try {
    const f = path.join(DATA_DIR, SHARE_FILE)
    if (!fs.existsSync(f)) return
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Record<string, DocShare>
    for (const [k, v] of Object.entries(raw)) {
      store.set(k, {
        scope: v.scope ?? 'off',
        linkPerm: v.linkPerm ?? 'view',
        // 历史数据里带 token 的成员没有 userId，直接丢弃——宁可让人重新凭链接登记，
        // 也不能让一个对不上账号的条目继续占着权限
        members: Array.isArray(v.members) ? v.members.filter((m) => !!m.userId) : [],
        requests: Array.isArray(v.requests) ? v.requests.filter((r) => !!r.userId) : [],
      })
    }
  } catch (e) {
    console.error('[perm] load failed', e)
  }
}

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(DATA_DIR, SHARE_FILE),
      JSON.stringify(Object.fromEntries(store), null, 2)
    )
  } catch (e) {
    console.error('[perm] persist failed', e)
  }
}

load()

const newId = () => crypto.randomUUID().slice(0, 8)

const PERM_RANK: Record<Perm, number> = { view: 1, edit: 2, manage: 3 }
const LEVEL_RANK: Record<'owner' | Perm, number> = { view: 1, edit: 2, manage: 3, owner: 4 }

/** 权限等级数值，供"不能授予高于自己的权限"这类比较使用 */
export function PERM_RANK_OF(p: Perm): number {
  return PERM_RANK[p] ?? 0
}

/** 取两者中较高的权限 */
export function maxPerm(a: Perm, b: Perm): Perm {
  return PERM_RANK[a] >= PERM_RANK[b] ? a : b
}

/** 是否至少达到某个权限（owner 视为最高） */
export function atLeast(level: 'owner' | Perm, need: Perm): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[need]
}

/** 取记录，不存在则建一条空的（scope=off，仅协作者可访问） */
export function getShare(docId: string): DocShare {
  let s = store.get(docId)
  if (!s) {
    s = { scope: 'off', linkPerm: 'view', members: [], requests: [] }
    store.set(docId, s)
  }
  return s
}

/** 文档创建时调用：把创建者登记为所有者（归属 = 账号 userId） */
export function initOwner(docId: string, user: { id: string; name: string }): Member {
  const s = getShare(docId)
  const exist = s.members.find((m) => m.owner)
  if (exist) {
    exist.name = user.name || exist.name
    exist.userId = user.id
    persist()
    return exist
  }
  const m: Member = {
    id: 'owner',
    userId: user.id,
    name: user.name || '我',
    perm: 'manage',
    owner: true,
    via: 'owner',
    createdAt: Date.now(),
  }
  s.members.unshift(m)
  persist()
  return m
}

/**
 * 兼容历史数据的认领入口：文档有内容、但没有任何权限记录时，
 * 第一个登录访问的人认领为所有者。仅在本地单机部署的迁移路径上触发一次。
 */
export function claimLegacyOwner(docId: string, user: { id: string; name: string }): Member {
  const s = getShare(docId)
  const m: Member = {
    id: 'owner',
    userId: user.id,
    name: user.name || '我',
    perm: 'manage',
    owner: true,
    via: 'owner',
    createdAt: Date.now(),
  }
  s.members = [m]
  s.scope = 'off'
  s.linkPerm = 'view'
  persist()
  return m
}

export function hasShareRecord(docId: string): boolean {
  return store.has(docId)
}

/** 该文档是否已经有权限记录（含所有者） */
export function hasOwner(docId: string): boolean {
  return getShare(docId).members.some((m) => m.owner)
}

/** 解析某账号在某文档上的权限 */
export function resolveAccess(docId: string, docExists: boolean, userId: string): Access {
  if (!docExists) return { ok: false, reason: 'notfound', level: 'none', via: null }
  const s = getShare(docId)
  if (!userId) return { ok: false, reason: 'noperm', level: 'none', via: null }

  // 1) 显式协作者（含所有者）
  const m = s.members.find((x) => x.userId === userId)
  if (m) {
    m.lastSeen = Date.now()
    return { ok: true, level: m.owner ? 'owner' : m.perm, via: m.via, member: m }
  }

  // 2) 链接分享：仅协作者模式下无效
  if (s.scope !== 'off') {
    // 链接授予的权限不与 manage 相乘：链接最多给 edit
    return {
      ok: true,
      level: s.linkPerm === 'edit' ? 'edit' : 'view',
      via: 'link',
      member: {
        id: 'link',
        userId,
        name: '链接访客',
        perm: s.linkPerm === 'edit' ? 'edit' : 'view',
        owner: false,
        via: 'link',
        createdAt: Date.now(),
      },
    }
  }

  return { ok: false, reason: 'noperm', level: 'none', via: null }
}

/**
 * 访客凭链接登记：调用前必须已登录。
 * - scope=off：不给权限，自动建一条访问申请，返回 need-approval
 * - scope≠off：登记为 link 成员，返回 granted
 */
export function joinByLink(
  docId: string,
  user: { id: string; name: string },
  want: LinkPerm,
  note = ''
): { status: 'granted' | 'need-approval'; perm?: Perm } {
  const s = getShare(docId)
  const clean = (user?.name || '').trim() || '访客'

  if (s.scope === 'off') {
    const exist = s.requests.find((r) => r.userId === user.id && r.status === 'pending')
    if (!exist) {
      const req: AccessRequest = {
        id: newId(),
        userId: user.id,
        name: clean,
        want,
        note: (note || '').trim(),
        ts: Date.now(),
        status: 'pending',
      }
      s.requests.push(req)
      persist()
    }
    return { status: 'need-approval' }
  }

  const perm: Perm = s.linkPerm
  // 同一个人重复进入：复用条目，避免名单里堆一堆重复访客
  const same = s.members.find((x) => !x.owner && x.userId === user.id && x.via === 'link')
  if (same) {
    same.perm = perm
    same.name = clean
    same.lastSeen = Date.now()
  } else {
    s.members.push({
      id: newId(),
      userId: user.id,
      name: clean,
      perm,
      owner: false,
      via: 'link',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    })
  }
  persist()
  return { status: 'granted', perm }
}

/** 邀请/添加协作者：按账号邀请 */
export function inviteMember(docId: string, user: { id: string; name: string }, perm: Perm): Member {
  const s = getShare(docId)
  const clean = (user?.name || '').trim() || '新成员'
  const exist = s.members.find((x) => !x.owner && x.userId === user.id)
  if (exist) {
    exist.perm = perm
    exist.name = clean
    exist.via = exist.via === 'link' ? 'invite' : exist.via
    persist()
    return exist
  }
  const m: Member = {
    id: newId(),
    userId: user.id,
    name: clean,
    perm,
    owner: false,
    via: 'invite',
    createdAt: Date.now(),
  }
  s.members.push(m)
  persist()
  return m
}

export function setMemberPerm(docId: string, memberId: string, perm: Perm): boolean {
  const s = getShare(docId)
  const m = s.members.find((x) => x.id === memberId)
  if (!m || m.owner) return false
  m.perm = perm
  persist()
  return true
}

export function removeMember(docId: string, memberId: string): string | null {
  const s = getShare(docId)
  const m = s.members.find((x) => x.id === memberId)
  if (!m || m.owner) return null
  s.members = s.members.filter((x) => x.id !== memberId)
  persist()
  return m.userId
}

/**
 * 修改链接范围。切到 off 时清除所有经由链接进入的成员——
 * 这是"收回链接"真正生效的地方（飞书：移除协作者 ≠ 收回链接权限，必须单独收窄链接）。
 * 返回被清除的 userId 列表，供调用方断开这些连接。
 */
export function setScope(docId: string, scope: Scope): string[] {
  const s = getShare(docId)
  s.scope = scope
  const dropped: string[] = []
  if (scope === 'off') {
    s.members = s.members.filter((m) => {
      if (m.via === 'link') {
        dropped.push(m.userId)
        return false
      }
      return true
    })
  }
  persist()
  return dropped
}

export function setLinkPerm(docId: string, linkPerm: LinkPerm): void {
  const s = getShare(docId)
  s.linkPerm = linkPerm
  // 链接权限变了，已凭链接进入的人要跟着变
  s.members.forEach((m) => {
    if (m.via === 'link') m.perm = linkPerm
  })
  persist()
}

/** 提交访问申请（无权限时） */
export function addRequest(
  docId: string,
  user: { id: string; name: string },
  want: LinkPerm,
  note: string
): AccessRequest {
  const s = getShare(docId)
  const exist = s.requests.find((r) => r.userId === user.id && r.status === 'pending')
  if (exist) {
    exist.want = want
    exist.note = (note || '').trim()
    exist.name = (user.name || '').trim() || exist.name
    persist()
    return exist
  }
  const req: AccessRequest = {
    id: newId(),
    userId: user.id,
    name: (user?.name || '').trim() || '访客',
    want,
    note: (note || '').trim(),
    ts: Date.now(),
    status: 'pending',
  }
  s.requests.push(req)
  persist()
  return req
}

export function listRequests(docId: string): AccessRequest[] {
  return getShare(docId).requests.filter((r) => r.status === 'pending')
}

/** 批准/拒绝申请。批准时把申请人登记为正式协作者，对方刷新即可直接进 */
export function resolveRequest(
  docId: string,
  requestId: string,
  approve: boolean,
  perm: Perm = 'view'
): { ok: boolean; userId?: string } {
  const s = getShare(docId)
  const r = s.requests.find((x) => x.id === requestId)
  if (!r || r.status !== 'pending') return { ok: false }
  r.status = approve ? 'approved' : 'rejected'
  if (approve) {
    const exist = s.members.find((x) => !x.owner && x.userId === r.userId)
    if (exist) {
      exist.perm = perm
      exist.via = 'request'
    } else {
      s.members.push({
        id: newId(),
        userId: r.userId,
        name: r.name,
        perm,
        owner: false,
        via: 'request',
        createdAt: Date.now(),
      })
    }
  }
  persist()
  return { ok: true, userId: r.userId }
}

/** 某人是否有待处理的申请（前端据此显示"已提交，等待批准"） */
export function pendingRequestOf(docId: string, userId: string): AccessRequest | null {
  if (!userId) return null
  return (
    getShare(docId).requests.find((r) => r.userId === userId && r.status === 'pending') || null
  )
}

/** 已拒绝状态（用于前端区分"待批准"和"被拒绝"） */
export function rejectedRequestOf(docId: string, userId: string): AccessRequest | null {
  if (!userId) return null
  return (
    getShare(docId).requests.find((r) => r.userId === userId && r.status === 'rejected') || null
  )
}

/** 给前端的列表：只暴露展示需要的字段 */
export function publicMembers(docId: string) {
  return getShare(docId).members.map((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.name,
    perm: m.owner ? ('owner' as const) : m.perm,
    via: m.via,
    owner: m.owner,
  }))
}

/** 供在线服务刷新权限用：某账号当前应有的 level */
export function levelOfUser(docId: string, docExists: boolean, userId: string) {
  return resolveAccess(docId, docExists, userId)
}

export function dropDoc(docId: string): void {
  store.delete(docId)
  persist()
}
