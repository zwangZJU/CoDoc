/**
 * CoDoc 账号体系与会话（SSO 就绪）
 *
 * 为什么要有这一层：
 *  早期版本「token 即身份」——客户端自己生成一个随机串存在 localStorage，后端拿它当人。
 *  结果是换浏览器、换访问入口（localhost / 127.0.0.1 / 局域网 IP）就会生成新 token，
 *  同一个人变成陌生人，自己创建的文档反而提示「你已无法访问」。
 *
 * 现在的设计：
 *  1. 身份锚点 = userId。权限归属、协作者名单、申请记录统统绑 userId，
 *     换设备换浏览器只要登录了就是同一个人。
 *  2. 会话凭证 = HttpOnly Cookie（codoc_session）。前端不需要保管任何凭证，
 *     WebSocket 握手也会自动带上，跨端口（5173 前端 / 1234 后端）同样生效。
 *  3. 登录方式可插拔：dev 一键登录（本地开发）+ 标准 OIDC 授权码流程。
 *     换 IdP（Casdoor / Authing / 飞书 / Okta / Keycloak）只改环境变量，业务代码不动。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')

// ---- 极简 JSON 持久化（与 index.ts 同源约定：内存为主，落盘防重启丢失）----
function loadJson<T>(file: string, fallback: T): T {
  try {
    const f = path.join(DATA_DIR, file)
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8')) as T
  } catch {
    /* 文件损坏就当空数据，不能让登录功能整体挂掉 */
  }
  return fallback
}
function saveJson(file: string, data: unknown): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2))
  } catch (e) {
    console.error('[auth] persist failed', file, e)
  }
}

export interface User {
  /** 内部主键：权限归属锚点 */
  id: string
  name: string
  email?: string
  avatar?: string
  /** 身份来源：dev / casdoor / feishu / authing ... */
  provider: string
  /** IdP 侧的唯一标识（sub），与 provider 联合定位一个账号 */
  sub: string
  createdAt: number
  lastSeen: number
}

interface Session {
  token: string
  userId: string
  createdAt: number
  expiresAt: number
}

const users = new Map<string, User>(
  Object.entries(loadJson<Record<string, User>>('users.json', {}))
)
const sessions = new Map<string, Session>(
  Object.entries(loadJson<Record<string, Session>>('sessions.json', {}))
)

const saveUsers = () => saveJson('users.json', Object.fromEntries(users))
const saveSessions = () => saveJson('sessions.json', Object.fromEntries(sessions))

const TTL_MS = Number(process.env.SESSION_TTL_DAYS || 14) * 86400_000
const COOKIE = 'codoc_session'

const newId = () => crypto.randomUUID().slice(0, 8)
const newToken = () => crypto.randomBytes(32).toString('base64url')

/** 账号唯一性由 provider + sub 决定；已存在则刷新资料与活跃时间 */
export function upsertUser(p: {
  provider: string
  sub: string
  name: string
  email?: string
  avatar?: string
}): User {
  const sub = String(p.sub || '').trim()
  const exist = [...users.values()].find(
    (u) => u.provider === p.provider && u.sub === sub
  )
  if (exist) {
    exist.name = p.name || exist.name
    if (p.email) exist.email = p.email
    if (p.avatar) exist.avatar = p.avatar
    exist.lastSeen = Date.now()
    saveUsers()
    return exist
  }
  const u: User = {
    id: newId(),
    name: (p.name || '').trim() || '未命名用户',
    ...(p.email ? { email: p.email } : {}),
    ...(p.avatar ? { avatar: p.avatar } : {}),
    provider: p.provider,
    sub,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  }
  users.set(u.id, u)
  saveUsers()
  return u
}

export function getUser(id: string): User | null {
  return users.get(id) || null
}

export function listUsers(): User[] {
  return [...users.values()]
}

