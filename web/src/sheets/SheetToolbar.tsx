/**
 * 表格工具条（1:1 复刻腾讯文档式单行布局）
 *
 * 单行结构：视图/菜单 · 撤销 重做 格式刷 清除格式 · 插入 ·
 *           B I U S 文字色 填充 · 字体 字号 边框 · 垂直对齐×3 水平对齐×4 ·
 *           数字格式 · 合并单元格 · 货币 百分比 小数位 千分位 ·
 *           冻结 筛选 排序 · 条件格式 下拉列表 公式 多维表格 · 查找和替换 评论
 *
 * 「图标在上、文字在下」的堆叠按钮用于功能入口；纯图标按钮垂直居中。
 * 所有按钮都接真实数据层（useSheet → Yjs），无占位功能。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BorderMode, BorderSide, CellStyle, FrozenInfo, SheetApi } from './useSheet'
import { Ico, type IconName } from './sheetIcons'
import { PALETTE, colorName, DEFAULT_TEXT_COLOR } from './sheetColors'

/** 选区（含方向信息） */
export interface Range {
  r1: number
  c1: number
  r2: number
  c2: number
}

export interface FormatPainterState {
  /** 待复制的样式；undefined = 把目标格清成无格式 */
  style: CellStyle | undefined
  /** 是否处于「待落笔」状态 */
  armed: boolean
  /** 连续应用（可重复刷） */
  multi: boolean
}

export type { BorderMode }

export interface BorderPaintState {
  mode: BorderMode
  w: number
  c: string
  /** 是否处于「绘制边框」模式（点/框选即落笔） */
  drawing: boolean
}

export interface SheetToolbarProps {
  sheet: SheetApi
  range: Range
  sel: { r: number; c: number }
  curStyle?: CellStyle
  readOnly: boolean
  /** 当前选中区域是否为单个已合并单元格 */
  mergedAtSel: boolean
  painter: FormatPainterState
  onPainter: (p: FormatPainterState) => void
  borderPaint: BorderPaintState
  onBorderPaint: (b: BorderPaintState) => void
  onFind: () => void
  sidePanel: 'none' | 'ai' | 'comment'
  onSidePanel: (v: 'none' | 'ai' | 'comment') => void
  commentCount: number
  onInsertFunction: (kind: 'SUM' | 'AVERAGE' | 'COUNT' | 'MAX' | 'MIN') => void
  onNotify: (msg: string) => void
  onJump: (r: number, c: number) => void
  onSortByCol: (col: number, dir: 'asc' | 'desc') => void
  onAutoFitCol: (c: number) => void
  frozen: FrozenInfo
}

/* ------------------------------------------------------------------ */
/* 基础件：外点关闭 / 下拉浮层                                          */
/* ------------------------------------------------------------------ */

function useOutsideClose(onClose: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!enabled) return
    const md = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const kd = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', md)
    document.addEventListener('keydown', kd)
    return () => {
      document.removeEventListener('mousedown', md)
      document.removeEventListener('keydown', kd)
    }
  }, [enabled, onClose])
  return ref
}

interface TbButtonProps {
  icon?: IconName
  iconNode?: React.ReactNode
  text?: string
  title?: string
  active?: boolean
  disabled?: boolean
  arrow?: boolean
  /** 图标在上、文字在下的堆叠形态（腾讯文档式） */
  stacked?: boolean
  /** 主体点击（不传则整块点击由 onClick 处理） */
  onMain?: () => void
  onClick?: () => void
  /** 下拉箭头点击（配合 arrow 使用） */
  onArrow?: () => void
  className?: string
}

function TbButton({
  icon,
  iconNode,
  text,
  title,
  active,
  disabled,
  arrow,
  stacked,
  onMain,
  onClick,
  onArrow,
  className,
}: TbButtonProps) {
  const main = onMain ?? onClick
  const content = (
    <>
      {iconNode ?? (icon ? <Ico n={icon} size={16} /> : null)}
      {text && <span className="tb-btn-text">{text}</span>}
    </>
  )
  const cls =
    'tb-btn' +
    (stacked ? ' tb-btn-st' : '') +
    (text ? ' has-text' : '') +
    (active ? ' active' : '') +
    (className ? ' ' + className : '')
  // 带下拉：主体与箭头分成两个热区（主体做默认动作，箭头开菜单）
  if (arrow) {
    const caretBtn = (
      <button
        type="button"
        className="tb-btn tb-caret-btn"
        title={title}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (onArrow ?? main)?.()}
      >
        <Ico n="chevron-down" size={12} className="tb-caret" />
      </button>
    )
    if (stacked) {
      // 堆叠形态：箭头绝对定位到右上角，不占布局空间
      return (
        <span className={'tb-split tb-split-st' + (active ? ' active' : '') + (disabled ? ' disabled' : '')}>
          <button
            type="button"
            className={cls}
            title={title}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => main?.()}
          >
            {content}
          </button>
          {caretBtn}
        </span>
      )
    }
    return (
      <span className={'tb-split' + (active ? ' active' : '') + (disabled ? ' disabled' : '')}>
        <button
          type="button"
          className={cls}
          title={title}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => main?.()}
        >
          {content}
        </button>
        {caretBtn}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={cls}
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => main?.()}
    >
      {content}
    </button>
  )
}

