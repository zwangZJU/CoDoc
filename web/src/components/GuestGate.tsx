import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { snapshotPeers } from '../store/useAwareness'
import { COLLAB, colorOf, isValidName, type LocalUser } from '../store/user'

// 与 useCollab 保持一致的 ws 地址拼接
const WS_BASE =
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/collab'

/** 访客登记提交时回传的信息（由调用方决定如何存储 / 是否注册成成员） */
export interface GuestJoinInfo {
  name: string
  colorIndex: number
  /** 记住这台设备上的姓名（否则仅本次会话） */
  remember: boolean
  /** 把名字注册进文档成员名单，而不只是实时在线可见 */
  register: boolean
}

/** 首字作为头像文字：中文取姓/名首字，英文取首字母并大写 */
function initialOf(name: string) {
  const t = name.trim()
  if (!t) return '?'
  return t.slice(0, 1).toUpperCase()
}

function AvatarPreview({ name, colorIndex }: { name: string; colorIndex: number }) {
  const col = colorOf(colorIndex)
  return (
    <div className="guest-avatar" style={{ background: col.c }}>
      {initialOf(name)}
    </div>
  )
}

function ColorPicker({
  value,
  onChange,
}: {
  value: number
  onChange: (i: number) => void
}) {
  return (
    <div className="swatches">
      {COLLAB.map((c, i) => (
        <button
          key={c.c}
          type="button"
          className={'swatch' + (i === value ? ' on' : '')}
          style={{ background: c.c }}
          title={c.label}
          aria-label={'头像颜色：' + c.label}
          onClick={() => onChange(i)}
        />
      ))}
    </div>
  )
}

/** 等待 y-websocket 首次 sync 完成（用于进入前取在线名单）；超时返回 true 也要查一次 */
function waitForSync(p: WebsocketProvider, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (p.synced) {
      resolve()
      return
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      p.off('sync', onSync)
      resolve()
    }
    const onSync = (s: boolean) => s && finish()
    p.on('sync', onSync)
    window.setTimeout(finish, timeoutMs)
  })
}

/**
 * 访客身份登记：通过分享链接打开文档时显示，必须填姓名才能进入。
 * 填完之后才能建立协同连接——否则在线名单里只会是一堆「我」。
 * register 勾选时，调用方会把此人注册为文档成员（名字进后端成员名单）。
 */
