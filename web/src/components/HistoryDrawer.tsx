import { useEffect, useState } from 'react'
import { api, type DocVersion, type VersionPreview } from '../store/api'

type Tab = 'all' | 'mine' | 'named'

function fmt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? `今天 ${p(d.getHours())}:${p(d.getMinutes())}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 历史版本抽屉（S6）：时间轴 + 预览 / 命名 / 恢复（二次确认） */
export default function HistoryDrawer({
  docId,
  selfName,
  onlinePeers,
  onClose,
  onToast,
  onRestored,
}: {
  docId: string
  selfName: string
  /** 当前在线人数（含自己），恢复确认提示用 */
  onlinePeers: number
  onClose: () => void
  onToast: (m: string) => void
  onRestored?: () => void
}) {
  const [versions, setVersions] = useState<DocVersion[]>([])
  const [tab, setTab] = useState<Tab>('all')
  const [preview, setPreview] = useState<{ v: DocVersion; data: VersionPreview } | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<DocVersion | null>(null)
  /** naming.v === null 表示"把当前内容另存为一个新版本"，否则是给已有版本命名 */
  const [naming, setNaming] = useState<{ open: boolean; v: DocVersion | null }>({
    open: false,
    v: null,
  })
  const [nameVal, setNameVal] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () =>
    api
      .getVersions(docId)
      .then((d) => setVersions(d.versions))
      .catch((e) => onToast('读取历史失败：' + (e?.message || e)))

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  const list = versions.filter((v) =>
    tab === 'all' ? true : tab === 'named' ? !!v.label : v.author === selfName
  )

  const showPreview = async (v: DocVersion) => {
    try {
      const data = await api.previewVersion(docId, v.id)
      setPreview({ v, data })
    } catch (e) {
      onToast('预览失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const saveNamed = async () => {
    setBusy(true)
    try {
      if (naming.v) {
        await api.renameVersion(docId, naming.v.id, nameVal.trim())
        onToast(nameVal.trim() ? '已命名' : '已清除命名')
      } else {
        await api.saveVersion(docId, nameVal.trim() || undefined, selfName)
        onToast(nameVal.trim() ? '已保存命名版本' : '已保存当前版本')
      }
      setNaming({ open: false, v: null })
      setNameVal('')
      await load()
    } catch (e) {
      onToast('保存失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const doRestore = async (v: DocVersion) => {
    setBusy(true)
    try {
      await api.restoreVersion(docId, v.id)
      setRestoreTarget(null)
      await load()
      onToast('已恢复到该版本，其他协作者会立即看到变化')
      onRestored?.()
    } catch (e) {
      onToast('恢复失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="drawer-mask" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{preview ? '版本预览（只读）' : '历史版本'}</h3>
          <button className="btn-ghost" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {preview ? (
          <div className="drawer-body">
            <div className="vcard">
              <div className="vcard-label">{preview.v.label || '未命名版本'}</div>
              <div className="vcard-sub">
                {fmt(preview.v.ts)} · {preview.v.author || '系统快照'} · 快照时{' '}
                {preview.v.peers} 人在线
                {preview.data.sheetName ? ' · 工作表 ' + preview.data.sheetName : ''}
              </div>
            </div>
            <div className="snap-preview">
              {preview.data.lines.length === 0 ? (
                <p className="hint">这个快照里没有可预览的内容。</p>
              ) : (
                preview.data.lines.map((l, i) => (
                  <div className="snap-line" key={i}>
                    {l}
                  </div>
                ))
              )}
              {preview.data.lines.length > 0 && (
                <p className="hint">仅显示开头 {preview.data.lines.length} 段，恢复后可见全部内容。</p>
              )}
            </div>
            <button className="btn-ghost" onClick={() => setPreview(null)}>
              返回版本列表
            </button>
          </div>
        ) : (
          <div className="drawer-body">
            <div className="version-tabs">
              {(
                [
                  ['all', '全部'],
                  ['mine', '仅我的修改'],
                  ['named', '已命名'],
                ] as [Tab, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={tab === k ? 'active' : ''}
                  onClick={() => setTab(k)}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              className="btn-ghost"
              disabled={busy}
              onClick={() => {
                setNameVal('')
                setNaming({ open: true, v: null })
              }}
            >
              + 保存当前版本（可命名）
            </button>

            {list.length === 0 ? (
              <p className="hint">
                {versions.length === 0
                  ? '还没有版本记录。文档每编辑一段时间会自动快照，也可以点上方按钮手动保存。'
                  : '这个筛选条件下没有版本。'}
              </p>
            ) : (
              <div className="vtimeline">
                {list.map((v) => (
                  <div className={'vcard' + (v.auto ? ' auto' : '')} key={v.id}>
                    <div className="vcard-label">{v.label || (v.auto ? '自动快照' : '手动版本')}</div>
                    <div className="vcard-sub">
                      {fmt(v.ts)} · {v.author || '系统快照'}
                      {v.peers ? ` · 快照时 ${v.peers} 人在线` : ''}
                    </div>
                    <div className="vcard-actions">
                      <button onClick={() => showPreview(v)}>预览</button>
                      <button onClick={() => setRestoreTarget(v)} disabled={busy}>
                        恢复
                      </button>
                      <button
                        onClick={() => {
                          setNameVal(v.label || '')
                          setNaming({ open: true, v })
                        }}
                      >
                        命名
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      {naming.open && (
        <div className="modal-mask" onClick={() => setNaming({ open: false, v: null })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{naming.v ? '命名这个版本' : '保存当前版本'}</h3>
            <input
              autoFocus
              className="modal-input"
              placeholder="例如：评审前定稿（留空则不命名）"
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveNamed()
              }}
            />
            <div className="modal-actions">
              <button
                className="btn-ghost"
                onClick={() => setNaming({ open: false, v: null })}
              >
                取消
              </button>
              <button className="btn-primary" disabled={busy} onClick={saveNamed}>
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {restoreTarget && (
        <div className="modal-mask" onClick={() => setRestoreTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>确认恢复这个版本？</h3>
            <p className="hint">
              将把文档内容整体替换为 {fmt(restoreTarget.ts)} 的快照，之后所有人的画面都会同步更新。
            </p>
            {onlinePeers > 1 && (
              <div className="warn-bar">
                当前还有 {onlinePeers - 1} 位协作者正在编辑，恢复会覆盖他们尚未保存的改动。
                建议先在协作者面板里跟他们说一声。
              </div>
            )}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setRestoreTarget(null)} disabled={busy}>
                取消
              </button>
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() => doRestore(restoreTarget)}
              >
                {busy ? '恢复中…' : '确认恢复'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
