import { useEffect, useRef, useState } from 'react'
import { docxToBlocks, type Block } from '../word/docx'
import { importWorkbook, type ImportedSheet } from '../sheets/io'
import type { CellData } from '../sheets/useSheet'
import type { ImportPayload } from '../store/importPayload'

type Stage = 'menu' | 'converting' | 'conflict' | 'done'
type Kind = 'sheet' | 'doc'

interface Parsed {
  payload: ImportPayload
  /** 给用户的确定性文案：解析到 N 个工作表 / M 行 / K 列 */
  summary: string
  baseName: string
}

const TEMPLATES: {
  id: string
  kind: Kind
  title: string
  sub: string
  build: () => ImportPayload
}[] = [
  {
    id: 'meeting',
    kind: 'doc',
    title: '会议纪要模板',
    sub: '议题 / 结论 / 待办三段式',
    build: () => ({
      target: 'doc',
      file: '模板-会议纪要',
      blocks: [
        { id: 't1', type: 'h1', runs: [{ text: '会议纪要' }] },
        {
          id: 't2',
          type: 'p',
          runs: [{ text: '时间：' }, { text: '　' }, { text: '参会人：' }],
        },
        { id: 't3', type: 'h2', runs: [{ text: '议题' }] },
        { id: 't4', type: 'li', runs: [{ text: '待补充' }] },
        { id: 't5', type: 'h2', runs: [{ text: '结论' }] },
        { id: 't6', type: 'p', runs: [{ text: '待补充' }] },
        { id: 't7', type: 'h2', runs: [{ text: '待办' }] },
        { id: 't8', type: 'li', runs: [{ text: '事项 · 负责人 · 截止时间' }] },
      ] as Block[],
    }),
  },
  {
    id: 'schedule',
    kind: 'sheet',
    title: '项目排期表',
    sub: '任务 / 负责人 / 起止 / 进度',
    build: () => ({
      target: 'sheet',
      file: '模板-项目排期表',
      sheets: [
        plainSheet('排期', [
          ['任务', '负责人', '开始日期', '结束日期', '进度', '备注'],
            ['需求评审', '', '2026-09-01', '2026-09-05', '0%', ''],
            ['原型设计', '', '2026-09-06', '2026-09-12', '0%', ''],
            ['开发实现', '', '2026-09-13', '2026-09-26', '0%', ''],
            ['联调验收', '', '2026-09-27', '2026-09-30', '0%', ''],
        ]),
      ],
    }),
  },
  {
    id: 'budget',
    kind: 'sheet',
    title: '预算分配表',
    sub: '科目 / 预算 / 已用 / 余额',
    build: () => ({
      target: 'sheet',
      file: '模板-预算分配表',
      sheets: [
        plainSheet('预算', [
          ['科目', '预算', '已用', '余额'],
            ['人力', '0', '0', '=B2-C2'],
            ['市场投放', '0', '0', '=B3-C3'],
            ['差旅', '0', '0', '=B4-C4'],
            ['合计', '=SUM(B2:B4)', '=SUM(C2:C4)', '=B5-C5'],
        ]),
      ],
    }),
  },
]

function stripExt(n: string): string {
  return n.replace(/\.(xlsx|xls|docx|txt|md|csv)$/i, '')
}

/** 模板 / CSV 用：纯文本二维数组 -> 完整工作表模型 */
function plainSheet(name: string, rows: string[][]): ImportedSheet {
  return {
    name,
    rows: rows.map((r) => r.map((v) => ({ v }))),
    merges: [],
    colw: {},
    rowh: {},
  }
}

