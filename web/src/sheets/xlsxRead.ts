/**
 * 高保真 .xlsx 读取器
 *
 * SheetJS 社区版即便开了 cellStyles 也只回填填充色，字体 / 边框 / 对齐一概拿不到。
 * 这里直接读 OOXML 原始 XML（styles.xml + sheetN.xml），把以下信息完整还原：
 *   - 字体：名称 / 字号 / 粗体 / 斜体 / 下划线 / 删除线 / 颜色（含 theme 色）
 *   - 填充：单元格背景色
 *   - 边框：四边线型 + 线宽 + 颜色
 *   - 对齐：水平 / 垂直 / 自动换行
 *   - 数字格式（numFmt）
 *   - 合并单元格 / 列宽 / 行高 / 公式
 *
 * 非 zip 容器（如 .xls / .csv）会抛出错误，由调用方回退到 SheetJS。
 */
import { strFromU8, unzipSync } from 'fflate'
import { colToIndex } from './refs'
import type { CellData, CellStyle, MergeInfo } from './useSheet'
import { BUILTIN_NUMFMT } from './numfmt'

export interface ImportedSheetModel {
  name: string
  rows: CellData[][]
  merges: MergeInfo[]
  /** 列宽（px），key = 列索引 */
  colw: Record<number, number>
  /** 行高（px），key = 行索引 */
  rowh: Record<number, number>
}

type BorderStyleName = 'solid' | 'dashed' | 'dotted' | 'double'

interface RawBorder {
  w: number
  c: string
  s?: BorderStyleName
}

interface XFont {
  name?: string
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
}
interface XFill {
  pattern?: string
  fg?: string
  bg?: string
}
interface XBorderSide extends RawBorder {}
interface XBorderBox {
  top?: XBorderSide
  left?: XBorderSide
  bottom?: XBorderSide
  right?: XBorderSide
}
interface XAlignment {
  horizontal?: string
  vertical?: string
  wrapText?: boolean
}
interface XF {
  numFmtId?: number
  fontId?: number
  fillId?: number
  borderId?: number
  applyFont?: boolean
  applyFill?: boolean
  applyBorder?: boolean
  applyAlignment?: boolean
  alignment?: XAlignment
}

/**
 * SpreadsheetML 里 theme="N" 的索引顺序。
 * 注意与 theme1.xml 中 clrScheme 的书写顺序（dk1, lt1, dk2, lt2...）不同：
 * 表格里 0=lt1(白) 1=dk1(黑) 2=lt2 3=dk2，之后才是 accent1~6、hlink、folHlink。
 */
const THEME_INDEX_ORDER = [
  'lt1', 'dk1', 'lt2', 'dk2',
  'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6',
  'hlink', 'folHlink',
]

const DEFAULT_THEME = [
  '#FFFFFF', '#000000', '#E7E6E6', '#44546A',
  '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000',
  '#5B9BD5', '#70AD47', '#0563C1', '#954F72',
]

const INDEXED_COLORS: Record<number, string> = {
  0: '#000000', 1: '#FFFFFF', 2: '#FF0000', 3: '#00FF00', 4: '#0000FF',
  5: '#FFFF00', 6: '#FF00FF', 7: '#00FFFF', 8: '#000000', 9: '#FFFFFF',
}

// ---------------------------------------------------------------- 基础工具

function attr(text: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(text)
  return m ? m[1] : undefined
}

function hasFlag(body: string, tag: string): boolean {
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'i')
  const m = re.exec(body)
  if (!m) return false
  if (m[2] !== undefined) return true
  const val = attr(m[1] ?? '', 'val')
  return val === undefined || (val !== '0' && val.toLowerCase() !== 'false')
}

function argbToHex(argb: string): string | undefined {
  const s = argb.trim()
  if (!/^[0-9a-fA-F]+$/.test(s)) return undefined
  if (s.length < 6) return undefined
  return '#' + s.slice(-6).toUpperCase()
}

