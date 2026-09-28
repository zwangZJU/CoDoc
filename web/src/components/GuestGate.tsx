import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type LinkPerm } from '../store/api'
import { snapshotPeers } from '../store/useAwareness'
import { COLLAB, colorOf, isValidName, type LocalUser } from '../store/user'
import type { WebsocketProvider } from 'y-websocket'

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

/**
 * 申请访问。
 *
 * 飞书的做法：没有权限的人看到的不是白屏或报错，而是"申请权限"页，
 * 并且明确告诉他找谁申请。
 *
 * 这里不再让用户填名字——访问者必须先登录，登记的是账号 userId，
 * 因此同一个人换设备、换浏览器再来，审批记录和权限都还是他的。
 */
export function GuestGate({
  docName,
  docId,
  ownerName,
  /** true = 这份文档没有开放链接，提交后进入审批而不是直接进入 */
  needApproval,
  me,
  onGranted,
  onPending,
  onBack,
}: {
  docName: string
  docId: string
  ownerName?: string
  needApproval: boolean
  /** 当前登录账号：用它提交申请，不再现场填名字 */
  me: LocalUser
  onGranted: () => void
  onPending: () => void
  onBack: () => void
}) {
  const [want, setWant] = useState<LinkPerm>('edit')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await api.joinDoc(docId, want, note)
      if (r.status === 'granted') onGranted()
      else onPending()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="guest-mask">
      <div className="guest-card">
        <div>
          <div className="guest-badge">{needApproval ? '需要授权' : '访客身份'}</div>
          <h2 className="guest-title">
            {needApproval ? '这份文档仅指定成员可访问' : '你正在打开一份共享文档'}
          </h2>
          <p className="guest-sub">
            {needApproval ? (
              <>
                《{docName || '未命名文档'}》没有开放链接分享。以当前账号提交申请，
                {ownerName ? ` ${ownerName}` : '文档所有者'}批准后即可进入，无需重新打开链接。
              </>
            ) : (
              <>
                《{docName || '未命名文档'}》通过分享链接打开。
                确认后其他人就能在右上角看到「谁在编辑」，你的修改也会标记成你的。
              </>
            )}
          </p>
        </div>

        <div className="guest-row">
          <AvatarPreview name={me.name} colorIndex={me.colorIndex} />
          <div className="guest-pick">
            <div className="guest-who">{me.name}</div>
            <span className="guest-pick-hint">
              当前登录账号{me.email ? `（${me.email}）` : ''}，将用它申请访问
            </span>
          </div>
        </div>

        {needApproval && (
          <>
            <label className="field-label">申请的权限</label>
            <div className="segmented">
              <button className={want === 'view' ? 'active' : ''} onClick={() => setWant('view')}>
                只查看
              </button>
              <button className={want === 'edit' ? 'active' : ''} onClick={() => setWant('edit')}>
                可编辑
              </button>
            </div>

            <label className="field-label" htmlFor="guest-note">
              申请理由（选填）
            </label>
            <input
              id="guest-note"
              className="modal-input"
              placeholder="例如：项目组同事，需要一起整理数据"
              maxLength={60}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </>
        )}

        {err && <p className="guest-err">{err}</p>}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onBack}>
            返回
          </button>
          <button className="btn-primary" disabled={busy} onClick={submit}>
            {busy ? '提交中…' : needApproval ? '提交申请' : '进入文档'}
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

/**
 * 等待批准 / 被拒绝。
 * 每 5 秒问一次后端：所有者批准后自动放行，不必让用户刷新页面。
 */
export function AccessWaiting({
  docName,
  docId,
  ownerName,
  rejected,
  onGranted,
  onBack,
}: {
  docName: string
  docId: string
  ownerName?: string
  rejected: boolean
  onGranted: () => void
  onBack: () => void
}) {
  const [tick, setTick] = useState(0)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (docId === '') return
    let alive = true
    const timer = window.setInterval(async () => {
      try {
        const me = await api.getMyAccess(docId)
        if (!alive) return
        if (me.level !== 'none') {
          onGranted()
          return
        }
        setTick((t) => t + 1)
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      }
    }, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [docId, onGranted])

  return (
    <div className="guest-mask">
      <div className="guest-card">
        <div className="guest-badge">{rejected ? '申请未通过' : '等待批准'}</div>
        <h2 className="guest-title">
          {rejected ? '所有者没有通过你的申请' : '已提交，等待所有者批准'}
        </h2>
        <p className="guest-sub">
          《{docName || '未命名文档'}》
          {rejected
            ? '的申请已被拒绝。如果确有需要，请直接联系文档所有者。'
            : `已通知${ownerName ? ` ${ownerName}` : '文档所有者'}，批准后这个页面会自动进入文档，不用刷新。`}
          {tick > 0 && !rejected && '（每 5 秒自动检查一次）'}
        </p>
        {err && <p className="guest-err">{err}</p>}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onBack}>
            返回工作台
          </button>
        </div>
      </div>
    </div>
  )
}