/** 按名字搜索（邀请协作者时用），排除自己 */
export function searchUsers(kw: string, excludeId?: string): User[] {
  const k = (kw || '').trim().toLowerCase()
  return listUsers()
    .filter((u) => u.id !== excludeId)
    .filter((u) => !k || u.name.toLowerCase().includes(k) || (u.email || '').toLowerCase().includes(k))
    .slice(0, 20)
}

export function createSession(userId: string): { token: string; expiresAt: number } {
  const token = newToken()
  const expiresAt = Date.now() + TTL_MS
  sessions.set(token, { token, userId, createdAt: Date.now(), expiresAt })
  saveSessions()
  return { token, expiresAt }
}

export function userOfToken(token: string): User | null {
  if (!token) return null
  const s = sessions.get(token)
  if (!s) return null
  if (s.expiresAt < Date.now()) {
    sessions.delete(token)
    saveSessions()
    return null
  }
  const u = users.get(s.userId)
  if (!u) return null
  u.lastSeen = Date.now()
  return u
}

export function destroySession(token: string): void {
  if (!token) return
  if (sessions.delete(token)) saveSessions()
}

/** 从请求里取会话凭证：优先 HttpOnly Cookie，其次 Authorization: Bearer（便于 curl 与调试） */
export function tokenOfRequest(req: {
  headers: Record<string, string | string[] | undefined>
}): string {
  const rawCookie = req.headers?.cookie
  const cookie = Array.isArray(rawCookie) ? rawCookie.join('; ') : rawCookie || ''
  const fromCookie = cookie
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE + '='))
  if (fromCookie) return decodeURIComponent(fromCookie.slice(COOKIE.length + 1))
  const auth = req.headers?.authorization
  const bearer = (Array.isArray(auth) ? auth[0] : auth) || ''
  if (bearer.startsWith('Bearer ')) return bearer.slice(7).trim()
  return ''
}

export function userOfRequest(req: {
  headers: Record<string, string | string[] | undefined>
}): User | null {
  return userOfToken(tokenOfRequest(req))
}

export const SESSION_COOKIE = COOKIE

export function sessionCookieHeader(token: string, expiresAt: number): string {
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))
  // SameSite=Lax：跨端口（5173 -> 1234）与 WebSocket 握手都会带上；HttpOnly 防 XSS 窃取
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
}

export function clearCookieHeader(): string {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
}

// ---------------------------------------------------------------------------
// OIDC：标准授权码流程（PKCE + state），零第三方依赖，IdP 由环境变量决定
// ---------------------------------------------------------------------------

export type AuthMode = 'dev' | 'oidc'

export function authMode(): AuthMode {
  return process.env.OIDC_ISSUER ? 'oidc' : 'dev'
}

/** dev 一键登录是否开放：未配置 OIDC 时默认开，配了 OIDC 就自动关闭（除非显式打开） */
export function devLoginEnabled(): boolean {
  const v = process.env.ALLOW_DEV_LOGIN
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return !process.env.OIDC_ISSUER
}

interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: string
  label: string
}

function oidcConfig(): OidcConfig | null {
  const issuer = (process.env.OIDC_ISSUER || '').trim().replace(/\/+$/, '')
  const clientId = (process.env.OIDC_CLIENT_ID || '').trim()
  if (!issuer || !clientId) return null
  return {
    issuer,
    clientId,
    clientSecret: (process.env.OIDC_CLIENT_SECRET || '').trim(),
    // 回调打到后端：这是浏览器会真实访问的地址，必须与 IdP 后台配置一致
    redirectUri: (process.env.OIDC_REDIRECT_URI || '').trim() || 'http://localhost:1234/api/auth/callback',
    scopes: (process.env.OIDC_SCOPES || 'openid profile email').trim(),
    label: (process.env.OIDC_LABEL || '企业账号').trim(),
  }
}

/** 登录完成后回前端的地址（默认本地 dev 前端） */
export function appOrigin(): string {
  return (process.env.APP_ORIGIN || 'http://localhost:5173').trim().replace(/\/+$/, '')
}