function resolveColor(attrText: string, theme: string[]): string | undefined {
  const rgb = attr(attrText, 'rgb')
  if (rgb) return argbToHex(rgb)
  const th = attr(attrText, 'theme')
  if (th != null) {
    const i = parseInt(th, 10)
    if (Number.isFinite(i)) return theme[i] ?? undefined
  }
  const idx = attr(attrText, 'indexed')
  if (idx != null) {
    const i = parseInt(idx, 10)
    // 64/65 为「系统前景/背景」，不代表具体颜色
    if (Number.isFinite(i) && i <= 63) return INDEXED_COLORS[i]
  }
  return undefined
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
}

function decodeXml(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code: string) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X'
      const n = parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : full
    }
    return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? full
  })
}

function eachMatch(text: string, re: RegExp, fn: (m: RegExpExecArray) => void) {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    fn(m)
    if (m[0].length === 0) re.lastIndex++
  }
}

// ---------------------------------------------------------------- 主题色

function parseTheme(xml: string | undefined): string[] {
  if (!xml) return DEFAULT_THEME
  const wrap = /<[a-zA-Z]*:?clrScheme\b[^>]*>([\s\S]*?)<\/[a-zA-Z]*:?clrScheme>/.exec(xml)
  if (!wrap) return DEFAULT_THEME
  const byName: Record<string, string> = {}
  const re = /<[a-zA-Z]*:?(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)\b[^>]*>([\s\S]*?)<\/[a-zA-Z]*:?\1>/gi
  eachMatch(wrap[1], re, (m) => {
    const v =
      /<[a-zA-Z]*:?srgbClr\s+val="([^"]*)"/i.exec(m[2])?.[1] ||
      /<[a-zA-Z]*:?sysClr[^>]*lastClr="([^"]*)"/i.exec(m[2])?.[1]
    if (!v || v.length < 6) return
    byName[m[1].toLowerCase()] = '#' + v.slice(-6).toUpperCase()
  })
  return THEME_INDEX_ORDER.map((name) => byName[name] ?? DEFAULT_THEME[THEME_INDEX_ORDER.indexOf(name)])
}

// ---------------------------------------------------------------- styles.xml

function parseNumFmts(stylesXml: string): Record<number, string> {
  const out: Record<number, string> = {}
  const wrap = /<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/.exec(stylesXml)
  if (!wrap) return out
  eachMatch(wrap[1], /<numFmt\b([^>]*?)(?:\/>|>[\s\S]*?<\/numFmt>)/gi, (m) => {
    const id = attr(m[1], 'numFmtId')
    const code = attr(m[1], 'formatCode')
    if (id == null || code == null) return
    out[parseInt(id, 10)] = decodeXml(code)
  })
  return out
}

function parseFonts(stylesXml: string, theme: string[]): XFont[] {
  const wrap = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(stylesXml)
  if (!wrap) return []
  const out: XFont[] = []
  eachMatch(wrap[1], /<font\b([^>]*?)(?:\/>|>([\s\S]*?)<\/font>)/gi, (m) => {
    const body = m[2] ?? ''
    const f: XFont = {}
    const sz = /<sz\s+val="([^"]*)"/i.exec(body)?.[1]
    if (sz != null) {
      const n = parseFloat(sz)
      if (Number.isFinite(n)) f.size = n
    }
    const nm = /<name\s+val="([^"]*)"/i.exec(body)?.[1]
    if (nm) f.name = nm
    if (hasFlag(body, 'b')) f.bold = true
    if (hasFlag(body, 'i')) f.italic = true
    if (hasFlag(body, 'strike')) f.strike = true
    const u = /<u\b([^>]*?)(?:\/>|>([\s\S]*?)<\/u>)/i.exec(body)
    if (u) {
      const val = attr(u[1] ?? '', 'val')
      f.underline = val === undefined || (val !== 'none' && val !== '0')
    }
    const cm = /<color\b([^>]*?)(?:\/>|>[\s\S]*?<\/color>)/i.exec(body)
    if (cm) f.color = resolveColor(cm[1], theme)
    out.push(f)
  })
  return out
}

