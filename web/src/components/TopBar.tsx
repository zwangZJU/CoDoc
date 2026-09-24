import type { RefObject } from 'react'
import type { RemotePeer } from '../store/useAwareness'
import type { LocalUser } from '../store/user'
import { PresenceBar } from './PresenceBar'
import EditableTitle from './EditableTitle'

interface Props {
  name: string
  kind: 'sheet' | 'doc'
  onBack: () => void
  onShare: () => void
  onPeople: () => void
  onHistory: () => void
  onExport: () => void
  onToggleReadOnly?: () => void
  readOnly?: boolean
  fileRef?: RefObject<HTMLInputElement>
  peers: RemotePeer[]
  user: LocalUser
  onRename?: () => void
  onDocRename?: (next: string) => Promise<void> | void
  renameDisabled?: boolean
}

export default function TopBar({
  name,
  kind,
  onBack,
  onShare,
  onPeople,
  onHistory,
  onExport,
  onToggleReadOnly,
  readOnly,
  fileRef,
  peers,
  user,
  onRename,
  onDocRename,
  renameDisabled,
}: Props) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="btn-ghost icon" onClick={onBack} title="返回工作台">
          ‹
        </button>
        <EditableTitle name={name} disabled={renameDisabled} onRename={onDocRename} />
        <span className="doc-kind">{kind === 'doc' ? '文档' : '表格'}</span>
      </div>
      <div className="topbar-right">
        <PresenceBar peers={peers} user={user} onOpenPanel={onPeople} onRename={onRename} />
        <span className="topbar-div" />
        <div className="topbar-more">
          {onToggleReadOnly && (
            <button className="btn-ghost" onClick={onToggleReadOnly}>
              {readOnly ? '恢复编辑' : '只读查看'}
            </button>
          )}
          <button className="btn-ghost" onClick={onHistory}>
            历史
          </button>
          {fileRef && (
            <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
              导入
            </button>
          )}
          <button className="btn-ghost" onClick={onExport}>
            导出
          </button>
        </div>
        <button className="btn-primary" onClick={onShare}>
          分享
        </button>
      </div>
    </header>
  )
}
