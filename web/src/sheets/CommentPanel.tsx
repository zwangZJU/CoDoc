/**
 * 批注（评论）侧栏：与智能助手共用右侧区域
 * · 列出当前工作表全部批注，点击定位到单元格
 * · 对当前选中单元格新增 / 修改 / 删除批注，内容随文档协同同步、可撤销
 */
import { useEffect, useState } from 'react'
import type { SheetApi } from './useSheet'
import { Ico } from './sheetIcons'

interface Props {
  sheet: SheetApi
  sel: { r: number; c: number }
  selRef: string
  selfName: string
  readOnly: boolean
  onClose: () => void
  onJump: (r: number, c: number) => void
  onNotify: (msg: string) => void
}

export default function CommentPanel({
  sheet,
  sel,
  selRef,
  selfName,
  readOnly,
  onClose,
  onJump,
  onNotify,
}: Props) {
  const key = sel.r + ',' + sel.c
  const existing = sheet.comments[key]
  const [draft, setDraft] = useState('')

  // 切换到别的单元格时，把草稿同步成该格的批注
  useEffect(() => {
    setDraft(sheet.comments[sel.r + ',' + sel.c]?.text || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.r, sel.c, sheet.comments])

  const list = Object.entries(sheet.comments)
    .map(([k, v]) => {
      const [r, c] = k.split(',').map(Number)
      return { r, c, ...v }
    })
    .sort((a, b) => a.r - b.r || a.c - b.c)

  const save = () => {
    if (readOnly) {
      onNotify('只读模式下无法添加批注')
      return
    }
    sheet.setComment(sel.r, sel.c, draft, selfName)
    onNotify(draft.trim() ? `已保存 ${selRef} 的批注` : '已删除批注')
  }

  return (
    <aside className="cm-panel">
      <div className="ai-head">
        <span className="ai-head-title">
          <Ico n="comment" size={16} />
          评论
          <span className="ai-dim">（{list.length}）</span>
        </span>
        <div className="ai-head-actions">
          <button className="ai-head-btn" title="关闭" onClick={onClose}>
            <Ico n="close" size={15} />
          </button>
        </div>
      </div>

      <div className="cm-body">
        <div className="cm-editor">
          <div className="cm-editor-head">
            <span className="cm-cell-tag">{selRef}</span>
            <span className="ai-dim">{existing ? `最后由 ${existing.author} 编辑` : '还没有批注'}</span>
          </div>
          <textarea
            className="cm-input"
            rows={3}
            placeholder={readOnly ? '只读模式' : '写下对这个单元格的批注…'}
            disabled={readOnly}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="cm-editor-actions">
            {existing && !readOnly && (
              <button
                className="cm-btn danger"
                onClick={() => {
                  sheet.deleteComment(sel.r, sel.c)
                  setDraft('')
                  onNotify('已删除批注')
                }}
              >
                删除
              </button>
            )}
            <span className="tb-grow" />
            <button className="cm-btn primary" disabled={readOnly} onClick={save}>
              {existing ? '更新' : '添加'}
            </button>
          </div>
        </div>

        <div className="cm-list">
          {list.length === 0 && <p className="cm-empty">当前工作表还没有批注。</p>}
          {list.map((c) => (
            <button
              key={c.r + ',' + c.c}
              className="cm-item"
              onClick={() => onJump(c.r, c.c)}
              title="定位到该单元格"
            >
              <span className="cm-item-top">
                <span className="cm-cell-tag">{colName(c.c) + (c.r + 1)}</span>
                <span className="ai-dim">{c.author}</span>
                <span className="ai-dim">{fmtTime(c.ts)}</span>
              </span>
              <span className="cm-item-text">{c.text}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}

function colName(c: number): string {
  let n = c
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}