function parseFills(stylesXml: string, theme: string[]): XFill[] {
  const wrap = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(stylesXml)
  if (!wrap) return []
  const out: XFill[] = []
  eachMatch(wrap[1], /<fill\b([^>]*?)(?:\/>|>([\s\S]*?)<\/fill>)/gi, (m) => {
    const body = m[2] ?? ''
    const pf = /<patternFill\b([^>]*?)(?:\/>|>([\s\S]*?)<\/patternFill>)/i.exec(body)
    const f: XFill = {}
    if (pf) {
      f.pattern = attr(pf[1] ?? '', 'patternType')
      const inner = pf[2] ?? ''
      const fg = /<fgColor\b([^>]*?)(?:\/>|>[\s\S]*?<\/fgColor>)/i.exec(inner)
      if (fg) f.fg = resolveColor(fg[1], theme)
      const bg = /<bgColor\b([^>]*?)(?:\/>|>[\s\S]*?<\/bgColor>)/i.exec(inner)
      if (bg) f.bg = resolveColor(bg[1], theme)
    }
    out.push(f)
  })
  return out
}

function borderFromStyle(style: string, color: string): XBorderSide | undefined {
  const s = style.toLowerCase()
  const table: Record<string, XBorderSide> = {
    hair: { w: 1, s: 'solid', c: color },
    thin: { w: 1, s: 'solid', c: color },
    dotted: { w: 1, s: 'dotted', c: color },
    dashed: { w: 1, s: 'dashed', c: color },
    dashdot: { w: 1, s: 'dashed', c: color },
    dashdotdot: { w: 1, s: 'dashed', c: color },
    slantdashdot: { w: 1, s: 'dashed', c: color },
    medium: { w: 2, s: 'solid', c: color },
    mediumdashed: { w: 2, s: 'dashed', c: color },
    mediumdashdot: { w: 2, s: 'dashed', c: color },
    mediumdashdotdot: { w: 2, s: 'dashed', c: color },
    thick: { w: 3, s: 'solid', c: color },
    double: { w: 3, s: 'double', c: color },
  }
  return table[s]
}

function parseBorders(stylesXml: string, theme: string[]): XBorderBox[] {
  const wrap = /<borders\b[^>]*>([\s\S]*?)<\/borders>/.exec(stylesXml)
  if (!wrap) return []
  const out: XBorderBox[] = []
  const sides = ['top', 'left', 'bottom', 'right'] as const
  eachMatch(wrap[1], /<border\b([^>]*?)(?:\/>|>([\s\S]*?)<\/border>)/gi, (m) => {
    const body = m[2] ?? ''
    const box: XBorderBox = {}
    for (const side of sides) {
      const sm = new RegExp(`<${side}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${side}>)`, 'i').exec(body)
      if (!sm) continue
      const style = attr(sm[1] ?? '', 'style')
      if (!style) continue
      const inner = sm[2] ?? ''
      const cm = /<color\b([^>]*?)(?:\/>|>[\s\S]*?<\/color>)/i.exec(inner)
      // 边框未指定颜色时按 Excel 默认的自动色（近似黑）
      const color = cm ? resolveColor(cm[1], theme) || '#000000' : '#000000'
      const info = borderFromStyle(style, color)
      if (info) box[side] = info
    }
    out.push(box)
  })
  return out
}

