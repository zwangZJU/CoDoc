import { useEffect, useMemo, useRef, useState } from 'react'
import type { WebsocketProvider } from 'y-websocket'
import type { RemotePeer } from '../store/useAwareness'
import type { LocalUser } from '../store/user'
import { colorOf } from '../store/user'
import { indexToCol } from './refs'
import { evalFormula } from './formula'
import { formatByNumFmt } from './numfmt'
import {
  DEFAULT_COL_W,
  DEFAULT_ROW_H,
  type BorderSide,
  type CellData,
  type CellStyle,
  type SheetApi,
} from './useSheet'
import SheetToolbar, {
  type BorderPaintState,
  type FormatPainterState,
  type Range,
} from './SheetToolbar'
import FindPanel from './FindPanel'
import AIPanel from './AIPanel'
import CommentPanel from './CommentPanel'
import { Ico } from './sheetIcons'

interface Props {
  sheet: SheetApi
  setActiveSheet: (n: string) => void
  peers: RemotePeer[]
  user: LocalUser
  provider: WebsocketProvider
  jumpTo?: { r: number; c: number } | null
  /** 只读查看：禁止编辑与工具条操作（仍可看他人光标） */
  readOnly?: boolean
  /** 当前文档 id（透传给右侧智能助手，用于按文档隔离 Agent 会话） */
  docId?: string
}

/** 一行文字占的高度（13px 字号 × 1.4 行高），用于编辑态的垂直居中 */
const CELL_TEXT_H = 18
/** 网格尺寸令牌（与 tokens.css 保持一致，冻结定位需要具体像素） */
const HEADER_H = 24
const ROWNUM_W = 44

