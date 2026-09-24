/**
 * 本地用户身份 + 协同 6 色表（与 tokens.css 第 4 节协同色一致）
 * 主色用于描边/竖条/光标；ink 用于姓名文字（琥珀/亮蓝对比度不足须用 ink）
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
  id: string
  name: string
  colorIndex: number
  /** true = 通过分享链接进入的访客（没有账号系统），UI 上打「访客」角标 */
  guest?: boolean
}

const KEY = 'codoc-user'
/** 访客身份单独存：本机所有者的名字叫「我」，不能和链接进来的访客混用 */
const GUEST_KEY = 'codoc-guest'

const randId = () => Math.random().toString(36).slice(2, 10)
const randColor = () => Math.floor(Math.random() * COLLAB.length)

/** 本机用户（工作台所有者视角） */
export function getLocalUser(): LocalUser {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const u = JSON.parse(raw) as LocalUser
      if (u && u.id && u.name) return { ...u, guest: false }
    }
  } catch {
    /* ignore */
  }
  const user: LocalUser = { id: randId(), name: '我', colorIndex: randColor(), guest: false }
  localStorage.setItem(KEY, JSON.stringify(user))
  return user
}

/** 已记住的访客身份；返回 null 表示这个人从没在本机登记过，需要弹姓名卡片 */
export function getGuestUser(): LocalUser | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY)
    if (!raw) return null
    const u = JSON.parse(raw) as LocalUser
    if (!u?.id || !u?.name) return null
    return { ...u, guest: true }
  } catch {
    return null
  }
}

/** 登记访客身份。remember=false 时只放 sessionStorage（关掉标签页就重新问） */
export function saveGuestUser(name: string, colorIndex: number, remember = true): LocalUser {
  const user: LocalUser = { id: randId(), name, colorIndex, guest: true }
  const raw = JSON.stringify(user)
  try {
    const store = remember ? localStorage : sessionStorage
    store.setItem(GUEST_KEY, raw)
  } catch {
    /* 隐私模式下写不了就算了，本次会话仍可用 */
  }
  return user
}

export function clearGuestUser() {
  try {
    localStorage.removeItem(GUEST_KEY)
    sessionStorage.removeItem(GUEST_KEY)
  } catch {
    /* ignore */
  }
}

/** 改名 / 换色：按身份来源写回对应存储，id 保持不变 */
export function applyIdentity(
  prev: LocalUser,
  patch: { name?: string; colorIndex?: number }
): LocalUser {
  const next: LocalUser = {
    ...prev,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.colorIndex !== undefined ? { colorIndex: patch.colorIndex } : {}),
  }
  try {
    const key = prev.guest ? GUEST_KEY : KEY
    const store = prev.guest && !localStorage.getItem(GUEST_KEY) ? sessionStorage : localStorage
    store.setItem(key, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

/** 姓名合法性：1~12 个字符，去空白后非空 */
export function isValidName(name: string) {
  const t = name.trim()
  return t.length > 0 && t.length <= 12
}

export function colorOf(i: number) {
  return COLLAB[((i % COLLAB.length) + COLLAB.length) % COLLAB.length]
}