/** 带下拉的按钮：主体走 onMain（可选），箭头开菜单 */
export function TbPop({
  icon,
  iconNode,
  text,
  title,
  active,
  disabled,
  arrow = true,
  stacked = false,
  width = 180,
  onMain,
  align = 'left',
  up = false,
  className,
  children,
  onOpen,
}: {
  icon?: IconName
  iconNode?: React.ReactNode
  text?: string
  title?: string
  active?: boolean
  disabled?: boolean
  arrow?: boolean
  stacked?: boolean
  width?: number
  onMain?: () => void
  align?: 'left' | 'right'
  /** 面板从下往上展开（用于底部工具行） */
  up?: boolean
  className?: string
  children: React.ReactNode | ((close: () => void) => React.ReactNode)
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(() => setOpen(false), open)
  return (
    <div className={'tb-wrap' + (open ? ' open' : '')} ref={ref}>
      <TbButton
        icon={icon}
        iconNode={iconNode}
        text={text}
        title={title}
        active={active ?? open}
        disabled={disabled}
        arrow={arrow}
        stacked={stacked}
        className={className}
        onMain={onMain}
        onClick={onMain ? undefined : () => setOpen((v) => !v)}
        onArrow={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          className={'tb-pop' + (align === 'right' ? ' right' : '') + (up ? ' up' : '')}
          style={{ width }}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  )
}

/** 下拉里的条目 */
export function MenuItem({
  label,
  icon,
  hint,
  disabled,
  active,
  danger,
  onClick,
}: {
  label: string
  icon?: IconName
  hint?: string
  disabled?: boolean
  active?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={'tb-mi' + (active ? ' active' : '') + (danger ? ' danger' : '')}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span className="tb-mi-icon">{icon && <Ico n={icon} size={15} />}</span>
      <span className="tb-mi-label">{label}</span>
      {hint && <span className="tb-mi-hint">{hint}</span>}
    </button>
  )
}

function MenuSep() {
  return <div className="tb-sep-h" />
}

function MenuGroup({ title }: { title: string }) {
  return <div className="tb-group">{title}</div>
}

/* ------------------------------------------------------------------ */
/* 色板                                                                */
/* ------------------------------------------------------------------ */

const isLightColor = (hex: string) => {
  const h = hex.replace('#', '')
  if (h.length < 6) return true
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b > 165
}

function ColorPalette({
  value,
  allowClear,
  clearLabel = '无颜色',
  onPick,
}: {
  value?: string
  allowClear?: boolean
  clearLabel?: string
  onPick: (c: string) => void
}) {
  return (
    <div className="cp" onMouseDown={(e) => e.preventDefault()}>
      <div className="cp-grid">
        {PALETTE.flatMap((row, ri) =>
          row.map((c, ci) => {
            const on = (value || '') === c
            return (
              <button
                type="button"
                key={ri + ':' + ci}
                className={'cp-cell' + (c === '' ? ' none' : '') + (on ? ' on' : '')}
                style={c ? { background: c } : undefined}
                title={ri === 0 && ci === 0 && allowClear ? clearLabel : colorName(c)}
                onClick={() => onPick(c)}
              >
                {on && c !== '' && (
                  <Ico n="check" size={12} strokeWidth={2.6} style={{ color: isLightColor(c) ? '#111827' : '#fff' }} />
                )}
              </button>
            )
          })
        )}
      </div>
      <label className="cp-more">
        <span className="cp-wheel" />
        <span className="cp-more-text">更多颜色</span>
        <Ico n="chevron-right" size={14} />
        <input
          type="color"
          value={value && value.startsWith('#') ? value : '#111827'}
          onChange={(e) => onPick(e.target.value)}
        />
      </label>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 边框选择器（2×5 网格图标 + 绘制边框工具）                             */
/* ------------------------------------------------------------------ */

type BorderGlyph =
  | 'none'
  | 'outer'
  | 'thick-outer'
  | 'inner-h'
  | 'inner-v'
  | 'all'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'

/** 边框面板的 10 个图标（4 列 × 2 行 + 2 个） */
const BORDER_ITEMS: { key: BorderGlyph; map: BorderMode; label: string; w?: number }[] = [
  { key: 'none', map: 'clear', label: '无边框' },
  { key: 'outer', map: 'outer', label: '外边框' },
  { key: 'thick-outer', map: 'outer', label: '粗外边框', w: 2.5 },
  { key: 'inner-h', map: 'inner-h', label: '内部横线' },
  { key: 'inner-v', map: 'inner-v', label: '内部竖线' },
  { key: 'all', map: 'all', label: '全部边框' },
  { key: 'left', map: 'left', label: '左边框' },
  { key: 'right', map: 'right', label: '右边框' },
  { key: 'top', map: 'top', label: '上边框' },
  { key: 'bottom', map: 'bottom', label: '下边框' },
]

/** 用 CSS 画 3×3 网格示意线 */
function BorderGlyphIcon({ kind, active }: { kind: BorderGlyph; active?: boolean }) {
  const line = 'rgba(31,39,51,.75)'
  const strong = 'rgba(31,39,51,.95)'
  const box: React.CSSProperties = { position: 'absolute', inset: 3, border: `1px dashed rgba(31,39,51,.30)` }
  const bars: React.CSSProperties[] = []
  const push = (
    side: 'top' | 'bottom' | 'left' | 'right',
    w: number,
    color = strong,
    offset = 3
  ) => {
    if (side === 'top')
      bars.push({ position: 'absolute', left: offset, right: offset, top: offset, height: w, background: color })
    if (side === 'bottom')
      bars.push({ position: 'absolute', left: offset, right: offset, bottom: offset, height: w, background: color })
    if (side === 'left')
      bars.push({ position: 'absolute', top: offset, bottom: offset, left: offset, width: w, background: color })
    if (side === 'right')
      bars.push({ position: 'absolute', top: offset, bottom: offset, right: offset, width: w, background: color })
  }
  switch (kind) {
    case 'none':
      push('top', 1)
      push('left', 1)
      break
    case 'outer':
      push('top', 1.5)
      push('bottom', 1.5)
      push('left', 1.5)
      push('right', 1.5)
      break
    case 'thick-outer':
      push('top', 2.5)
      push('bottom', 2.5)
      push('left', 2.5)
      push('right', 2.5)
      break
    case 'inner-v':
      bars.push({ position: 'absolute', top: 3, bottom: 3, left: '50%', width: 1.5, background: line })
      break
    case 'inner-h':
      bars.push({ position: 'absolute', left: 3, right: 3, top: '50%', height: 1.5, background: line })
      break
    case 'all':
      push('top', 1.5)
      push('bottom', 1.5)
      push('left', 1.5)
      push('right', 1.5)
      bars.push({ position: 'absolute', top: 3, bottom: 3, left: '50%', width: 1.2, background: line })
      bars.push({ position: 'absolute', left: 3, right: 3, top: '50%', height: 1.2, background: line })
      break
    case 'left':
      push('left', 2.5)
      break
    case 'right':
      push('right', 2.5)
      break
    case 'top':
      push('top', 2.5)
      break
    case 'bottom':
      push('bottom', 2.5)
      break
  }
  return (
    <span className={'bg-ico' + (active ? ' on' : '')}>
      <span style={box} />
      {bars.map((s, i) => (
        <span key={i} style={s} />
      ))}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* 预设                                                                */
/* ------------------------------------------------------------------ */

const FONTS = [
  { label: '默认字体', value: '' },
  { label: '宋体', value: '"Songti SC", SimSun, serif' },
  { label: '黑体', value: '"PingFang SC", "Microsoft YaHei", sans-serif' },
  { label: '楷体', value: 'KaiTi, "KaiTi SC", serif' },
  { label: '等宽', value: 'ui-monospace, Consolas, monospace' },
]
const SIZES = [9, 10, 11, 12, 14, 16, 18, 20, 24, 28]

const NUM_FMTS: { label: string; code: string; icon?: IconName }[] = [
  { label: '常规', code: '' },
  { label: '文本', code: '@' },
  { label: '数字', code: '0' },
  { label: '两位小数', code: '0.00' },
  { label: '千分位', code: '#,##0.00' },
  { label: '百分比', code: '0.00%' },
  { label: '人民币', code: '¥#,##0.00' },
  { label: '日期', code: 'yyyy-mm-dd' },
]

const CURRENCY_FMTS = [
  { label: '人民币 ¥12,345.68', code: '¥#,##0.00' },
  { label: '人民币（整数）¥12,346', code: '¥#,##0' },
  { label: '美元 $12,345.68', code: '$#,##0.00' },
  { label: '欧元 €12,345.68', code: '€#,##0.00' },
]
const PERCENT_FMTS = [
  { label: '百分比 0%', code: '0%' },
  { label: '百分比 0.00%', code: '0.00%' },
]
const DECIMAL_FMTS = [
  { label: '整数（0 位小数）', code: '0' },
  { label: '1 位小数 0.0', code: '0.0' },
  { label: '2 位小数 0.00', code: '0.00' },
  { label: '3 位小数 0.000', code: '0.000' },
]
const THOUSAND_FMTS = [
  { label: '千位分隔（整数）12,346', code: '#,##0' },
  { label: '千位分隔（2 位小数）12,345.68', code: '#,##0.00' },
]

/* ------------------------------------------------------------------ */
/* 主组件                                                              */
/* ------------------------------------------------------------------ */

export default function SheetToolbar(props: SheetToolbarProps) {
  const {
    sheet,
    range,
    sel,
    curStyle,
    readOnly,
    mergedAtSel,
    painter,
    onPainter,
    borderPaint,
    onBorderPaint,
    onFind,
    sidePanel,
    onSidePanel,
    commentCount,
    onInsertFunction,
    onNotify,
    onSortByCol,
    onAutoFitCol,
    frozen,
  } = props

  const locked = readOnly
  const applyStyle = (patch: Partial<CellStyle>) =>
    sheet.applyStyleRange(range.r1, range.c1, range.r2, range.c2, patch)

  // 字体 / 字号下拉里，导入进来的原生值不在预设中时要补一项，避免显示空白
  const fontOptions = useMemo(() => {
    const v = curStyle?.font
    if (!v || FONTS.some((f) => f.value === v)) return FONTS
    return [...FONTS, { label: v.split(',')[0].replace(/["']/g, '').trim() || v, value: v }]
  }, [curStyle?.font])
  const sizeOptions = useMemo(() => {
    const v = curStyle?.size
    if (!v || SIZES.includes(v)) return SIZES
    return [...SIZES, v].sort((a, b) => a - b)
  }, [curStyle?.size])

  /** 当前数字格式的展示文案（自定义格式直接显示代码） */
  const curFmtLabel = useMemo(() => {
    const code = curStyle?.numfmt ?? ''
    const hit = NUM_FMTS.find((f) => f.code === code)
    return hit ? hit.label : code || '常规'
  }, [curStyle?.numfmt])

  /** 当前选区尺寸文案，如 3R × 2C */
  const rangeLabel =
    range.r1 === range.r2 && range.c1 === range.c2
      ? '1 个单元格'
      : `${range.r2 - range.r1 + 1} 行 × ${range.c2 - range.c1 + 1} 列`

  const copySelection = async () => {
    const tsv = sheet.rangeToTsv(range.r1, range.c1, range.r2, range.c2)
    try {
      await navigator.clipboard.writeText(tsv)
      onNotify('已复制 ' + rangeLabel)
    } catch {
      onNotify('浏览器未授权剪贴板，请用 Ctrl+C 复制')
    }
  }
  const cutSelection = async () => {
    await copySelection()
    sheet.clearRange(range.r1, range.c1, range.r2, range.c2, 'content')
  }
  const pasteSelection = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) {
        onNotify('剪贴板为空')
        return
      }
      const r = sheet.pasteTsv(sel.r, sel.c, text)
      onNotify(`已粘贴 ${r.rows} 行 × ${r.cols} 列`)
    } catch {
      onNotify('浏览器未授权读取剪贴板，请用 Ctrl+V 粘贴')
    }
  }

  // ---- 格式刷 ----
  const copyFormat = (multi: boolean) => {
    const style = sheet.getStyleAt(sel.r, sel.c)
    onPainter({ style, armed: true, multi })
    onNotify(
      style
        ? multi
          ? '已复制格式：连续应用（Esc 退出）'
          : '已复制格式：请选择目标单元格'
        : '已复制「无格式」：点击目标可清除格式'
    )
  }

  // ---- 插入 ----
  const insertLink = () => {
    const url = window.prompt('插入链接（留空可移除链接）', curStyle?.link || 'https://')
    if (url === null) return
    sheet.setCellLink(sel.r, sel.c, url.trim())
    onNotify(url.trim() ? '已插入链接' : '已移除链接')
  }

  const setNumFmt = (code: string, label: string) => {
    sheet.setNumFmt(range.r1, range.c1, range.r2, range.c2, code)
    onNotify(code ? '已应用' + label : '已恢复常规格式')
  }

  return (
    <div className={'sheet-toolbar-v2' + (locked ? ' locked' : '')}>
      {/* ============ 单行工具条（腾讯文档式布局） ============ */}
      <div className="tb-row tb-row-single">
        {/* 视图 / 菜单 */}
        <TbPop icon="view-split" text={undefined} title="菜单" width={232}>
          {(close) => (
            <>
              <MenuGroup title="编辑" />
              <MenuItem
                label="撤销"
                icon="undo"
                hint="Ctrl+Z"
                disabled={!sheet.canUndo}
                onClick={() => {
                  sheet.undo()
                  close()
                }}
              />
              <MenuItem
                label="重做"
                icon="redo"
                hint="Ctrl+Y"
                disabled={!sheet.canRedo}
                onClick={() => {
                  sheet.redo()
                  close()
                }}
              />
              <MenuItem label="复制" icon="copy" hint="Ctrl+C" onClick={() => { void copySelection(); close() }} />
              <MenuItem label="剪切" icon="clipboard" hint="Ctrl+X" onClick={() => { void cutSelection(); close() }} />
              <MenuItem label="粘贴" icon="clipboard" hint="Ctrl+V" onClick={() => { void pasteSelection(); close() }} />
              <MenuItem
                label="清除内容"
                icon="eraser"
                hint="Delete"
                onClick={() => {
                  sheet.clearRange(range.r1, range.c1, range.r2, range.c2, 'content')
                  close()
                }}
              />
              <MenuItem
                label="清除格式"
                icon="clear-format"
                onClick={() => {
                  sheet.clearRange(range.r1, range.c1, range.r2, range.c2, 'format')
                  close()
                }}
              />
              <MenuSep />
              <MenuGroup title="工作表" />
              <MenuItem
                label="新建工作表"
                icon="plus"
                onClick={() => {
                  const n = sheet.addSheet()
                  onNotify('已新建工作表 ' + n)
                  close()
                }}
              />
              <MenuItem
                label="重命名工作表"
                icon="sheet"
                onClick={() => {
                  close()
                  const next = window.prompt('重命名工作表', sheet.activeSheet)
                  if (next === null) return
                  if (!sheet.renameSheet(sheet.activeSheet, next)) {
                    onNotify('重命名失败：名称为空或已存在')
                    return
                  }
                  onNotify('工作表已重命名为 ' + next.trim())
                }}
              />
              <MenuItem
                label="复制工作表"
                icon="copy"
                onClick={() => {
                  close()
                  const n = sheet.copySheet(sheet.activeSheet)
                  onNotify(n ? '已复制为 ' + n : '复制失败')
                }}
              />
              <MenuItem
                label="删除工作表"
                icon="trash"
                danger
                disabled={sheet.sheetNames.length <= 1}
                onClick={() => {
                  close()
                  if (!window.confirm(`确定删除工作表「${sheet.activeSheet}」？`)) return
                  const names = sheet.sheetNames.filter((n) => n !== sheet.activeSheet)
                  if (sheet.deleteSheet(sheet.activeSheet) && names[0]) {
                    onNotify('已删除工作表，并切换到 ' + names[0])
                  }
                }}
              />
              <MenuSep />
              <MenuGroup title="列" />
              <MenuItem
                label={`${colName(sel.c)} 列自适应宽度`}
                icon="grid"
                onClick={() => {
                  onAutoFitCol(sel.c)
                  close()
                }}
              />
              <MenuItem
                label="清空工作表内容"
                icon="trash"
                danger
                onClick={() => {
                  close()
                  if (!window.confirm(`清空工作表「${sheet.activeSheet}」的全部内容？`)) return
                  sheet.clearSheet()
                  onNotify('已清空当前工作表内容')
                }}
              />
            </>
          )}
        </TbPop>

        <span className="tb-div" />

        {/* 撤销 / 重做 / 格式刷 / 清除格式 */}
        <TbButton
          stacked
          icon="undo"
          text="撤销"
          title="撤销（仅本人操作，Ctrl+Z）"
          disabled={locked || !sheet.canUndo}
          onClick={sheet.undo}
        />
        <TbButton
          stacked
          icon="redo"
          text="重做"
          title="重做（Ctrl+Y）"
          disabled={locked || !sheet.canRedo}
          onClick={sheet.redo}
        />
        <TbPop
          stacked
          icon="painter"
          text="格式刷"
          title="复制所选单元格的格式"
          active={painter.armed}
          disabled={locked}
          width={200}
          onMain={() => copyFormat(false)}
        >
          {(close) => (
            <>
              <MenuItem
                label="复制格式"
                icon="copy"
                hint="单击"
                onClick={() => {
                  copyFormat(false)
                  close()
                }}
              />
              <MenuItem
                label="连续应用格式"
                icon="painter"
                hint="可重复刷"
                onClick={() => {
                  copyFormat(true)
                  close()
                }}
              />
              {painter.armed && (
                <>
                  <MenuSep />
                  <MenuItem
                    label="停止格式刷"
                    icon="stop"
                    hint="Esc"
                    onClick={() => {
                      onPainter({ ...painter, armed: false })
                      close()
                    }}
                  />
                </>
              )}
            </>
          )}
        </TbPop>
        <TbButton
          stacked
          icon="clear-format"
          text="清除格式"
          title="清除格式（保留内容）"
          disabled={locked}
          onClick={() => {
            sheet.clearRange(range.r1, range.c1, range.r2, range.c2, 'format')
            onNotify('已清除所选区域的格式')
          }}
        />

        <span className="tb-div" />

        {/* 插入 */}
        <TbPop stacked icon="insert" text="插入" title="插入行列 / 链接 / 批注 / 函数" width={214} disabled={locked}>
          {(close) => (
            <>
              <MenuGroup title="行列" />
              <MenuItem label="在上方插入行" onClick={() => { sheet.addRow(range.r1); close() }} />
              <MenuItem label="在下方插入行" onClick={() => { sheet.addRow(range.r2 + 1); close() }} />
              <MenuItem label="在左侧插入列" onClick={() => { sheet.addCol(range.c1); close() }} />
              <MenuItem label="在右侧插入列" onClick={() => { sheet.addCol(range.c2 + 1); close() }} />
              <MenuSep />
              <MenuGroup title="内容" />
              <MenuItem label="链接" icon="link" onClick={() => { insertLink(); close() }} />
              <MenuItem
                label="批注"
                icon="comment"
                onClick={() => {
                  onSidePanel('comment')
                  close()
                }}
              />
              <MenuItem
                label="图片"
                icon="image"
                disabled
                hint="即将支持"
                onClick={() => close()}
              />
              <MenuSep />
              <MenuGroup title="函数" />
              <MenuItem label="求和 SUM" icon="sum" onClick={() => { onInsertFunction('SUM'); close() }} />
              <MenuItem label="平均值 AVERAGE" onClick={() => { onInsertFunction('AVERAGE'); close() }} />
              <MenuItem label="计数 COUNT" onClick={() => { onInsertFunction('COUNT'); close() }} />
              <MenuItem label="最大值 MAX" onClick={() => { onInsertFunction('MAX'); close() }} />
              <MenuItem label="最小值 MIN" onClick={() => { onInsertFunction('MIN'); close() }} />
            </>
          )}
        </TbPop>

        <span className="tb-div" />

        {/* 加粗 / 斜体 / 下划线 / 删除线 / 文字色 / 填充 */}
        <TbButton icon="bold" title="加粗 Ctrl+B" active={!!curStyle?.bold} disabled={locked} onClick={() => applyStyle({ bold: !curStyle?.bold })} />
        <TbButton icon="italic" title="斜体 Ctrl+I" active={!!curStyle?.italic} disabled={locked} onClick={() => applyStyle({ italic: !curStyle?.italic })} />
        <TbButton icon="underline" title="下划线 Ctrl+U" active={!!curStyle?.underline} disabled={locked} onClick={() => applyStyle({ underline: !curStyle?.underline })} />
        <TbButton icon="strike" title="删除线" active={!!curStyle?.strike} disabled={locked} onClick={() => applyStyle({ strike: !curStyle?.strike })} />
        <TbPop
          width={268}
          disabled={locked}
          title="文字颜色"
          iconNode={
            <span className="tb-color-a">
              <span className="tb-color-a-char">A</span>
              <span className="tb-color-a-bar" style={{ background: curStyle?.color || DEFAULT_TEXT_COLOR }} />
            </span>
          }
        >
          {(close) => (
            <ColorPalette
              value={curStyle?.color}
              allowClear
              clearLabel="恢复默认文字色"
              onPick={(c) => {
                applyStyle({ color: c || undefined })
                close()
              }}
            />
          )}
        </TbPop>
        <TbPop
          width={268}
          disabled={locked}
          title="单元格填充色"
          iconNode={
            <span className="tb-color-a">
              <Ico n="fill" size={16} />
              <span
                className="tb-color-a-bar"
                style={{ background: curStyle?.bg || 'transparent', boxShadow: 'inset 0 0 0 1px var(--border-default)' }}
              />
            </span>
          }
        >
          {(close) => (
            <ColorPalette
              value={curStyle?.bg}
              allowClear
              clearLabel="无填充色"
              onPick={(c) => {
                applyStyle({ bg: c || undefined })
                close()
              }}
            />
          )}
        </TbPop>

        <span className="tb-div" />

        {/* 字体 / 字号 / 边框 */}
        <TbPop
          text={fontOptions.find((f) => f.value === (curStyle?.font ?? ''))?.label || '默认字体'}
          width={168}
          disabled={locked}
          className="tb-font"
        >
          {(close) => (
            <>
              {fontOptions.map((f) => (
                <MenuItem
                  key={f.value}
                  label={f.label}
                  active={(curStyle?.font ?? '') === f.value}
                  onClick={() => {
                    applyStyle({ font: f.value || undefined })
                    close()
                  }}
                />
              ))}
            </>
          )}
        </TbPop>
        <TbPop text={String(curStyle?.size ?? 10)} width={92} disabled={locked} className="tb-size">
          {(close) => (
            <>
              <MenuItem
                label="默认"
                active={!curStyle?.size}
                onClick={() => {
                  applyStyle({ size: undefined })
                  close()
                }}
              />
              {sizeOptions.map((s) => (
                <MenuItem
                  key={s}
                  label={String(s)}
                  active={curStyle?.size === s}
                  onClick={() => {
                    applyStyle({ size: s })
                    close()
                  }}
                />
              ))}
            </>
          )}
        </TbPop>
        <TbPop
          icon="border"
          title="边框"
          active={borderPaint.drawing}
          width={288}
          arrow={false}
          disabled={locked}
        >
          {(close) => (
            <div className="bg-pop" onMouseDown={(e) => e.preventDefault()}>
              <div className="bg-grid">
                {BORDER_ITEMS.map((it) => (
                  <button
                    type="button"
                    key={it.key}
                    className={'bg-cell' + (borderPaint.drawing && borderPaint.mode === it.map ? ' on' : '')}
                    title={it.label}
                    onClick={() => {
                      onBorderPaint({ ...borderPaint, mode: it.map, drawing: false })
                      const b: BorderSide | null =
                        it.map === 'clear' ? null : { w: it.w ?? borderPaint.w, c: borderPaint.c }
                      sheet.applyBorder(range.r1, range.c1, range.r2, range.c2, it.map, b)
                      onNotify('已应用' + it.label)
                      close()
                    }}
                  >
                    <BorderGlyphIcon kind={it.key} />
                  </button>
                ))}
              </div>
              <div className="bg-tools">
                <button
                  type="button"
                  className={'bg-draw' + (borderPaint.drawing ? ' on' : '')}
                  title={borderPaint.drawing ? '退出绘制边框' : '绘制边框：开启后在网格上框选即可落笔'}
                  onClick={() => {
                    onBorderPaint({ ...borderPaint, drawing: !borderPaint.drawing })
                    close()
                  }}
                >
                  <Ico n="painter" size={16} />
                </button>
                <select
                  className="bg-select"
                  value={borderPaint.w}
                  title="边框粗细"
                  onChange={(e) => onBorderPaint({ ...borderPaint, w: Number(e.target.value) })}
                >
                  <option value={1}>细</option>
                  <option value={1.5}>中</option>
                  <option value={2.5}>粗</option>
                </select>
                <span className="bg-line-preview" style={{ height: borderPaint.w, background: borderPaint.c }} />
                <label className="bg-swatch" title="边框颜色">
                  <span style={{ background: borderPaint.c }} />
                  <input
                    type="color"
                    value={borderPaint.c}
                    onChange={(e) => onBorderPaint({ ...borderPaint, c: e.target.value })}
                  />
                </label>
              </div>
            </div>
          )}
        </TbPop>

        <span className="tb-div" />

        {/* 垂直对齐 ×3（主体直接应用，箭头开菜单） */}
        {(
          [
            ['top', 'valign-top', '顶端对齐'],
            ['middle', 'valign-middle', '垂直居中'],
            ['bottom', 'valign-bottom', '底端对齐'],
          ] as const
        ).map(([v, icon, label]) => (
          <TbPop
            key={v}
            icon={icon}
            title={label}
            width={150}
            disabled={locked}
            active={(curStyle?.valign ?? 'middle') === v}
            onMain={() => applyStyle({ valign: v })}
          >
            {(close) => (
              <>
                {(
                  [
                    ['top', '顶端对齐', 'valign-top'],
                    ['middle', '垂直居中', 'valign-middle'],
                    ['bottom', '底端对齐', 'valign-bottom'],
                  ] as const
                ).map(([val, lab, ico]) => (
                  <MenuItem
                    key={val}
                    label={lab}
                    icon={ico as IconName}
                    active={(curStyle?.valign ?? 'middle') === val}
                    onClick={() => {
                      applyStyle({ valign: val })
                      close()
                    }}
                  />
                ))}
              </>
            )}
          </TbPop>
        ))}

        {/* 水平对齐 ×4 */}
        {(
          [
            ['left', 'align-left', '左对齐'],
            ['center', 'align-center', '居中对齐'],
            ['right', 'align-right', '右对齐'],
          ] as const
        ).map(([v, icon, label]) => (
          <TbPop
            key={v}
            icon={icon}
            title={label}
            width={150}
            disabled={locked}
            active={(curStyle?.align ?? 'left') === v}
            onMain={() => applyStyle({ align: v })}
          >
            {(close) => (
              <>
                {(
                  [
                    ['left', '左对齐', 'align-left'],
                    ['center', '居中对齐', 'align-center'],
                    ['right', '右对齐', 'align-right'],
                  ] as const
                ).map(([val, lab, ico]) => (
                  <MenuItem
                    key={val}
                    label={lab}
                    icon={ico as IconName}
                    active={(curStyle?.align ?? 'left') === val}
                    onClick={() => {
                      applyStyle({ align: val })
                      close()
                    }}
                  />
                ))}
              </>
            )}
          </TbPop>
        ))}
        <TbButton
          icon="align-distributed"
          title="分散对齐（即将支持）"
          disabled
          onClick={() => {}}
        />

        <span className="tb-div" />

        {/* 数字格式（显示当前格式名） */}
        <TbPop text={curFmtLabel} width={186} disabled={locked} title="数字格式" className="tb-numfmt">
          {(close) => (
            <>
              {NUM_FMTS.map((f) => (
                <MenuItem
                  key={f.label}
                  label={f.label}
                  hint={f.code || undefined}
                  active={(curStyle?.numfmt ?? '') === f.code}
                  onClick={() => {
                    sheet.setNumFmt(range.r1, range.c1, range.r2, range.c2, f.code)
                    close()
                  }}
                />
              ))}
              <MenuSep />
              <MenuItem
                label="自定义格式…"
                onClick={() => {
                  close()
                  const code = window.prompt(
                    '输入数字格式代码（如 0.00、#,##0.00、yyyy-mm-dd）',
                    curStyle?.numfmt || '0.00'
                  )
                  if (code === null) return
                  sheet.setNumFmt(range.r1, range.c1, range.r2, range.c2, code.trim())
                  onNotify(code.trim() ? '已应用自定义格式：' + code.trim() : '已恢复常规格式')
                }}
              />
            </>
          )}
        </TbPop>

        <span className="tb-div" />

        {/* 合并单元格 */}
        <TbPop stacked icon="merge" text="合并单元格" title="合并单元格" width={176} disabled={locked}>
          {(close) => (
            <>
              <MenuItem
                label="合并单元格"
                icon="merge"
                disabled={range.r1 === range.r2 && range.c1 === range.c2}
                onClick={() => {
                  sheet.mergeCells(range.r1, range.c1, range.r2, range.c2)
                  close()
                }}
              />
              <MenuItem
                label="合并后居中"
                icon="align-center"
                disabled={range.r1 === range.r2 && range.c1 === range.c2}
                onClick={() => {
                  sheet.mergeCells(range.r1, range.c1, range.r2, range.c2)
                  sheet.applyStyleRange(range.r1, range.c1, range.r2, range.c2, { align: 'center' })
                  close()
                }}
              />
              <MenuItem
                label="取消合并"
                disabled={!mergedAtSel}
                onClick={() => {
                  sheet.unmergeCells(range.r1, range.c1, range.r2, range.c2)
                  close()
                }}
              />
            </>
          )}
        </TbPop>

        <span className="tb-div" />

        {/* 货币 / 百分比 / 小数位 / 千分位 */}
        <TbPop
          iconNode={<span className="tb-num-ico">¥</span>}
          title="货币格式"
          width={210}
          disabled={locked}
        >
          {(close) => (
            <>
              {CURRENCY_FMTS.map((f) => (
                <MenuItem
                  key={f.code}
                  label={f.label}
                  active={curStyle?.numfmt === f.code}
                  onClick={() => {
                    setNumFmt(f.code, f.label)
                    close()
                  }}
                />
              ))}
              <MenuSep />
              <MenuItem
                label="清除货币格式"
                onClick={() => {
                  setNumFmt('', '')
                  close()
                }}
              />
            </>
          )}
        </TbPop>
        <TbPop
          iconNode={<span className="tb-num-ico">%</span>}
          title="百分比格式"
          width={190}
          disabled={locked}
        >
          {(close) => (
            <>
              {PERCENT_FMTS.map((f) => (
                <MenuItem
                  key={f.code}
                  label={f.label}
                  active={curStyle?.numfmt === f.code}
                  onClick={() => {
                    setNumFmt(f.code, f.label)
                    close()
                  }}
                />
              ))}
              <MenuSep />
              <MenuItem
                label="清除百分比格式"
                onClick={() => {
                  setNumFmt('', '')
                  close()
                }}
              />
            </>
          )}
        </TbPop>
        <TbPop
          iconNode={<span className="tb-num-ico">.00</span>}
          title="小数位数"
          width={190}
          disabled={locked}
        >
          {(close) => (
            <>
              {DECIMAL_FMTS.map((f) => (
                <MenuItem
                  key={f.code}
                  label={f.label}
                  hint={f.code}
                  active={curStyle?.numfmt === f.code}
                  onClick={() => {
                    setNumFmt(f.code, f.label)
                    close()
                  }}
                />
              ))}
            </>
          )}
        </TbPop>
        <TbPop
          iconNode={<span className="tb-num-ico">,000</span>}
          title="千位分隔符"
          width={220}
          disabled={locked}
        >
          {(close) => (
            <>
              {THOUSAND_FMTS.map((f) => (
                <MenuItem
                  key={f.code}
                  label={f.label}
                  active={curStyle?.numfmt === f.code}
                  onClick={() => {
                    setNumFmt(f.code, f.label)
                    close()
                  }}
                />
              ))}
              <MenuSep />
              <MenuItem
                label="清除千位分隔"
                onClick={() => {
                  setNumFmt('', '')
                  close()
                }}
              />
            </>
          )}
        </TbPop>

        <span className="tb-div" />

        {/* 冻结 / 筛选 / 排序 */}
        <TbPop stacked icon="freeze" text="冻结" title="冻结窗格" width={200} disabled={locked}>
          {(close) => (
            <>
              <MenuItem
                label="冻结首行"
                icon="freeze"
                active={frozen.rows === 1 && frozen.cols === 0}
                onClick={() => {
                  sheet.setFrozen(frozen.rows === 1 && frozen.cols === 0 ? 0 : 1, 0)
                  close()
                }}
              />
              <MenuItem
                label="冻结首列"
                icon="freeze"
                active={frozen.cols === 1 && frozen.rows === 0}
                onClick={() => {
                  sheet.setFrozen(0, frozen.cols === 1 && frozen.rows === 0 ? 0 : 1)
                  close()
                }}
              />
              <MenuItem
                label="冻结首行 + 首列"
                icon="freeze"
                active={frozen.rows >= 1 && frozen.cols >= 1}
                onClick={() => {
                  sheet.setFrozen(1, 1)
                  close()
                }}
              />
              <MenuItem
                label="取消冻结"
                disabled={!frozen.rows && !frozen.cols}
                onClick={() => {
                  sheet.setFrozen(0, 0)
                  close()
                }}
              />
            </>
          )}
        </TbPop>
        <TbButton stacked icon="filter" text="筛选" title="筛选（即将支持）" disabled onClick={() => {}} />
        <TbPop stacked icon="sort" text="排序" title="排序（按当前列）" width={180} disabled={locked}>
          {(close) => (
            <>
              <MenuItem
                label={`按 ${colName(sel.c)} 列升序`}
                icon="sort"
                onClick={() => {
                  onSortByCol(sel.c, 'asc')
                  close()
                }}
              />
              <MenuItem
                label={`按 ${colName(sel.c)} 列降序`}
                icon="sort"
                onClick={() => {
                  onSortByCol(sel.c, 'desc')
                  close()
                }}
              />
            </>
          )}
        </TbPop>

        <span className="tb-div" />

        {/* 条件格式 / 下拉列表 / 公式 / 多维表格 */}
        <TbButton stacked icon="cond-format" text="条件格式" title="条件格式（即将支持）" disabled onClick={() => {}} />
        <TbButton stacked icon="dropdown-list" text="下拉列表" title="下拉列表（即将支持）" disabled onClick={() => {}} />
        <TbPop stacked icon="sum" text="公式" title="插入函数" width={200} disabled={locked}>
          {(close) => (
            <>
              <MenuItem label="求和 SUM" icon="sum" onClick={() => { onInsertFunction('SUM'); close() }} />
              <MenuItem label="平均值 AVERAGE" onClick={() => { onInsertFunction('AVERAGE'); close() }} />
              <MenuItem label="计数 COUNT" onClick={() => { onInsertFunction('COUNT'); close() }} />
              <MenuItem label="最大值 MAX" onClick={() => { onInsertFunction('MAX'); close() }} />
              <MenuItem label="最小值 MIN" onClick={() => { onInsertFunction('MIN'); close() }} />
            </>
          )}
        </TbPop>
        <TbButton stacked icon="table" text="多维表格" title="多维表格（即将支持）" disabled onClick={() => {}} />

        <span className="tb-div" />

        {/* 查找和替换 / 评论 */}
        <TbButton
          stacked
          icon="find"
          text="查找和替换"
          title="查找和替换（Ctrl+F）"
          onClick={onFind}
          disabled={locked}
        />
        <TbButton
          stacked
          icon="comment"
          text={commentCount ? `评论 ${commentCount}` : '评论'}
          title="单元格批注"
          active={sidePanel === 'comment'}
          onClick={() => onSidePanel(sidePanel === 'comment' ? 'none' : 'comment')}
        />

        <span className="tb-grow" />

        <span className="tb-range-hint" title="当前选区">
          {rangeLabel}
        </span>
        <TbButton
          icon="sparkle"
          text="智能助手"
          title="打开右侧智能问答"
          active={sidePanel === 'ai'}
          onClick={() => onSidePanel(sidePanel === 'ai' ? 'none' : 'ai')}
          className="tb-ai"
        />
      </div>
    </div>
  )
}

/** 列号 → 字母 */
function colName(c: number): string {
  let n = c
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}