export function GuestGate({
  docName,
  docId,
  onJoin,
}: {
  docName: string
  /** 文档 id：用于进入前预连协同房间，校验名字是否已被在线者占用 */
  docId: string
  onJoin: (info: GuestJoinInfo) => void
}) {
  const [name, setName] = useState('')
  const [colorIndex, setColorIndex] = useState(() => Math.floor(Math.random() * COLLAB.length))
  const [remember, setRemember] = useState(true)
  const [register, setRegister] = useState(true)
  const [touched, setTouched] = useState(false)
  const [dup, setDup] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // 只用于在线查重，不做事后名单；进入文档后由 useCollab 重建连接
  const probeRef = useRef<{ ydoc: Y.Doc; provider: WebsocketProvider } | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const ok = isValidName(name)
  // 进入前预连协同房间，用于校验名字是否在线占用（normalize 后比较）
  const ensureProbe = (): { ydoc: Y.Doc; provider: WebsocketProvider } => {
    if (probeRef.current) return probeRef.current
    const ydoc = new Y.Doc()
    const provider = new WebsocketProvider(WS_BASE, docId, ydoc, { connect: true })
    probeRef.current = { ydoc, provider }
    return probeRef.current
  }

  const normalize = (s: string) => s.trim().toLowerCase()

  /** 名字是否已被当前文档的其他在线协作者占用（不含自己与未命名的连接） */
  const isNameTaken = useCallback(
    (candidate: string) => {
      const probe = probeRef.current
      if (!probe) return false
      const n = normalize(candidate)
      return snapshotPeers(probe.provider).some(
        (p) => p.user?.name && normalize(p.user.name) === n
      )
    },
    []
  )

  // 输入时实时提示占用（去抖），与提交时二次校验互补
  useEffect(() => {
    if (!ok || !docId) {
      setDup(false)
      return
    }
    let alive = true
    const t = window.setTimeout(async () => {
      if (!alive) return
      const probe = ensureProbe()
      await waitForSync(probe.provider, 1500)
      if (alive) setDup(isNameTaken(name))
    }, 600)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [name, ok, docId, isNameTaken])

  const submit = async () => {
    setTouched(true)
    if (!ok) {
      inputRef.current?.focus()
      return
    }
    // 提交时最终校验：确保协同连接就绪后查一次（防实时提示未生效直接回车绕过）
    const probe = ensureProbe()
    await waitForSync(probe.provider, 1500)
    if (isNameTaken(name)) {
      setDup(true)
      inputRef.current?.focus()
      return
    }
    // 清理探测连接，避免带着一个多余的空连接进入文档
    if (probeRef.current) {
      probeRef.current.provider.destroy()
      probeRef.current = null
    }
    onJoin({ name: name.trim(), colorIndex, remember, register })
  }

  return (
    <div className="guest-mask">
      <div className="guest-card">
        <div>
          <div className="guest-badge">访客身份</div>
          <h2 className="guest-title">你正在打开一份共享文档</h2>
          <p className="guest-sub">
            《{docName || '未命名文档'}》通过分享链接打开，不需要登录。
            填个名字，其他人就能在右上角看到「谁在编辑」，你的修改也会标记成你的。
          </p>
        </div>

        <div className="guest-row">
          <AvatarPreview name={name} colorIndex={colorIndex} />
          <div className="guest-pick">
            <ColorPicker value={colorIndex} onChange={setColorIndex} />
            <span className="guest-pick-hint">选个头像颜色，用来区分不同的编辑者</span>
          </div>
        </div>

        <label className="field-label" htmlFor="guest-name">
          你的姓名
        </label>
        <input
          id="guest-name"
          ref={inputRef}
          className="modal-input"
          placeholder="例如：张三 / Alice"
          maxLength={12}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {touched && !ok && (
          <p className="guest-err">请填写 1–12 个字符的姓名，方便其他人认出你。</p>
        )}
        {dup && (
          <p className="guest-err" role="alert">
            这个名字已被在线协作者占用，请换一个名字。
          </p>
        )}

        <label className="guest-remember">
          <input
            type="checkbox"
            checked={register}
            onChange={(e) => setRegister(e.target.checked)}
          />
          注册为文档成员（名字加入协作名单，可在分享面板看到）
        </label>
        <label className="guest-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          记住这个名字，以后在本机打开链接不用再填
        </label>

        <div className="modal-actions">
          <button className="btn-primary" disabled={!ok} onClick={submit}>
            进入文档
          </button>
        </div>
      </div>
    </div>
  )
}

/** 改名 / 换色（本机用户和访客都能用） */
export function IdentityDialog({
  user,
  provider,
  onSave,
  onClose,
}: {
  user: LocalUser
  /** 当前协同 Provider：保存前校验新名字是否被其他在线协作者占用 */
  provider?: WebsocketProvider
  onSave: (name: string, colorIndex: number) => void
  onClose: () => void
}) {
  const [name, setName] = useState(user.name)
  const [colorIndex, setColorIndex] = useState(user.colorIndex)
  const [dup, setDup] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const ok = isValidName(name)

  // 实时提示：改到在线名单里已有的名字时给出提示（自己除外）
  useEffect(() => {
    if (!ok || !provider) {
      setDup(false)
      return
    }
    const n = name.trim().toLowerCase()
    const taken = snapshotPeers(provider).some(
      (p) => p.user?.name && p.user.name.trim().toLowerCase() === n
    )
    setDup(taken)
  }, [name, ok, provider])

  const save = () => {
    if (!ok) return
    if (provider && dup) {
      setDup(true)
      inputRef.current?.focus()
      return
    }
    onSave(name.trim(), colorIndex)
  }

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>修改显示名称</h3>
        <p className="guest-sub">
          这个名字用于在线名单与编辑标记{user.guest ? '（你是以访客身份打开的）' : ''}，
          改完会立即同步给所有协作者。
        </p>
        <div className="guest-row">
          <AvatarPreview name={name} colorIndex={colorIndex} />
          <ColorPicker value={colorIndex} onChange={setColorIndex} />
        </div>
        <input
          ref={inputRef}
          className="modal-input"
          maxLength={12}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        {dup && (
          <p className="guest-err" role="alert">
            这个名字已被在线协作者占用，请换一个名字。
          </p>
        )}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" disabled={!ok} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