export default function CreateModal({
  open,
  existingNames,
  onClose,
  onCreate,
  onImport,
  onToast,
}: {
  open: boolean
  existingNames: string[]
  onClose: () => void
  onCreate: (name: string, kind: Kind) => Promise<{ id: string; name: string; kind: Kind }>
  onImport: (doc: { id: string; name: string; kind: Kind }, payload: ImportPayload) => void
  onToast: (m: string) => void
}) {
  const [stage, setStage] = useState<Stage>('menu')
  const [dragging, setDragging] = useState(false)
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [fileName, setFileName] = useState('')
  const [conflictName, setConflictName] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  useEffect(() => {
    if (!open) {
      setStage('menu')
      setParsed(null)
      setDragging(false)
      dragDepth.current = 0
    }
  }, [open])

  // 整页拖放
  useEffect(() => {
    if (!open) return
    const hasFile = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types || []).includes('Files')
    const onEnter = (e: DragEvent) => {
      if (!hasFile(e)) return
      e.preventDefault()
      dragDepth.current++
      setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFile(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFile(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onDrop = async (e: DragEvent) => {
      if (!hasFile(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const f = e.dataTransfer?.files?.[0]
      if (f) parseFile(f)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const blank = async (kind: Kind) => {
    setBusy(true)
    try {
      const d = await onCreate(kind === 'doc' ? '未命名文档' : '未命名表格', kind)
      onToast(kind === 'doc' ? '已创建空白文档' : '已创建空白表格')
      onClose()
      return d
    } finally {
      setBusy(false)
    }
  }

  const useTemplate = async (t: (typeof TEMPLATES)[number]) => {
    setBusy(true)
    try {
      const d = await onCreate(t.title, t.kind)
      onImport({ id: d.id, name: d.name, kind: d.kind }, t.build())
      onToast('已从模板创建：' + t.title)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const parseFile = async (file: File) => {
    setFileName(file.name)
    setStage('converting')
    try {
      const lower = file.name.toLowerCase()
      if (lower.endsWith('.docx')) {
        const buf = new Uint8Array(await file.arrayBuffer())
        const blocks = docxToBlocks(buf)
        if (!blocks.length) throw new Error('文档中没有可解析的段落')
        const chars = blocks.reduce(
          (n, b) => n + b.runs.reduce((m, r) => m + r.text.length, 0),
          0
        )
        setParsed({
          payload: { target: 'doc', file: file.name, blocks },
          summary: `解析完成：${blocks.length} 个段落 · ${chars} 个字符`,
          baseName: stripExt(file.name),
        })
      } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')) {
        if (lower.endsWith('.csv')) {
          const text = await file.text()
          const lines = text
            .split(/\r?\n/)
            .filter((l) => l !== '')
            .map((l) => l.split(','))
          const rows: CellData[][] = lines.map((l) => l.map((cell) => ({ v: cell })))
          setParsed({
            payload: {
              target: 'sheet',
              file: file.name,
              sheets: [{ name: 'Sheet1', rows, merges: [], colw: {}, rowh: {} }],
            },
            summary: `解析完成：1 个工作表 · ${rows.length} 行 · ${
              rows[0]?.length || 0
            } 列`,
            baseName: stripExt(file.name),
          })
        } else {
          const sheets = await importWorkbook(file)
          const rows = sheets.reduce((n, s) => n + s.rows.length, 0)
          const cols = sheets.reduce((n, s) => n + (s.rows[0]?.length || 0), 0)
          setParsed({
            payload: { target: 'sheet', file: file.name, sheets },
            summary: `解析完成：${sheets.length} 个工作表 · ${rows} 行 · ${cols} 列`,
            baseName: stripExt(file.name),
          })
        }
      } else if (lower.endsWith('.txt') || lower.endsWith('.md')) {
        const text = await file.text()
        const blocks: Block[] = text.split(/\r?\n/).map((line, i) => ({
          id: 'p' + i,
          type: (/^#{1,3}\s/.test(line)
            ? line.startsWith('###')
              ? 'h3'
              : line.startsWith('##')
              ? 'h2'
              : 'h1'
            : /^[-*]\s/.test(line)
            ? 'li'
            : 'p') as Block['type'],
          runs: [{ text: line.replace(/^(#{1,3}\s|[-*]\s)/, '') }],
        }))
        setParsed({
          payload: { target: 'doc', file: file.name, blocks },
          summary: `解析完成：${blocks.length} 个段落`,
          baseName: stripExt(file.name),
        })
      } else {
        throw new Error('暂不支持该文件类型（.docx / .xlsx / .xls / .csv / .md / .txt）')
      }
      setConflictName('')
      setStage('conflict')
    } catch (e) {
      onToast('解析失败：' + (e instanceof Error ? e.message : String(e)))
      setStage('menu')
    }
  }

  /** 生成不重名的名字 */
  const uniqueName = (base: string) => {
    let n = base
    let i = 2
    while (existingNames.includes(n)) n = `${base} (${i++})`
    return n
  }

  const finishImport = async (name: string) => {
    if (!parsed) return
    setBusy(true)
    try {
      const kind: Kind = parsed.payload.target
      const d = await onCreate(name, kind)
      onImport({ id: d.id, name: d.name, kind: d.kind }, parsed.payload)
      setStage('done')
      onClose()
    } catch (e) {
      onToast('创建失败：' + (e instanceof Error ? e.message : String(e)))
      setStage('menu')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const dup = parsed ? existingNames.includes(parsed.baseName) : false

  return (
    <>
      {stage === 'converting' && (
        <div className="progress-box">
          <div className="progress-title">正在转换…</div>
          <div className="progress-sub">{fileName || '读取文件中'}</div>
        </div>
      )}

      <div className="modal-mask" onClick={busy ? undefined : onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          {stage === 'conflict' && parsed ? (
            <>
              <h3>同名文件已存在</h3>
              <div className="warn-bar">
                「{parsed.baseName}」已经在你的工作台里了。导入不会直接替换原文件内容，
                请先选择处理方式。
              </div>
              <div className="conflict-list">
                <button
                  className="conflict-item"
                  disabled={busy}
                  onClick={() => finishImport(uniqueName(parsed.baseName + '（导入）'))}
                >
                  <div className="ci-title">保留两者</div>
                  <div className="ci-sub">
                    新建「{uniqueName(parsed.baseName + '（导入）')}」，原文件不变
                  </div>
                </button>
                <button
                  className="conflict-item"
                  disabled={busy}
                  onClick={() => finishImport(parsed.baseName)}
                >
                  <div className="ci-title">重命名导入</div>
                  <div className="ci-sub">用一个新名字保存这份导入的内容</div>
                </button>
                <div className="conflict-item">
                  <div className="ci-title">自定义名称</div>
                  <div className="invite-row">
                    <input
                      value={conflictName}
                      placeholder={uniqueName(parsed.baseName)}
                      onChange={(e) => setConflictName(e.target.value)}
                    />
                    <button
                      className="btn-primary"
                      disabled={busy}
                      onClick={() =>
                        finishImport(conflictName.trim() || uniqueName(parsed.baseName))
                      }
                    >
                      确定
                    </button>
                  </div>
                </div>
              </div>
              {!dup && <p className="hint">当前工作台没有同名文件，可直接导入。</p>}
              <div className="modal-actions">
                <button className="btn-ghost" disabled={busy} onClick={() => setStage('menu')}>
                  返回
                </button>
              </div>
            </>
          ) : (
            <>
              <h3>新建或导入</h3>
              <div className="modal-grid">
                <button className="modal-option" disabled={busy} onClick={() => blank('doc')}>
                  <div className="mo-icon">▤</div>
                  <div className="mo-title">空白文档</div>
                  <div className="mo-sub">Word 形态，段落级协同</div>
                </button>
                <button className="modal-option" disabled={busy} onClick={() => blank('sheet')}>
                  <div className="mo-icon">▦</div>
                  <div className="mo-title">空白表格</div>
                  <div className="mo-sub">Excel 形态，单元格级协同</div>
                </button>
              </div>

              <label className="field-label">从模板创建</label>
              <div className="template-list">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    className="template-item"
                    disabled={busy}
                    onClick={() => useTemplate(t)}
                  >
                    <span className={'mo-icon ' + t.kind}>{t.kind === 'doc' ? '▤' : '▦'}</span>
                    <span className="member-meta">
                      <span className="member-name">{t.title}</span>
                      <span className="member-sub">{t.sub}</span>
                    </span>
                  </button>
                ))}
              </div>

              <label className="field-label">导入本地文件</label>
              <div
                className="upload-box"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  const f = e.dataTransfer.files?.[0]
                  if (f) parseFile(f)
                }}
              >
                把 .docx / .xlsx 拖到这里，或点击选择文件
                <span className="mo-sub">支持 .docx / .xlsx / .xls / .csv / .md / .txt</span>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".docx,.xlsx,.xls,.csv,.md,.txt"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) parseFile(f)
                  e.target.value = ''
                }}
              />
              {parsed && stage === 'done' && <p className="hint">{parsed.summary}</p>}
              <div className="modal-actions">
                <button className="btn-ghost" onClick={onClose} disabled={busy}>
                  取消
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {dragging && (
        <div className="drop-mask">
          <div className="drop-box">
            <div style={{ fontSize: 32 }}>⇩</div>
            <div className="db-title">松手即可导入</div>
            <div className="db-sub">.docx 转为文档 · .xlsx 转为表格</div>
          </div>
        </div>
      )}
    </>
  )
}