function parseCellXfs(stylesXml: string): XF[] {
  const wrap = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)
  if (!wrap) return []
  const out: XF[] = []
  eachMatch(wrap[1], /<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/gi, (m) => {
    const attrs = m[1] ?? ''
    const body = m[2] ?? ''
    const xf: XF = {}
    const nf = attr(attrs, 'numFmtId')
    if (nf != null) xf.numFmtId = parseInt(nf, 10)
    const fi = attr(attrs, 'fontId')
    if (fi != null) xf.fontId = parseInt(fi, 10)
    const fl = attr(attrs, 'fillId')
    if (fl != null) xf.fillId = parseInt(fl, 10)
    const bd = attr(attrs, 'borderId')
    if (bd != null) xf.borderId = parseInt(bd, 10)
    xf.applyFont = attr(attrs, 'applyFont') !== '0'
    xf.applyFill = attr(attrs, 'applyFill') !== '0'
    xf.applyBorder = attr(attrs, 'applyBorder') !== '0'
    xf.applyAlignment = attr(attrs, 'applyAlignment') !== '0'
    const al = /<alignment\b([^>]*?)(?:\/>|>[\s\S]*?<\/alignment>)/i.exec(body)
    if (al) {
      const a: XAlignment = {}
      const h = attr(al[1], 'horizontal')
      if (h) a.horizontal = h
      const v = attr(al[1], 'vertical')
      if (v) a.vertical = v
      const w = attr(al[1], 'wrapText')
      a.wrapText = w === '1' || w === 'true'
      xf.alignment = a
    }
    out.push(xf)
  })
  return out
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return []
  const out: string[] = []
  eachMatch(xml, /<si\b([^>]*?)(?:\/>|>([\s\S]*?)<\/si>)/gi, (m) => {
    const body = (m[2] ?? '').replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/gi, '')
    let text = ''
    eachMatch(body, /<t\b([^>]*?)(?:\/>|>([\s\S]*?)<\/t>)/gi, (t) => {
      text += decodeXml(t[2] ?? '')
    })
    out.push(text)
  })
  return out
}

// ---------------------------------------------------------------- 取值

const SAFE_FORMULA = /^(SUM\s*\([^()]*\)|[A-Z]+\d+|\d+(\.\d+)?|[-+*/(),.\s])+$/i

interface RawValue {
  value: string
  numeric: boolean
  formula: string | null
}

function readCellValue(body: string, t: string | undefined, sst: string[]): RawValue {
  const fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/i.exec(body)
  const formula = fm ? decodeXml(fm[2] ?? '').trim() : null

  if (t === 'inlineStr') {
    const isBlock = /<is\b[^>]*>([\s\S]*?)<\/is>/i.exec(body)
    const inner = (isBlock ? isBlock[1] : body).replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/gi, '')
    let text = ''
    eachMatch(inner, /<t\b([^>]*?)(?:\/>|>([\s\S]*?)<\/t>)/gi, (tm) => {
      text += decodeXml(tm[2] ?? '')
    })
    return { value: text, numeric: false, formula: formula || null }
  }

  const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)
  const raw = vm ? decodeXml(vm[1]) : ''

  if (t === 's') {
    const i = parseInt(raw, 10)
    return { value: Number.isFinite(i) ? sst[i] ?? '' : '', numeric: false, formula: formula || null }
  }
  if (t === 'b') {
    return { value: raw === '1' || raw.toLowerCase() === 'true' ? 'TRUE' : 'FALSE', numeric: false, formula: formula || null }
  }
  if (t === 'str' || t === 'e' || t === 'd') {
    return { value: raw, numeric: false, formula: formula || null }
  }
  // t === 'n' 或省略：数值
  if (raw === '') return { value: '', numeric: false, formula: formula || null }
  const n = Number(raw)
  return {
    value: Number.isFinite(n) ? String(n) : raw,
    numeric: Number.isFinite(n),
    formula: formula || null,
  }
}

// ---------------------------------------------------------------- 工作表

interface ParseContext {
  sst: string[]
  xfs: XF[]
  fonts: XFont[]
  fills: XFill[]
  borders: XBorderBox[]
  theme: string[]
  numFmts: Record<number, string>
}