export default function SheetEditor({
  sheet,
  setActiveSheet,
  peers,
  user,
  provider,
  jumpTo,
  readOnly = false,
  docId,
}: Props) {
  const {
    rows,
    rowCount,
    colCount,
    sheetNames,
    activeSheet,
    addSheet,
    setCellValue,
    getCellRaw,
    applyStyleRange,
    applyBorder,
    mergeCells,
    unmergeCells,
    addRow,
    addCol,
    setColWidth,
    setRowHeight,
    colw,
    rowh,
    frozen,
    comments,
    undo,
    redo,
    canUndo,
    canRedo,
  } = sheet

  const [sel, setSel] = useState<{ r: number; c: number }>({ r: 0, c: 0 })
  const [selStart, setSelStart] = useState<{ r: number; c: number }>({ r: 0, c: 0 })
  const [dragging, setDragging] = useState(false)
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const [draft, setDraft] = useState('')
  const [resizing, setResizing] = useState<{ type: 'col' | 'row'; idx: number } | null>(null)
  const [resizePreview, setResizePreview] = useState<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{
    type: 'row' | 'col'
    idx: number
    x: number
    y: number
  } | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // ---- 新工具栏相关状态 ----
  const [findOpen, setFindOpen] = useState(false)
  const [sidePanel, setSidePanel] = useState<'none' | 'ai' | 'comment'>('none')
  const [painter, setPainter] = useState<FormatPainterState>({ style: undefined, armed: false, multi: false })
  const [borderPaint, setBorderPaint] = useState<BorderPaintState>({
    mode: 'all',
    w: 1,
    c: '#5B6472',
    drawing: false,
  })

  const gridRef = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<number | null>(null)
  /** 一次落笔动作：格式刷 / 绘制边框（在 mouseup 时结算） */
  const paintRef = useRef<'format' | 'border' | null>(null)

  const notify = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2400)
  }

  // 选中区域
  const range: Range = useMemo(() => {
    const r1 = Math.min(sel.r, selStart.r)
    const r2 = Math.max(sel.r, selStart.r)
    const c1 = Math.min(sel.c, selStart.c)
    const c2 = Math.max(sel.c, selStart.c)
    return { r1, r2, c1, c2 }
  }, [sel, selStart])

  // 落笔结算（格式刷 / 绘制边框）发生在 window mouseup 里，
  // 那时事件监听器可能是上一帧注册的，闭包里的 range 会滞后 → 统一走 ref 取最新选区
  const rangeRef = useRef<Range>(range)
  rangeRef.current = range

  const curStyle = rows[sel.r]?.[sel.c]?.s
  const selRef =
    range.r1 === range.r2 && range.c1 === range.c2
      ? indexToCol(sel.c) + (sel.r + 1)
      : `${indexToCol(range.c1)}${range.r1 + 1}:${indexToCol(range.c2)}${range.r2 + 1}`

  // 跳转
  useEffect(() => {
    if (jumpTo) {
      setSel(jumpTo)
      setSelStart(jumpTo)
    }
  }, [jumpTo])

  // 当前工作表被删除时，自动切到剩下的第一张
  useEffect(() => {
    if (sheetNames.length && !sheetNames.includes(activeSheet)) {
      setActiveSheet(sheetNames[0])
    }
  }, [sheetNames, activeSheet, setActiveSheet])

  // 拖拽 / 落笔结束
  useEffect(() => {
    const up = () => {
      setDragging(false)
      if (paintRef.current) {
        const mode = paintRef.current
        paintRef.current = null
        // 用最新的选区结算（闭包里的 range 会滞后一帧，所以延后取 ref 中的值）
        window.setTimeout(() => {
          if (mode === 'format') settleFormatPaint()
          else settleBorderPaint()
        }, 0)
      }
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  })

  // 关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctxMenu])

  // 广播选区/编辑位置
  useEffect(() => {
    provider.awareness.setLocalStateField('selection', sel)
  }, [sel, provider])
  useEffect(() => {
    provider.awareness.setLocalStateField('editing', editing)
  }, [editing, provider])

  // 合并占用图（key 统一用 "r:c"，与单元格渲染时的 key 保持一致）
  const mergeMap = useMemo(() => {
    const anchorOf = new Map<string, { rs: number; cs: number }>()
    const covered = new Set<string>()
    for (const m of sheet.merges) {
      anchorOf.set(m.r + ':' + m.c, { rs: m.rs, cs: m.cs })
      for (let r = m.r; r < m.r + m.rs; r++)
        for (let c = m.c; c < m.c + m.cs; c++)
          if (!(r === m.r && c === m.c)) covered.add(r + ':' + c)
    }
    return { anchorOf, covered }
  }, [sheet.merges])

  // 他人光标聚合
  const othersByCell = useMemo(() => {
    const map = new Map<string, RemotePeer[]>()
    for (const p of peers) {
      const cell = p.editing || p.selection
      if (!cell) continue
      const key = cell.r + ':' + cell.c
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(p)
    }
    return map
  }, [peers])

  // 显示值：公式先求值，再套用单元格的数字格式
  const display = (cell: CellData) => {
    const raw = cell.v.startsWith('=') ? evalFormula(cell.v, getCellRaw) : cell.v
    const fmt = cell.s?.numfmt
    if (!fmt || raw === '') return raw
    return formatByNumFmt(raw, fmt)
  }

  // ---- 编辑 ----
  const commit = (next?: { r: number; c: number }) => {
    if (editing) {
      setCellValue(editing.r, editing.c, draft)
      setEditing(null)
      if (next) setSel(next)
    }
  }

  const startEdit = (r: number, c: number, initial?: string) => {
    if (readOnly) return
    setSel({ r, c })
    setSelStart({ r, c })
    setDraft(initial !== undefined ? initial : rows[r]?.[c]?.v ?? '')
    setEditing({ r, c })
  }

  // ---- 格式刷落笔 / 绘制边框落笔 ----
  const settleFormatPaint = () => {
    if (!painter.armed) return
    const r = rangeRef.current
    sheet.applyStyleObject(r.r1, r.c1, r.r2, r.c2, painter.style, 'replace')
    notify('已套用格式')
    if (!painter.multi) setPainter((p) => ({ ...p, armed: false }))
  }
  const settleBorderPaint = () => {
    if (!borderPaint.drawing) return
    const r = rangeRef.current
    const b: BorderSide | null =
      borderPaint.mode === 'clear' ? null : { w: borderPaint.w, c: borderPaint.c }
    applyBorder(r.r1, r.c1, r.r2, r.c2, borderPaint.mode, b)
  }

  // ---- 键盘 ----
  const onGridKey = (e: React.KeyboardEvent) => {
    if (readOnly) return
    if (editing) {
      if (e.key === 'Enter' && e.altKey) {
        e.preventDefault()
        setDraft((d) => d + '\n')
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        commit({ r: Math.min(rowCount - 1, editing.r + 1), c: editing.c })
      } else if (e.key === 'Tab') {
        e.preventDefault()
        commit({ r: editing.r, c: Math.min(colCount - 1, editing.c + 1) })
      } else if (e.key === 'Escape') {
        setEditing(null)
      }
      return
    }

    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      setFindOpen(true)
      return
    }
    if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault()
      const k = e.key.toLowerCase() as 'b' | 'i' | 'u'
      const key = k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline'
      applyStyleRange(range.r1, range.c1, range.r2, range.c2, { [key]: !curStyle?.[key] } as any)
      return
    }
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      void copySelection()
      return
    }
    if (mod && e.key.toLowerCase() === 'x') {
      e.preventDefault()
      void copySelection().then(() => {
        sheet.clearRange(range.r1, range.c1, range.r2, range.c2, 'content')
        notify('已剪切')
      })
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      sheet.clearRange(range.r1, range.c1, range.r2, range.c2, 'content')
      return
    }
    if (e.key === 'Escape') {
      if (painter.armed) setPainter((p) => ({ ...p, armed: false }))
      if (borderPaint.drawing) setBorderPaint((b) => ({ ...b, drawing: false }))
      if (sidePanel !== 'none') setSidePanel('none')
      if (findOpen) setFindOpen(false)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      startEdit(sel.r, sel.c)
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault()
      const d = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      }[e.key] as number[]
      const next = {
        r: Math.max(0, Math.min(rowCount - 1, sel.r + d[0])),
        c: Math.max(0, Math.min(colCount - 1, sel.c + d[1])),
      }
      setSel(next)
      setSelStart(next)
    } else if (e.key.length === 1 && !mod) {
      startEdit(sel.r, sel.c, e.key)
    }
  }

  // ---- 剪贴板 ----
  const copySelection = async () => {
    const tsv = sheet.rangeToTsv(range.r1, range.c1, range.r2, range.c2)
    try {
      await navigator.clipboard.writeText(tsv)
      notify('已复制所选内容')
    } catch {
      notify('浏览器未授权剪贴板，请改用 Ctrl+C')
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    if (readOnly) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    const r = sheet.pasteTsv(sel.r, sel.c, text)
    notify(`已粘贴 ${r.rows} 行 × ${r.cols} 列`)
  }

  // ---- 工具条回调 ----
  const insertFunction = (kind: 'SUM' | 'AVERAGE' | 'COUNT' | 'MAX' | 'MIN') => {
    const c = sel.c
    const r = sel.r
    // 向上找连续数字区域
    let top = r - 1
    const isNum = (ref: string) => {
      const v = getCellRaw(ref)
      return v !== '' && !isNaN(parseFloat(v))
    }
    while (top >= 0 && isNum(indexToCol(c) + (top + 1))) top--
    const rangeStr =
      top + 1 < r ? `${indexToCol(c)}${top + 2}:${indexToCol(c)}${r}` : `${indexToCol(c)}1:${indexToCol(c)}${r}`
    startEdit(r, c, `=${kind}(${rangeStr})`)
  }

  const sortByCol = (col: number, dir: 'asc' | 'desc') => {
    const single = range.r1 === range.r2 && range.c1 === range.c2
    if (single) {
      // 未框选数据区域时，按整列数据区自动扩展
      let last = sel.r
      while (last + 1 < rowCount && (rows[last + 1]?.[sel.c]?.v ?? '') !== '') last++
      let first = 0
      while (first < rowCount && (rows[first]?.[sel.c]?.v ?? '') === '') first++
      sheet.sortRange(Math.max(0, first), Math.max(0, col - 1), last, Math.max(col, colCount - 1), col, dir)
    } else {
      sheet.sortRange(range.r1, range.c1, range.r2, range.c2, col, dir)
    }
    notify(`已按 ${indexToCol(col)} 列${dir === 'asc' ? '升序' : '降序'}排列`)
  }

  const autoFitCol = (c: number) => {
    let w = 48
    for (let r = 0; r < rowCount; r++) {
      const cell = rows[r]?.[c]
      if (!cell?.v) continue
      const txt = cell.v.startsWith('=') ? '' : cell.v
      if (!txt) continue
      const len = [...txt].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)
      const size = cell.s?.size ?? 13
      w = Math.max(w, len * size * 0.62 + 20)
    }
    setColWidth(c, Math.min(360, Math.round(w)))
    notify(`${indexToCol(c)} 列宽已自适应`)
  }

  // ---- 行列宽高拖拽 ----
  const startColResize = (c: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const base = colw[c] ?? DEFAULT_COL_W
    const move = (ev: MouseEvent) =>
      setResizePreview(Math.max(28, base + ev.clientX - startX))
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const w = Math.max(28, base + ev.clientX - startX)
      setResizePreview(null)
      setResizing(null)
      setColWidth(c, w)
    }
    setResizing({ type: 'col', idx: c })
    setResizePreview(base)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const startRowResize = (r: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const base = rowh[r] ?? DEFAULT_ROW_H
    const move = (ev: MouseEvent) =>
      setResizePreview(Math.max(20, base + ev.clientY - startY))
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const h = Math.max(20, base + ev.clientY - startY)
      setResizePreview(null)
      setResizing(null)
      setRowHeight(r, h)
    }
    setResizing({ type: 'row', idx: r })
    setResizePreview(base)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const colWidth = (c: number) =>
    resizing && resizing.type === 'col' && resizing.idx === c
      ? resizePreview!
      : colw[c] ?? DEFAULT_COL_W
  const rowHeight = (r: number) =>
    resizing && resizing.type === 'row' && resizing.idx === r
      ? resizePreview!
      : rowh[r] ?? DEFAULT_ROW_H

  const mergedAtSel =
    range.r1 === range.r2 && range.c1 === range.c2 && mergeMap.anchorOf.has(sel.r + ':' + sel.c)
  const fzRows = Math.min(frozen.rows, rowCount)
  const fzCols = Math.min(frozen.cols, colCount)
  const commentCount = Object.keys(comments).length

  return (
    <div className="sheet-wrap">
      <div
        className={
          'sheet' +
          (readOnly ? ' readonly' : '') +
          (painter.armed ? ' painting' : '') +
          (borderPaint.drawing ? ' drawing-border' : '')
        }
      >
        {/* 工具条：单行（腾讯文档式布局） */}
        <SheetToolbar
          sheet={sheet}
          range={range}
          sel={sel}
          curStyle={curStyle}
          readOnly={readOnly}
          mergedAtSel={mergedAtSel}
          painter={painter}
          onPainter={setPainter}
          borderPaint={borderPaint}
          onBorderPaint={setBorderPaint}
          onFind={() => setFindOpen((v) => !v)}
          sidePanel={sidePanel}
          onSidePanel={setSidePanel}
          commentCount={commentCount}
          onInsertFunction={insertFunction}
          onNotify={notify}
          onJump={(r, c) => {
            setSel({ r, c })
            setSelStart({ r, c })
            gridRef.current?.focus()
          }}
          onSortByCol={sortByCol}
          onAutoFitCol={autoFitCol}
          frozen={frozen}
        />

        {/* 查找和替换 */}
        {findOpen && (
          <FindPanel
            sheet={sheet}
            readOnly={readOnly}
            onClose={() => setFindOpen(false)}
            onJump={(r, c) => {
              setSel({ r, c })
              setSelStart({ r, c })
            }}
            onNotify={notify}
          />
        )}

        {/* 公式栏 */}
        <div className="formula-bar">
          <span className="cell-ref">{indexToCol(sel.c) + (sel.r + 1)}</span>
          <span className="formula-sep" />
          <Ico n="prompt" size={13} className="formula-fx" />
          <input
            className="formula-input"
            value={editing ? draft : rows[sel.r]?.[sel.c]?.v ?? ''}
            placeholder="输入内容或 =SUM(A1:A10)"
            onChange={(e) => {
              if (editing) setDraft(e.target.value)
              else startEdit(sel.r, sel.c, e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit({ r: Math.min(rowCount - 1, sel.r + 1), c: sel.c })
              } else if (e.key === 'Escape') setEditing(null)
            }}
          />
        </div>

        {/* 网格 */}
        <div
          className="grid-scroll"
          ref={gridRef}
          tabIndex={0}
          onKeyDown={onGridKey}
          onPaste={onPaste}
        >
          <table className="grid">
            <thead>
              <tr>
                <th className="corner" />
                {Array.from({ length: colCount }).map((_, c) => (
                  <th
                    key={c}
                    className={
                      'colhead' +
                      (sel.c === c ? ' head-active' : '') +
                      (c < fzCols ? ' frozen-head' : '') +
                      (c === fzCols - 1 ? ' freeze-col-shadow' : '')
                    }
                    style={{ width: colWidth(c) }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCtxMenu({ type: 'col', idx: c, x: e.clientX, y: e.clientY })
                    }}
                  >
                    {indexToCol(c)}
                    <div className="col-resize" onMouseDown={(e) => startColResize(c, e)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  <th
                    className={'rowhead' + (sel.r === r ? ' head-active' : '')}
                    style={{ height: rowHeight(r) }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCtxMenu({ type: 'row', idx: r, x: e.clientX, y: e.clientY })
                    }}
                  >
                    {r + 1}
                    <div className="row-resize" onMouseDown={(e) => startRowResize(r, e)} />
                  </th>
                  {row.map((cell, c) => {
                    const key = r + ':' + c
                    if (mergeMap.covered.has(key)) return null
                    const m = mergeMap.anchorOf.get(r + ':' + c)
                    const others = othersByCell.get(key) || []
                    const isSel = sel.r === r && sel.c === c
                    const inRange =
                      r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2
                    const remote = others.length ? others[0] : null
                    const remoteColor = remote ? colorOf(remote.user!.colorIndex) : null
                    const st = cell.s
                    const cellStyle: React.CSSProperties = {}
                    if (st?.font) cellStyle.fontFamily = st.font
                    if (st?.size) cellStyle.fontSize = st.size + 'px'
                    if (st?.bold) cellStyle.fontWeight = 700
                    if (st?.italic) cellStyle.fontStyle = 'italic'
                    if (st?.underline || st?.strike)
                      cellStyle.textDecoration = [
                        st.underline ? 'underline' : '',
                        st.strike ? 'line-through' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                    if (st?.align) cellStyle.textAlign = st.align
                    if (st?.valign) cellStyle.verticalAlign = st.valign
                    if (st?.bg) cellStyle.background = st.bg
                    if (st?.color) cellStyle.color = st.color
                    if (st?.wrap) {
                      cellStyle.whiteSpace = 'normal'
                      cellStyle.wordBreak = 'break-word'
                      cellStyle.height = 'auto'
                    }
                    const multi = !!st?.wrap || (cell.v ? cell.v.includes('\n') : false)
                    if (multi) {
                      cellStyle.whiteSpace = 'pre-wrap'
                      cellStyle.wordBreak = 'break-word'
                      cellStyle.height = 'auto'
                    }
                    // 冻结行列：sticky 需要不透明底色，否则滚动时透出下层
                    const fRow = r < fzRows
                    const fCol = c < fzCols
                    if (fRow || fCol) {
                      cellStyle.position = 'sticky'
                      if (fRow) cellStyle.top = HEADER_H
                      if (fCol) cellStyle.left = ROWNUM_W
                      cellStyle.zIndex = fRow && fCol ? 8 : fRow ? 6 : 5
                      cellStyle.background =
                        st?.bg || (inRange && !isSel ? 'var(--brand-tint-10)' : 'var(--bg-canvas)')
                    }
                    const b = st?.border
                    const drawB = (
                      side: 'Top' | 'Left' | 'Bottom' | 'Right',
                      k: 't' | 'l' | 'b' | 'r',
                      edge: boolean
                    ) => {
                      const sb = b?.[k]
                      if (sb) (cellStyle as any)['border' + side] = `${sb.w}px ${sb.s || 'solid'} ${sb.c}`
                      else if (edge || side === 'Top' || side === 'Left')
                        (cellStyle as any)['border' + side] = `1px solid var(--grid-line)`
                    }
                    drawB('Top', 't', r === 0)
                    drawB('Left', 'l', c === 0)
                    drawB('Bottom', 'b', r === rowCount - 1)
                    drawB('Right', 'r', c === colCount - 1)
                    const comment = comments[r + ',' + c]
                    const link = st?.link
                    const hasComment = !!comment
                    return (
                      <td
                        key={c}
                        className={
                          'cell' +
                          (isSel ? ' sel' : '') +
                          (inRange && !isSel ? ' range' : '') +
                          (remote ? ' remote' : '') +
                          (remoteColor ? ' has-owner' : '') +
                          (st?.wrap ? ' wrap' : '') +
                          (hasComment ? ' has-comment' : '') +
                          (link ? ' has-link' : '') +
                          (c === fzCols - 1 ? ' freeze-col-shadow' : '')
                        }
                        style={{
                          ...cellStyle,
                          width: colWidth(c),
                          height: st?.wrap ? undefined : rowHeight(r),
                          minWidth: colWidth(c),
                        }}
                        colSpan={m ? m.cs : undefined}
                        rowSpan={m ? m.rs : undefined}
                        title={comment ? `${comment.author}：${comment.text}` : undefined}
                        onMouseDown={(e) => {
                          // 编辑态：点击当前编辑框内部（textarea/input）时放行
                          if (editing && editing.r === r && editing.c === c) {
                            const t = e.target as HTMLElement
                            if (t.closest('textarea') || t.closest('input')) return
                          }
                          e.preventDefault()
                          gridRef.current?.focus()
                          if (readOnly) return
                          // Ctrl + 单击：打开单元格里的链接
                          if (link && (e.ctrlKey || e.metaKey)) {
                            window.open(link, '_blank', 'noopener')
                            return
                          }
                          // 格式刷 / 绘制边框：按下即开始框选，松手时落笔
                          if (painter.armed || borderPaint.drawing) {
                            paintRef.current = painter.armed ? 'format' : 'border'
                            setSelStart({ r, c })
                            setSel({ r, c })
                            setDragging(true)
                            return
                          }
                          if (e.detail === 2) {
                            startEdit(r, c)
                            return
                          }
                          setSelStart({ r, c })
                          setSel({ r, c })
                          setDragging(true)
                        }}
                        onMouseEnter={() => {
                          if (dragging) setSel({ r, c })
                        }}
                      >
                        {editing && editing.r === r && editing.c === c ? (
                          <textarea
                            className="cell-edit"
                            autoFocus
                            style={{
                              textAlign: st?.align || 'left',
                              paddingTop: Math.max(0, Math.round((rowHeight(r) - CELL_TEXT_H) / 2)),
                            }}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => commit()}
                          />
                        ) : (
                          <span
                            className={'cell-text' + (link ? ' cell-link' : '')}
                            style={multi ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } : undefined}
                          >
                            {display(cell)}
                          </span>
                        )}
                        {hasComment && (
                          <span className="cell-comment-tri" title={`${comment!.author}：${comment!.text}`} />
                        )}
                        {remoteColor && (
                          <span className="cell-owner" style={{ background: remoteColor.ink }}>
                            {remote!.user!.name}
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 行列右键菜单 */}
        {ctxMenu && (
          <div
            className="ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {ctxMenu.type === 'row' ? (
              <>
                <button onClick={() => { addRow(ctxMenu.idx); setCtxMenu(null) }}>在上方插入行</button>
                <button onClick={() => { addRow(ctxMenu.idx + 1); setCtxMenu(null) }}>在下方插入行</button>
                <button onClick={() => { sheet.clearRange(ctxMenu.idx, 0, ctxMenu.idx, colCount - 1, 'content'); setCtxMenu(null) }}>清除本行内容</button>
                <button onClick={() => { sheet.applyBorder(ctxMenu.idx, 0, ctxMenu.idx, colCount - 1, 'bottom', { w: 1, c: '#5B6472' }); setCtxMenu(null) }}>本行加下边框</button>
                <button className="danger" onClick={() => { sheet.deleteRow(ctxMenu.idx); setCtxMenu(null) }}>删除此行</button>
              </>
            ) : (
              <>
                <button onClick={() => { addCol(ctxMenu.idx); setCtxMenu(null) }}>在左侧插入列</button>
                <button onClick={() => { addCol(ctxMenu.idx + 1); setCtxMenu(null) }}>在右侧插入列</button>
                <button onClick={() => { autoFitCol(ctxMenu.idx); setCtxMenu(null) }}>本列自适应宽度</button>
                <button onClick={() => { sortByCol(ctxMenu.idx, 'asc'); setCtxMenu(null) }}>本列升序排列</button>
                <button onClick={() => { sortByCol(ctxMenu.idx, 'desc'); setCtxMenu(null) }}>本列降序排列</button>
                <button className="danger" onClick={() => { sheet.deleteCol(ctxMenu.idx); setCtxMenu(null) }}>删除此列</button>
              </>
            )}
          </div>
        )}

        {/* sheet 标签栏 */}
        <div className="sheet-tabs">
          {sheetNames.map((name) => (
            <button
              key={name}
              className={'sheet-tab' + (name === activeSheet ? ' active' : '')}
              onClick={() => setActiveSheet(name)}
              onDoubleClick={() => {
                const next = window.prompt('重命名工作表', name)
                if (next === null) return
                if (!sheet.renameSheet(name, next)) notify('重命名失败：名称为空或已存在')
                else notify('工作表已重命名')
              }}
              title="双击可重命名"
            >
              {name}
            </button>
          ))}
          <button
            className="sheet-tab add"
            onClick={() => {
              const n = addSheet()
              setActiveSheet(n)
            }}
          >
            +
          </button>
        </div>

        {/* 状态提示 */}
        {toast && (
          <div className="sheet-toast" key={toast}>
            {toast}
          </div>
        )}
      </div>

      {sidePanel === 'ai' && (
        <AIPanel
          sheet={sheet}
          range={range}
          selRef={selRef}
          docId={docId}
          onClose={() => setSidePanel('none')}
          onNotify={notify}
        />
      )}
      {sidePanel === 'comment' && (
        <CommentPanel
          sheet={sheet}
          sel={sel}
          selRef={selRef}
          selfName={user.name}
          readOnly={readOnly}
          onClose={() => setSidePanel('none')}
          onJump={(r, c) => {
            setSel({ r, c })
            setSelStart({ r, c })
            gridRef.current?.focus()
          }}
          onNotify={notify}
        />
      )}
    </div>
  )
}
