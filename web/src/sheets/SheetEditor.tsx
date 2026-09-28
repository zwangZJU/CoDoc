import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

/**
 * 网格尺寸令牌（与 tokens.css 保持一致）。
 * 全局 border-box 下表头总尺寸 = 令牌值；冻结吸附偏移仍以
 * 角标 th 实测为准（见 fzOffset），令牌值仅作初值兜底。
 */
const HEADER_H = 24
const ROWNUM_W = 44

/**
 * 预览态与编辑态**共用**的文本排版。
 * 字体 / 字号 / 字重 / 颜色 / 水平对齐 / 行高 / 换行策略全部取自同一处，
 * 保证双击进入编辑时文字不会跳位（尤其是水平、垂直都居中的单元格）。
 */
function textStyleOf(st: CellStyle | undefined, multi: boolean): React.CSSProperties {
  const s: React.CSSProperties = {
    lineHeight: 'var(--grid-line-height)',
    textAlign: st?.align || 'left',
  }
  if (st?.font) s.fontFamily = st.font
  if (st?.size) s.fontSize = st.size + 'px'
  if (st?.bold) s.fontWeight = 700
  if (st?.italic) s.fontStyle = 'italic'
  if (st?.underline || st?.strike) {
    s.textDecoration = [st.underline ? 'underline' : '', st.strike ? 'line-through' : '']
      .filter(Boolean)
      .join(' ')
  }
  if (st?.color) s.color = st.color
  if (multi) {
    s.whiteSpace = 'pre-wrap'
    s.wordBreak = 'break-word'
  } else {
    // 单行：与预览态一致不折行，超长的部分横向滚动（wrap="off"）
    s.whiteSpace = 'pre'
  }
  return s
}

/** 编辑框横向溢出的上限：再长的文字也不无限拉宽，超出部分裁掉 */
const EDIT_MAX_W = 640

/**
 * 文本测量：用一个脱离文档流的隐藏 span（与单元格同字体 / 字号），
 * 量出「最长一行」文字本身的像素宽（不含内边距）。
 * 只用来决定**编辑框**该画多宽，绝不参与列宽计算。
 */
let _textProbe: HTMLSpanElement | null = null
function measureTextWidth(
  text: string,
  fontFamily: string,
  fontSize: string,
  fontWeight: string,
  fontStyle: string
): number {
  if (typeof document === 'undefined') return 0
  if (!_textProbe) {
    _textProbe = document.createElement('span')
    _textProbe.style.cssText =
      'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre;' +
      'padding:0;border:0;display:inline-block'
    document.body.appendChild(_textProbe)
  }
  const p = _textProbe
  p.style.fontFamily = fontFamily
  p.style.fontSize = fontSize
  p.style.fontWeight = fontWeight
  p.style.fontStyle = fontStyle
  let max = 0
  for (const line of (text || ' ').split('\n')) {
    p.textContent = line.length ? line : ' '
    const w = p.getBoundingClientRect().width
    if (w > max) max = w
  }
  return max
}

interface CellEditorProps {
  value: string
  st?: CellStyle
  multi: boolean
  /** 单元格实际底色：编辑框沿用，避免进入编辑时底色跳变 */
  bg: string
  onChange: (v: string) => void
  onBlur: () => void
}

/**
 * 单元格编辑框。
 * 垂直对齐交给外层 flex（top / middle / bottom → flex-start / center / flex-end），
 * 不再用「算 paddingTop」的老办法——那条路在字号变化、多行、底部对齐时都会算错。
 */
