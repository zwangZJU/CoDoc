import { useEffect, useRef, useState } from 'react'

export type SheetFormat = 'xlsx' | 'csv' | 'md' | 'pdf'
export type DocFormat = 'docx' | 'md' | 'txt' | 'pdf'

const SHEET_FORMATS: { id: SheetFormat; icon: string; name: string; ext: string; sub: string }[] =
  [
    { id: 'xlsx', icon: '▦', name: 'Excel 工作簿', ext: '.xlsx', sub: '保留样式、公式与多工作表' },
    { id: 'csv', icon: '≡', name: 'CSV 纯数据', ext: '.csv', sub: '仅当前工作表的值' },
    { id: 'md', icon: '◇', name: 'Markdown 表格', ext: '.md', sub: '便于贴进文档 / 工单' },
    { id: 'pdf', icon: '⎙', name: 'PDF', ext: '.pdf', sub: '调用浏览器打印为 PDF' },
  ]

const DOC_FORMATS: { id: DocFormat; icon: string; name: string; ext: string; sub: string }[] = [
  { id: 'docx', icon: '▤', name: 'Word 文档', ext: '.docx', sub: '保留标题层级与格式' },
  { id: 'md', icon: '◇', name: 'Markdown', ext: '.md', sub: '纯文本，标题自动转换' },
  { id: 'txt', icon: '≡', name: '纯文本', ext: '.txt', sub: '只要文字，不带格式' },
  { id: 'pdf', icon: '⎙', name: 'PDF', ext: '.pdf', sub: '调用浏览器打印为 PDF' },
]

type Stage = 'choose' | 'generating' | 'done'

/** 导出流程模态（S7）：选择格式 → 生成中 → 下载完成 */
export default function ExportModal({
  open,
  kind,
  docName,
  peers,
  onlineTotal,
  sheetNames,
  activeSheet,
  onClose,
  onToast,
  onExportSheet,
  onExportDoc,
}: {
  open: boolean
  kind: 'sheet' | 'doc'
  docName: string
  /** 除你之外的在线人数 */
  peers: number
  /** 含你的在线总人数 */
  onlineTotal: number
  sheetNames?: string[]
  activeSheet?: string
  onClose: () => void
  onToast: (m: string) => void
  onExportSheet?: (fmt: SheetFormat, opts: { currentOnly: boolean; sheet: string }) => void
  onExportDoc?: (fmt: DocFormat) => void
}) {
  const [stage, setStage] = useState<Stage>('choose')
  const [fmt, setFmt] = useState<SheetFormat | DocFormat>(kind === 'sheet' ? 'xlsx' : 'docx')
  const [currentOnly, setCurrentOnly] = useState(false)
  const [step, setStep] = useState(0)
  const timers = useRef<number[]>([])

  useEffect(() => {
    if (open) {
      setStage('choose')
      setStep(0)
      setFmt(kind === 'sheet' ? 'xlsx' : 'docx')
      setCurrentOnly(false)
    }
    return () => {
      timers.current.forEach((t) => window.clearTimeout(t))
      timers.current = []
    }
  }, [open, kind])

  const formats = kind === 'sheet' ? SHEET_FORMATS : DOC_FORMATS
  const active = formats.find((f) => f.id === fmt) ?? formats[0]!

  const steps =
    kind === 'sheet'
      ? [
          `合并 ${onlineTotal} 人的实时改动…`,
          currentOnly
            ? `仅提取工作表「${activeSheet || '当前'}」的内容…`
            : `写入 ${sheetNames?.length || 1} 个工作表…`,
          `生成 ${docName}${active.ext}…`,
        ]
      : [`合并 ${onlineTotal} 人的实时改动…`, `按标题层级排版段落…`, `生成 ${docName}${active.ext}…`]

  const run = () => {
    setStage('generating')
    setStep(0)
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = [
      window.setTimeout(() => setStep(1), 420),
      window.setTimeout(() => {
        try {
          if (kind === 'sheet') {
            onExportSheet?.(fmt as SheetFormat, {
              currentOnly,
              sheet: activeSheet || sheetNames?.[0] || 'Sheet1',
            })
          } else {
            onExportDoc?.(fmt as DocFormat)
          }
        } catch (e) {
          onToast('导出失败：' + (e instanceof Error ? e.message : String(e)))
          setStage('choose')
          return
        }
        setStep(2)
      }, 900),
      window.setTimeout(() => setStage('done'), 1400),
    ]
  }

  if (!open) return null

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {stage === 'choose' && (
          <>
            <h3>导出「{docName}」</h3>
            <div className="export-hint">
              将导出当前最新合并版本
              {peers > 0 ? `（含其他 ${peers} 人的修改 · 共 ${onlineTotal} 人在线）` : '（当前只有你在编辑）'}
            </div>
            <div className="export-formats">
              {formats.map((f) => (
                <button
                  key={f.id}
                  className={'export-fmt' + (fmt === f.id ? ' active' : '')}
                  onClick={() => setFmt(f.id)}
                >
                  <span className="ef-icon">{f.icon}</span>
                  <span>
                    <span className="ef-name">{f.name}</span>
                    <span className="mo-sub">{f.sub}</span>
                  </span>
                </button>
              ))}
            </div>
            {kind === 'sheet' && fmt !== 'pdf' && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={currentOnly}
                  onChange={(e) => setCurrentOnly(e.target.checked)}
                />
                仅导出当前工作表「{activeSheet || sheetNames?.[0] || 'Sheet1'}」
              </label>
            )}
            {fmt === 'pdf' && (
              <p className="hint">
                PDF 由浏览器打印生成：点击导出后会在打印对话框里选择「另存为 PDF」。
              </p>
            )}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={onClose}>
                取消
              </button>
              <button className="btn-primary" onClick={run}>
                导出 {active.ext}
              </button>
            </div>
          </>
        )}

        {stage === 'generating' && (
          <>
            <h3>正在导出…</h3>
            <div className="export-progress">{steps[Math.min(step, steps.length - 1)]}</div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: ((step + 1) / steps.length) * 100 + '%' }}
              />
            </div>
            <p className="hint">多人协同下导出的是已合并的最新内容，不会包含未同步的本地草稿。</p>
          </>
        )}

        {stage === 'done' && (
          <>
            <h3>导出完成</h3>
            <div className="export-hint">
              {docName}
              {active.ext} 已生成
              {peers > 0 ? `，包含其他 ${peers} 人的修改` : ''}。
            </div>
            <p className="hint">
              如果浏览器没有自动下载，请检查是否被拦截弹窗；点「重新走一遍」可再导一次。
            </p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setStage('choose')}>
                重新走一遍流程
              </button>
              <button className="btn-primary" onClick={onClose}>
                完成
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