function fontToCss(name: string | undefined): string | undefined {
  if (!name) return undefined
  const safe = name.replace(/"/g, '')
  return `"${safe}", "Microsoft YaHei", sans-serif`
}

function buildCellStyle(
  sIdx: number | undefined,
  numeric: boolean,
  ctx: ParseContext
): { style?: CellStyle; numfmt?: string } {
  const xf = sIdx != null ? ctx.xfs[sIdx] : undefined
  if (!xf) return {}
  const style: CellStyle = {}
  let numfmt: string | undefined

  if (xf.numFmtId != null && xf.numFmtId !== 0) {
    numfmt = ctx.numFmts[xf.numFmtId] ?? BUILTIN_NUMFMT[xf.numFmtId]
    if (numfmt) style.numfmt = numfmt
  }

  if (xf.applyFont !== false && xf.fontId != null) {
    const f = ctx.fonts[xf.fontId]
    if (f) {
      if (f.name) style.font = fontToCss(f.name)
      if (f.size) style.size = Math.max(6, Math.round((f.size * 4) / 3))
      if (f.bold) style.bold = true
      if (f.italic) style.italic = true
      if (f.underline) style.underline = true
      if (f.strike) style.strike = true
      if (f.color) style.color = f.color
    }
  }

  if (xf.applyFill !== false && xf.fillId != null) {
    const fill = ctx.fills[xf.fillId]
    if (fill && fill.pattern === 'solid') {
      const bg = fill.fg || fill.bg
      if (bg) style.bg = bg
    }
  }

  if (xf.applyBorder !== false && xf.borderId != null) {
    const box = ctx.borders[xf.borderId]
    if (box && (box.top || box.left || box.bottom || box.right)) {
      style.border = {
        t: box.top,
        l: box.left,
        b: box.bottom,
        r: box.right,
      }
    }
  }

  const al = xf.alignment
  if (al) {
    if (al.wrapText) style.wrap = true
    if (al.horizontal) {
      const h = al.horizontal.toLowerCase()
      if (h === 'left' || h === 'center' || h === 'right') style.align = h
      else if (h === 'just' || h === 'justify') style.align = 'left'
      else if (h === 'centercontinuous') style.align = 'center'
      else if (h === 'general') style.align = numeric ? 'right' : 'left'
    }
    if (al.vertical) {
      const v = al.vertical.toLowerCase()
      if (v === 'top' || v === 'bottom') style.valign = v
      else if (v === 'center' || v === 'just' || v === 'justify') style.valign = 'middle'
    }
  } else if (numeric) {
    // 与 Excel 一致：数值默认右对齐，文本默认左对齐
    style.align = 'right'
  }

  const hasAny = Object.keys(style).length > 0
  return { style: hasAny ? style : undefined, numfmt }
}

interface ParsedGrid {
  rows: CellData[][]
  merges: MergeInfo[]
  colw: Record<number, number>
  rowh: Record<number, number>
}

function parseWorksheet(xml: string, ctx: ParseContext): ParsedGrid {
  // ---- 列宽 ----
  const colw: Record<number, number> = {}
  const colsBlock = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml)
  if (colsBlock) {
    eachMatch(colsBlock[1], /<col\b([^>]*?)(?:\/>|>[\s\S]*?<\/col>)/gi, (m) => {
      const w = attr(m[1], 'width')
      if (w == null) return
      const width = parseFloat(w)
      if (!Number.isFinite(width)) return
      const min = parseInt(attr(m[1], 'min') ?? '1', 10)
      const max = parseInt(attr(m[1], 'max') ?? String(min), 10)
      // Excel：px ≈ round(字符宽 * 7) + 5（默认 Calibri 11 / 96dpi）
      const px = Math.min(1200, Math.max(28, Math.round(width * 7) + 5))
      for (let c = min - 1; c <= max - 1; c++) colw[c] = px
    })
  }

  // ---- 合并单元格 ----
  const merges: MergeInfo[] = []
  const mergeBlock = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(xml)
  if (mergeBlock) {
    eachMatch(mergeBlock[1], /<mergeCell\b([^>]*?)(?:\/>|>[\s\S]*?<\/mergeCell>)/gi, (m) => {
      const ref = attr(m[1], 'ref')
      if (!ref) return
      const r = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(ref.trim())
      if (!r) return
      const c1 = colToIndex(r[1].toUpperCase())
      const r1 = parseInt(r[2], 10) - 1
      const c2 = colToIndex(r[3].toUpperCase())
      const r2 = parseInt(r[4], 10) - 1
      merges.push({
        r: Math.min(r1, r2),
        c: Math.min(c1, c2),
        rs: Math.abs(r2 - r1) + 1,
        cs: Math.abs(c2 - c1) + 1,
      })
    })
  }

  // ---- 单元格 ----
  const sparse = new Map<number, Map<number, CellData>>()
  const rowh: Record<number, number> = {}
  let maxR = -1
  let maxC = -1
  let rowCursor = 0

  eachMatch(xml, /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gi, (rm) => {
    const attrs = rm[1] ?? ''
    const body = rm[2] ?? ''
    const rAttr = attr(attrs, 'r')
    const rIdx = rAttr ? parseInt(rAttr, 10) - 1 : rowCursor
    rowCursor = rIdx + 1

    const ht = attr(attrs, 'ht')
    const customHeight = attr(attrs, 'customHeight')
    if (ht && (customHeight === '1' || customHeight === 'true')) {
      const pt = parseFloat(ht)
      if (Number.isFinite(pt)) rowh[rIdx] = Math.max(16, Math.round((pt * 4) / 3))
    }

    let colCursor = 0
    eachMatch(body, /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi, (cm) => {
      const cAttrs = cm[1] ?? ''
      const cBody = cm[2] ?? ''
      const ref = attr(cAttrs, 'r')
      let cIdx: number
      let realR: number
      if (ref) {
        const m = /^([A-Z]+)(\d+)$/i.exec(ref.trim())
        if (m) {
          cIdx = colToIndex(m[1].toUpperCase())
          realR = parseInt(m[2], 10) - 1
        } else {
          cIdx = colCursor
          realR = rIdx
        }
      } else {
        cIdx = colCursor
        realR = rIdx
      }
      colCursor = cIdx + 1

      const t = attr(cAttrs, 't')
      const sStr = attr(cAttrs, 's')
      const sIdx = sStr != null ? parseInt(sStr, 10) : undefined
      const raw = readCellValue(cBody, t, ctx.sst)

      let value = raw.value
      // 公式：仅在落到轻量引擎能力范围内时保留公式文本，否则用缓存值，避免出现 #ERR
      if (raw.formula && SAFE_FORMULA.test(raw.formula)) {
        value = '=' + raw.formula.replace(/^=/, '')
      }

      const { style } = buildCellStyle(Number.isFinite(sIdx) ? sIdx : undefined, raw.numeric, ctx)
      const cell: CellData = style ? { v: value, s: style } : { v: value }

      let rowMap = sparse.get(realR)
      if (!rowMap) {
        rowMap = new Map<number, CellData>()
        sparse.set(realR, rowMap)
      }
      rowMap.set(cIdx, cell)
      if (realR > maxR) maxR = realR
      if (cIdx > maxC) maxC = cIdx
    })
  })

  // ---- 稠密化：把空洞补成空单元格，避免下游出现 undefined ----
  const rowCount = Math.max(maxR + 1, 1)
  const colCount = Math.max(maxC + 1, 1)
  const rows: CellData[][] = []
  for (let r = 0; r < rowCount; r++) {
    const rowMap = sparse.get(r)
    const line: CellData[] = new Array(colCount)
    for (let c = 0; c < colCount; c++) {
      line[c] = rowMap?.get(c) ?? { v: '' }
    }
    rows.push(line)
  }

  return { rows, merges, colw, rowh }
}