function CellEditor({ value, st, multi, bg, onChange, onBlur }: CellEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  /**
   * 尺寸同步：
   *  - 默认贴着单元格的内容区（top/bottom 都归零），高度由 CSS 撑满，
   *    垂直居中交给 flex，和预览态的 vertical-align: middle 落在同一位置；
   *  - 内容比单元格高（多行 / 自动换行）时改成「顶部不动、向下长」，
   *    溢出部分盖在下方单元格之上，不撑动行高；
   *  - 内容比单元格宽（单行长文本）时改成「朝对齐方向溢出」，
   *    盖在右侧（右对齐则左侧、居中则两侧）邻居之上，不撑动列宽。
   */
  useLayoutEffect(() => {
    const ta = taRef.current
    const wrap = wrapRef.current
    if (!ta || !wrap) return
    const td = wrap.parentElement as HTMLElement | null

    if (td) {
      const cs = getComputedStyle(td)
      const padL = parseFloat(cs.paddingLeft) || 0
      const padR = parseFloat(cs.paddingRight) || 0

      // ⓪ 左右内边距必须**等于单元格 td 的实际 padding**，否则一进编辑文字就横向跳位。
      //    坑：.cell 上那句 padding: 0 var(--grid-cell-px) 被优先级更高的
      //    `.grid td { padding: 0 }` 吃掉了（0,1,1 > 0,1,0），预览态实际是 0；
      //    而编辑框容器以前写死 --grid-cell-px（8px），于是双击进编辑文字右移 8px。
      //    改成运行时跟随 td 的计算值：两边同源，以后再改内边距也不会漂。
      wrap.style.paddingLeft = padL + 'px'
      wrap.style.paddingRight = padR + 'px'

      // ① 再定宽度：多行靠折行消化长文本，折行结果取决于宽度，
      //    宽度没定就量高度会拿到上一帧的错误值（单行 ↔ 多行切换时会闪一下）。
      if (multi) {
        // 自动换行 / 多行：宽度锁死在单元格上
        wrap.style.left = ''
        wrap.style.right = ''
        wrap.style.width = ''
        ta.style.width = '100%'
      } else {
        const innerW = Math.max(0, td.clientWidth - padL - padR)
        const textW = measureTextWidth(
          value,
          cs.fontFamily || 'var(--font-sans)',
          cs.fontSize || '13px',
          cs.fontWeight || '400',
          cs.fontStyle || 'normal'
        )
        // 单行：编辑框自己变宽，列宽不动
        const w = Math.min(EDIT_MAX_W, Math.max(innerW, Math.ceil(textW) + 2))
        ta.style.width = w + 'px'
        // wrap 是 border-box，宽度要把左右内边距一起算上
        wrap.style.width = w + padL + padR + 'px'
        // 按对齐方向决定往哪边长，保证文字起始位置与预览态不跳位
        const align = st?.align || 'left'
        if (align === 'right') {
          wrap.style.left = 'auto'
          wrap.style.right = '0'
        } else if (align === 'center') {
          wrap.style.left = `${-(w - innerW) / 2}px`
          wrap.style.right = 'auto'
        } else {
          wrap.style.left = '0'
          wrap.style.right = 'auto'
        }
      }
    }

    // ② 再量高度（rows=1，textarea 的 auto 高度就是一行，scrollHeight 量得准）
    ta.style.height = 'auto'
    const h = ta.scrollHeight
    ta.style.height = h + 'px'
    const boxH = td ? td.clientHeight : 0
    if (boxH && h > boxH) {
      // 内容比单元格高：顶部不动、向下长，盖在下方单元格之上，不撑动行高
      wrap.style.bottom = 'auto'
      wrap.style.height = h + 'px'
    } else {
      // 高度交回 CSS（铺满单元格），垂直居中由 flex 负责
      wrap.style.bottom = '0'
      wrap.style.height = ''
    }
  }, [value, multi, st?.size, st?.wrap, st?.align, st?.font, st?.bold, st?.italic])

  // 进入编辑：光标落到末尾（与 Excel 双击一致）
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    const end = ta.value.length
    try {
      ta.setSelectionRange(end, end)
    } catch {
      /* 某些浏览器在受控更新前设置会抛错，忽略即可 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const justify =
    st?.valign === 'top' ? 'flex-start' : st?.valign === 'bottom' ? 'flex-end' : 'center'

  return (
    <div className="cell-edit-wrap" ref={wrapRef} style={{ justifyContent: justify, background: bg }}>
      <textarea
        ref={taRef}
        className="cell-edit"
        /**
         * 关键：必须显式 rows={1}。
         * textarea 的 rows 默认值是 2，height:auto 时它的盒子天生就是「两行高」，
         * 于是下面量出来的 scrollHeight 恒等于两行而不是一行 →
         * 单行单元格一进编辑就被撑成两行高的框、文字顶到上边沿（位置跳变）。
         * 锁成 1 行后，scrollHeight = max(一行高, 内容高)，单行/多行都量得准。
         */
        rows={1}
        // 单行模式关掉软换行：与预览态的「不折行 + 省略号」保持同一套视觉
        wrap={multi ? 'soft' : 'off'}
        style={textStyleOf(st, multi)}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
    </div>
  )
}

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

  /**
   * 冻结行列的吸附偏移 = 表头实际渲染尺寸。
   * 初值取尺寸令牌（全局 border-box 下表头总尺寸即令牌值），
   * 挂载后用角标 th 实测校准（ResizeObserver 持续响应，
   * 避免挂载瞬间布局未稳定测到脏值，也兼容以后令牌/盒模型调整）。
   * 通过 CSS 变量 --fz-top / --fz-left 下发给冻结单元格和 th.frozen-head。
   */
  const [fzOffset, setFzOffset] = useState({ top: HEADER_H, left: ROWNUM_W })
  useLayoutEffect(() => {
    const corner = gridRef.current?.querySelector<HTMLElement>('.corner')
    if (!corner) return
    const apply = () => {
      const h = corner.offsetHeight
      const w = corner.offsetWidth
      if (h > 0 && w > 0) {
        setFzOffset((prev) => (prev.top === h && prev.left === w ? prev : { top: h, left: w }))
      }
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(corner)
    return () => ro.disconnect()
  }, [])

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
    // 进入编辑前把单元格滚到完整可见：贴着表头/行号列的半遮单元格，
    // 编辑框上沿/左沿会被 sticky 表头挡住（Excel 同款行为）
    scrollCellIntoView(r, c)
  }

  /** 把 (r,c) 单元格滚动到 sticky 表头与行号列以内完整可见 */
  const scrollCellIntoView = (r: number, c: number) => {
    const sc = gridRef.current
    if (!sc) return
    const td = sc.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`)
    if (!td) return
    const rect = td.getBoundingClientRect()
    const box = sc.getBoundingClientRect()
    const pad = 1
    if (rect.top < box.top + fzOffset.top) {
      sc.scrollTop += rect.top - box.top - fzOffset.top - pad
    } else if (rect.bottom > box.bottom) {
      sc.scrollTop += rect.bottom - box.bottom + pad
    }
    if (rect.left < box.left + fzOffset.left) {
      sc.scrollLeft += rect.left - box.left - fzOffset.left - pad
    } else if (rect.right > box.right) {
      sc.scrollLeft += rect.right - box.right + pad
    }
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
      // 单元格内换行：Alt+Enter / Shift+Enter（普通 Enter 仍是提交并下移）
      if (e.key === 'Enter' && (e.altKey || e.shiftKey)) {
        e.preventDefault()
        setDraft((d) => d + '\n')
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        // 在最后一行按回车：自动补一行，表格可以一直往下写
        if (editing.r === rowCount - 1) addRow(rowCount)
        commit({ r: Math.min(rowCount, editing.r + 1), c: editing.c })
      } else if (e.key === 'Tab') {
        e.preventDefault()
        // 在最后一列按 Tab：自动补一列
        if (editing.c === colCount - 1) addCol(colCount)
        commit({
          r: editing.r,
          c: Math.min(colCount, e.shiftKey ? Math.max(0, editing.c - 1) : editing.c + 1),
        })
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
    // 编辑态：交给输入框自己处理（原生粘贴，回车留在同一个格子里，不会被拆到多格）
    if (editing) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    try {
      const r = sheet.pasteTsv(sel.r, sel.c, text)
      notify(`已粘贴 ${r.rows} 行 × ${r.cols} 列`)
    } catch {
      notify('粘贴失败：内容超出表格范围')
    }
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

  // 注意：输入过程中**不**自动改列宽——列宽只由拖拽 / 自适应宽度 / AI 操作决定，
  // 文字写多长都不会顶开列。编辑框自己会溢出到邻居之上（见 CellEditor）。

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
          style={
            {
              '--fz-top': `${fzOffset.top}px`,
              '--fz-left': `${fzOffset.left}px`,
            } as React.CSSProperties
          }
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
                    const isEditing = !!editing && editing.r === r && editing.c === c
                    const st = cell.s
                    // 编辑中的单元格：换行判定要跟着正在输入的草稿走，
                    // 否则敲下 Alt+Enter 的那一刻排版会从「单行」跳成「多行」
                    const shown = isEditing ? draft : cell.v
                    const multi = !!st?.wrap || (shown ? shown.includes('\n') : false)
                    const cellStyle: React.CSSProperties = { ...textStyleOf(st, multi) }
                    if (st?.valign) cellStyle.verticalAlign = st.valign
                    if (st?.bg) cellStyle.background = st.bg
                    if (multi) cellStyle.height = 'auto'
                    // 冻结行列：sticky 需要不透明底色，否则滚动时透出下层
                    const fRow = r < fzRows
                    const fCol = c < fzCols
                    // 编辑框沿用的底色：与下面 td 实际渲染出来的底色保持一致
                    const editBg =
                      st?.bg || (inRange && !isSel ? 'var(--brand-tint-10)' : 'var(--bg-canvas)')
                    if (fRow || fCol) {
                      cellStyle.position = 'sticky'
                      // 吸附偏移用实测的表头外沿尺寸（含边框），避免顶进表头底下
                      if (fRow) cellStyle.top = 'var(--fz-top)'
                      if (fCol) cellStyle.left = 'var(--fz-left)'
                      cellStyle.zIndex = fRow && fCol ? 8 : fRow ? 6 : 5
                      cellStyle.background = editBg
                    }
                    // 编辑中的格子必须压在邻居（含冻结行列）之上，
                    // 否则多行内容溢出到下一行时会被后面的单元格盖住
                    if (isEditing) cellStyle.zIndex = 30
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
                        data-r={r}
                        data-c={c}
                        className={
                          'cell' +
                          (isSel ? ' sel' : '') +
                          (inRange && !isSel ? ' range' : '') +
                          (remote ? ' remote' : '') +
                          (remoteColor ? ' has-owner' : '') +
                          (multi ? ' wrap' : '') +
                          (isEditing ? ' editing' : '') +
                          (hasComment ? ' has-comment' : '') +
                          (link ? ' has-link' : '') +
                          (c === fzCols - 1 ? ' freeze-col-shadow' : '')
                        }
                        style={{
                          ...cellStyle,
                          width: colWidth(c),
                          // 多行单元格让高度跟着内容走，否则第二行起会被行高裁掉
                          height: multi ? undefined : rowHeight(r),
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
                        {/*
                          编辑时保留一份「不可见的预览文本」当占位：
                          多行 / 自动换行的单元格行高是内容撑出来的，
                          直接把文本换成绝对定位的编辑框会让行高塌回单行，看起来就是跳变。
                          占位文字必须与编辑框里的草稿**完全一致**（而不是算完公式的显示值），
                          否则公式 / 数字格式单元格一进编辑，行高和折行位置都会跟着变。
                        */}
                        <span
                          className={
                            'cell-text' +
                            (link ? ' cell-link' : '') +
                            (isEditing ? ' edit-placeholder' : '')
                          }
                          // 换行策略与编辑态同源（见 textStyleOf），避免空格折叠方式不同导致横向跳位
                          style={
                            multi
                              ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
                              : { whiteSpace: 'pre' }
                          }
                        >
                          {isEditing ? draft : display(cell)}
                        </span>
                        {isEditing && (
                          <CellEditor
                            value={draft}
                            st={st}
                            multi={multi}
                            bg={editBg}
                            onChange={setDraft}
                            onBlur={() => commit()}
                          />
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
          readOnly={readOnly}
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
