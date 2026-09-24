import { useState } from 'react'
import type { RemotePeer } from '../store/useAwareness'
import type { LocalUser } from '../store/user'
import { colorOf } from '../store/user'
import { indexToCol } from '../sheets/refs'

export function PresenceBar({
  peers,
  user,
  onOpenPanel,
  onRename,
}: {
  peers: RemotePeer[]
  user: LocalUser
  onOpenPanel: () => void
  onRename?: () => void
}) {
  const all = [
    {
      clientId: -1,
      user: { id: user.id, name: user.name, colorIndex: user.colorIndex },
      self: true,
    } as unknown as RemotePeer & { self: boolean },
    ...peers.map((p) => ({ ...p, self: false })),
  ]
  const shown = all.slice(0, 5)
  const extra = all.length - shown.length

  return (
    <div className="presence">
      {shown.map((p: any) => {
        const col = colorOf(p.user.colorIndex)
        const isEditing = p.self ? false : !!p.editing
        const title =
          p.user.name +
          (p.self ? ' · 点击修改你的名字' : isEditing ? ' · 正在编辑' : '')
        return (
          <div
            key={p.clientId}
            className={'avatar' + (p.self && onRename ? ' clickable' : '')}
            title={title}
            onClick={p.self ? onRename : undefined}
            style={{ background: col.c }}
          >
            {String(p.user.name).slice(0, 1)}
            {isEditing && (
              <span
                className="presence-dot"
                style={{ background: col.c }}
              />
            )}
          </div>
        )
      })}
      {extra > 0 && <div className="avatar more">+{extra}</div>}
      <button className="btn-ghost presence-btn" onClick={onOpenPanel}>
        协作者 · {all.length}
      </button>
    </div>
  )
}

export function CollaboratorPanel({
  peers,
  user,
  onClose,
  onJump,
}: {
  peers: RemotePeer[]
  user: LocalUser
  onClose: () => void
  onJump: (c: { r: number; c: number }) => void
}) {
  const [tab, setTab] = useState<'all' | 'mine'>('all')
  const list = [
    {
      clientId: -1,
      user: { id: user.id, name: user.name, colorIndex: user.colorIndex },
      self: true,
    } as unknown as RemotePeer & { self: boolean },
    ...peers.map((p) => ({ ...p, self: false })),
  ]
  const filtered =
    tab === 'mine' ? list.filter((p: any) => p.self) : list

  return (
    <div className="drawer-mask" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>协作者</h3>
          <button className="btn-ghost" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="drawer-body">
          <div className="segmented">
            <button
              className={tab === 'all' ? 'active' : ''}
              onClick={() => setTab('all')}
            >
              全部 · {list.length}
            </button>
            <button
              className={tab === 'mine' ? 'active' : ''}
              onClick={() => setTab('mine')}
            >
              仅我的修改
            </button>
          </div>
          {filtered.map((p: any) => {
            const col = colorOf(p.user.colorIndex)
            const pos = p.editing || p.selection
            const ref = pos ? indexToCol(pos.c) + (pos.r + 1) : null
            return (
              <div
                key={p.clientId}
                className="people-row"
                onClick={() => pos && onJump({ r: pos.r, c: pos.c })}
                style={{ cursor: pos ? 'pointer' : 'default' }}
              >
                <div className="avatar" style={{ background: col.c }}>
                  {String(p.user.name).slice(0, 1)}
                  {p.self && <span className="me-ring" />}
                </div>
                <div className="people-meta">
                <div className="people-name">
                  {p.user.name}
                  {p.self && <span className="me-tag">你</span>}
                  {p.self && user.guest && <span className="guest-tag">访客</span>}
                  {!p.self && p.user?.guest && <span className="guest-tag">访客</span>}
                </div>
                  <div className="people-sub">
                    {p.self
                      ? '这是你'
                      : ref
                      ? '正在编辑 ' + ref
                      : '在线查看'}
                  </div>
                </div>
              </div>
            )
          })}
          <p className="hint">
            点击某人可跳转到他正在编辑的单元格。
          </p>
        </div>
      </aside>
    </div>
  )
}