// ---------------------------------------------------------------- 入口

function pickZip(files: Record<string, Uint8Array>, suffix: string): string | undefined {
  for (const key of Object.keys(files)) {
    if (key.toLowerCase().endsWith(suffix)) return key
  }
  return undefined
}

function textOf(files: Record<string, Uint8Array>, path: string | undefined): string | undefined {
  if (!path || !files[path]) return undefined
  return strFromU8(files[path])
}

/**
 * 读取 .xlsx，返回带完整样式的模型。
 * 若文件不是 zip 容器（.xls / .csv 等）则抛错，交由调用方回退。
 */
export function readXlsxFull(buffer: ArrayBuffer | Uint8Array): ImportedSheetModel[] {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let rawZip: Record<string, Uint8Array>
  try {
    rawZip = unzipSync(u8)
  } catch (e) {
    throw new Error('NOT_ZIP:' + (e instanceof Error ? e.message : String(e)))
  }
  const files: Record<string, Uint8Array> = {}
  for (const key of Object.keys(rawZip)) {
    files[key.replace(/^\/+/, '').replace(/\\/g, '/')] = rawZip[key]
  }

  const wbPath = pickZip(files, 'xl/workbook.xml') || pickZip(files, 'workbook.xml')
  if (!wbPath) throw new Error('NOT_XLSX:缺少 workbook.xml')
  const wbXml = textOf(files, wbPath)!
  const baseDir = wbPath.includes('/') ? wbPath.slice(0, wbPath.lastIndexOf('/') + 1) : ''

  // rId -> target，同时记录 关系类型 -> target（styles 的 rId 不固定，必须按类型找）
  const relsPath = `${baseDir}_rels/workbook.xml.rels`
  const relsXml = textOf(files, relsPath)
  const relMap: Record<string, string> = {}
  const relByType: Record<string, string> = {}
  if (relsXml) {
    eachMatch(relsXml, /<Relationship\b([^>]*?)(?:\/>|>[\s\S]*?<\/Relationship>)/gi, (m) => {
      const id = attr(m[1], 'Id')
      let target = attr(m[1], 'Target')
      const type = attr(m[1], 'Type')
      if (!id || !target) return
      target = target.replace(/^\/+/, '')
      relMap[id] = baseDir + target
      if (type) {
        const short = type.split('/').pop()?.toLowerCase() || ''
        relByType[short] = baseDir + target
      }
    })
  }

  // 样式表：优先按关系类型定位，找不到再按路径兜底
  // （不能按 rId2 猜——只有单工作表时 styles 才是 rId2，多工作表会错认成 sheet2.xml）
  const stylesPath =
    relByType['styles'] && files[relByType['styles']]
      ? relByType['styles']
      : pickZip(files, 'xl/styles.xml')
  const stylesXml = textOf(files, stylesPath) ?? ''
  const themePath = pickZip(files, 'xl/theme/theme1.xml')
  const theme = parseTheme(textOf(files, themePath))

  const ctx: ParseContext = {
    sst: parseSharedStrings(textOf(files, pickZip(files, 'xl/sharedStrings.xml'))),
    xfs: parseCellXfs(stylesXml),
    fonts: parseFonts(stylesXml, theme),
    fills: parseFills(stylesXml, theme),
    borders: parseBorders(stylesXml, theme),
    theme,
    numFmts: parseNumFmts(stylesXml),
  }

  // 工作表清单
  const result: ImportedSheetModel[] = []
  const sheetsBlock = /<sheets\b[^>]*>([\s\S]*?)<\/sheets>/.exec(wbXml)
  if (!sheetsBlock) throw new Error('NOT_XLSX:workbook 中没有工作表')

  const entries: { name: string; path: string }[] = []
  eachMatch(sheetsBlock[1], /<sheet\b([^>]*?)(?:\/>|>[\s\S]*?<\/sheet>)/gi, (m) => {
    const attrs = m[1] ?? ''
    const name = attr(attrs, 'name') ?? 'Sheet'
    const rid = attr(attrs, 'r:id') ?? attr(attrs, 'id')
    let path = rid && relMap[rid] ? relMap[rid] : undefined
    if (!path || !files[path]) {
      // 兜底：按出现顺序猜 sheetN.xml
      path = `${baseDir}worksheets/sheet${entries.length + 1}.xml`
    }
    entries.push({ name, path })
  })

  const usedNames = new Set<string>()
  for (const entry of entries) {
    const sheetXml = textOf(files, entry.path)
    if (!sheetXml) continue
    const grid = parseWorksheet(sheetXml, ctx)
    let name = entry.name
    if (usedNames.has(name)) {
      let i = 2
      while (usedNames.has(`${name}(${i})`)) i++
      name = `${name}(${i})`
    }
    usedNames.add(name)
    if (grid.rows.length === 0) grid.rows.push([{ v: '' }])
    result.push({ name: name.slice(0, 31), ...grid })
  }

  if (result.length === 0) throw new Error('NOT_XLSX:没有可读取的工作表')
  return result
}