export function providerLabel(): string {
  const c = oidcConfig()
  return c ? c.label : '企业账号'
}

interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
}

let discoveryCache: { url: string; doc: Discovery; ts: number } | null = null

async function discover(issuer: string): Promise<Discovery> {
  if (discoveryCache && discoveryCache.url === issuer && Date.now() - discoveryCache.ts < 3600_000) {
    return discoveryCache.doc
  }
  const res = await fetch(issuer + '/.well-known/openid-configuration')
  if (!res.ok) throw new Error('IdP 发现文档获取失败：HTTP ' + res.status)
  const doc = (await res.json()) as Discovery
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('IdP 发现文档缺少 authorization_endpoint / token_endpoint')
  }
  discoveryCache = { url: issuer, doc, ts: Date.now() }
  return doc
}

const pending = new Map<string, { ts: number; verifier: string; next: string }>()

function prunePending() {
  const cut = Date.now() - 10 * 60_000
  for (const [k, v] of pending) if (v.ts < cut) pending.delete(k)
}

/** 第一步：生成跳转 IdP 的授权地址 */
export async function beginOidc(next = '/'): Promise<string> {
  const c = oidcConfig()
  if (!c) throw new Error('未配置 OIDC（缺少 OIDC_ISSUER / OIDC_CLIENT_ID）')
  const d = await discover(c.issuer)
  const state = crypto.randomBytes(16).toString('base64url')
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  prunePending()
  pending.set(state, { ts: Date.now(), verifier, next })

  const q = new URLSearchParams({
    response_type: 'code',
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    scope: c.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return d.authorization_endpoint + (d.authorization_endpoint.includes('?') ? '&' : '?') + q.toString()
}

/** 第二步：拿 code 换 token，拉用户信息，建立/复用账号并签发会话 */
export async function completeOidc(code: string, state: string): Promise<{ user: User; session: { token: string; expiresAt: number }; next: string }> {
  const c = oidcConfig()
  if (!c) throw new Error('未配置 OIDC')
  const rec = pending.get(state)
  if (!rec) throw new Error('state 无效或已过期，请重新发起登录')
  pending.delete(state)

  const d = await discover(c.issuer)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: c.redirectUri,
    client_id: c.clientId,
    code_verifier: rec.verifier,
  })
  if (c.clientSecret) body.set('client_secret', c.clientSecret)

  const tr = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!tr.ok) throw new Error('换取令牌失败：HTTP ' + tr.status + ' ' + (await tr.text()).slice(0, 200))
  const tj = (await tr.json()) as { access_token?: string; id_token?: string }

  let profile: { sub?: string; name?: string; preferred_username?: string; email?: string; picture?: string } = {}
  if (tj.id_token) {
    // 只做解析不做验签：令牌是后端直连 IdP 换来的，不经浏览器，冒充不了
    const payload = tj.id_token.split('.')[1]
    if (payload) {
      try {
        profile = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
      } catch {
        /* 解析失败就退回 userinfo */
      }
    }
  }
  if (!profile.sub && d.userinfo_endpoint && tj.access_token) {
    const ur = await fetch(d.userinfo_endpoint, {
      headers: { authorization: 'Bearer ' + tj.access_token },
    })
    if (ur.ok) profile = { ...profile, ...((await ur.json()) as typeof profile) }
  }

  const sub = String(profile.sub || '').trim()
  if (!sub) throw new Error('IdP 未返回 sub，无法建立账号')

  const user = upsertUser({
    provider: new URL(c.issuer).host,
    sub,
    name: profile.name || profile.preferred_username || profile.email || '未命名用户',
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.picture ? { avatar: profile.picture } : {}),
  })
  const session = createSession(user.id)
  return { user, session, next: rec.next || '/' }
}

/** 前端渲染登录页需要的信息（不含任何凭据） */
export function authConfig() {
  return {
    mode: authMode(),
    devLogin: devLoginEnabled(),
    providerLabel: providerLabel(),
    appOrigin: appOrigin(),
  }
}
