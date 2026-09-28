/**
 * 登录身份 + 协同 6 色表（与 tokens.css 第 4 节协同色一致）
 * 主色用于描边/竖条/光标；ink 用于姓名文字（琥珀/亮蓝对比度不足须用 ink）
 *
 * 重要：这里不再生成任何本地凭证。
 * 早期版本在本机随机生成一个 token 存在 localStorage 当身份，于是换浏览器、
 * 换访问入口（localhost / 127.0.0.1 / 局域网 IP）就变成另一个人，自己创建的
 * 文档反而提示「你已无法访问」。现在身份由登录会话下发（后端 HttpOnly Cookie），
 * 前端只保存「我是谁」的展示信息，归属一律以后端的 userId 为准。
 */
export const COLLAB = [
  { c: '#185FA5', ink: '#185FA5', label: '深蓝' },
  { c: '#BA7517', ink: '#8F5B08', label: '琥珀' },
  { c: '#0F6E56', ink: '#0F6E56', label: '青绿' },
  { c: '#534AB7', ink: '#534AB7', label: '紫' },
  { c: '#993556', ink: '#993556', label: '玫红' },
  { c: '#378ADD', ink: '#1A6BA6', label: '亮蓝' },
] as const

export interface LocalUser {
  /** 后端账号 userId：权限归属锚点 */
  id: string
  name: string
  colorIndex: number
  email?: string
  avatar?: string
  /** 登录来源：dev / casdoor / feishu ... */
  provider?: string
  /** 保留字段：现已不再有"匿名访客"，协同名单统一按账号显示 */
  guest?: boolean
}

/** 当前登录用户（登录后由 App 注入；未登录为 null） */
let current: LocalUser | null = null

/** 颜色按 userId 稳定哈希：同一个人每次进来都是同一个颜色 */
function colorIndexFor(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100000
  return ((h % COLLAB.length) + COLLAB.length) % COLLAB.length
}

export function setSession(u: {
  id: string
  name: string
  email?: string
  avatar?: string
  provider?: string
}): LocalUser {
  current = {
    id: u.id,
    name: u.name,
    colorIndex: colorIndexFor(u.id),
    ...(u.email ? { email: u.email } : {}),
    ...(u.avatar ? { avatar: u.avatar } : {}),
    provider: u.provider || 'dev',
    guest: false,
  }
  return current
}

export function getSession(): LocalUser | null {
  return current
}

export function clearSession(): void {
  current = null
}

/** 改名/换色：只改本地展示（刷新后回到账号名），不改变权限归属 */
export function patchSession(patch: { name?: string; colorIndex?: number }): LocalUser | null {
  if (!current) return null
  current = {
    ...current,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.colorIndex !== undefined ? { colorIndex: patch.colorIndex } : {}),
  }
  return current
}

/** 姓名合法性：1~12 个字符，去空白后非空 */
export function isValidName(name: string) {
  const t = name.trim()
  return t.length > 0 && t.length <= 12
}

export function colorOf(i: number) {
  return COLLAB[((i % COLLAB.length) + COLLAB.length) % COLLAB.length]
}
