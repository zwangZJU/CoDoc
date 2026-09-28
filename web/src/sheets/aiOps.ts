/**
 * 表格智能体的「指令块」协议：解析 + 执行 + 撤销
 *
 * 协议面：智能体在回复正文里附一段 ```sheet-ops 的 JSON：
 *   {"ops":[{"op":"write","range":"A1","values":[["合计"]]}],"summary":"…"}
 * 前端把它落到真实的表格上（走 SheetApi，因此天然参与协同同步与存盘），
 * 读取类 op 的结果回灌给智能体，写操作整体可一键撤销。
 *
 * 协议文档（注入给智能体的那一份，是真源）：server/src/aiSkill.ts —— **改协议要两边同步**。
 */
import type { SheetApi, CellStyle, BorderSide, BorderMode } from './useSheet'
import { colToIndex, indexToCol } from './refs'

export interface Range4 {
  r1: number
  c1: number
  r2: number
  c2: number
}

/** 一条指令的原始形态（智能体给的 JSON，字段全是未知输入，执行前一律校验） */
export interface RawOp {
  op?: string
  range?: string
  sheet?: string
  values?: unknown
  style?: unknown
  mode?: string
  side?: unknown
  byCol?: unknown
  dir?: string
  what?: string
  code?: string
  url?: string
  text?: string
  author?: string
  rows?: number
  cols?: number
  col?: string
  row?: number
  px?: number
  include?: string
}

export interface OpResult {
  op: string
  range: string
  ok: boolean
  detail: string
  /** 读取到的内容（仅 read），用于回灌给智能体 */
  read?: string
}

export interface Snapshot {
  cells: { r: number; c: number; v: string; s?: CellStyle }[]
  merges: { r: number; c: number; rs: number; cs: number }[]
}

export interface OpsRunResult {
  ops: OpResult[]
  /** 执行的指令条数（不含解析失败） */
  applied: number
  changedCells: number
  summary: string
  snapshot: Snapshot | null
  errors: string[]
}

/* ------------------------------------------------------------------ 解析 */

const FENCE = /```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)```/g
const OP_LANGS = ['sheet-ops', 'sheetops', 'sheet-op', 'sheet_op', 'sheet']

/** 判定一个围栏块是不是指令块；是则返回解析结果 */
function matchOpsBlock(langRaw: string, bodyRaw: string): { ops: RawOp[]; summary?: string; broken?: boolean } | null {
  const lang = (langRaw || '').toLowerCase()
  const body = (bodyRaw || '').trim()
  if (!body || body[0] !== '{') return null
  const isOpLang = OP_LANGS.includes(lang)
  let j: any = null
  try {
    j = JSON.parse(body)
  } catch {
    // 明确标了 sheet-ops 却写坏了：回传一条空结果，让调用方能提示"解析失败"
    return isOpLang ? { ops: [], summary: '指令块 JSON 解析失败', broken: true } : null
  }
  if (!j || typeof j !== 'object') return null
  const list = Array.isArray(j.ops) ? j.ops : Array.isArray(j) ? j : null
  if (!list) return null
  // 裸 JSON 块要求带 ops 字段，避免把用户贴的普通 JSON 当指令执行
  if (!isOpLang && !Array.isArray(j.ops)) return null
  return { ops: list as RawOp[], summary: typeof j.summary === 'string' ? j.summary : undefined }
}

/** 从智能体正文里抽出所有指令块（按出现顺序），只认 sheet-ops 围栏，或内容为 {"ops":[…]} 的裸 JSON 块 */
export function extractOpsBlocks(text: string): { ops: RawOp[]; summary?: string }[] {
  const out: { ops: RawOp[]; summary?: string }[] = []
  if (!text) return out
  FENCE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE.exec(text))) {
    const hit = matchOpsBlock(m[1], m[2])
    if (hit) out.push({ ops: hit.ops, summary: hit.summary })
  }
  return out
}

/** 正文展示用：把指令块从 Markdown 里抹掉，免得用户看到一堆 JSON（执行结果另有气泡） */
export function stripOpsBlocks(text: string): string {
  if (!text) return text
  return text.replace(FENCE, (whole, lang, body) => (matchOpsBlock(lang, body) ? '' : whole))
}

/** A1 表示法 → 0-based 区域。支持 A1 / A1:C3 / A:A / 3:5 / $A$1 */
export function parseRange(ref: string, sheet: SheetApi): Range4 | null {
  if (!ref || typeof ref !== 'string') return null
  const s = ref.replace(/\$/g, '').trim()
  if (!s) return null
  const parts = s.split(':')
  const one = (p: string): { col?: number; row?: number } | null => {
    const t = p.trim().toUpperCase()
    const mCell = /^([A-Z]+)(\d+)$/.exec(t)
    if (mCell) return { col: colToIndex(mCell[1]), row: parseInt(mCell[2], 10) - 1 }
    if (/^[A-Z]+$/.test(t)) return { col: colToIndex(t) }
    if (/^\d+$/.test(t)) return { row: parseInt(t, 10) - 1 }
    return null
  }
  const a = one(parts[0])
  if (!a) return null
  const b = parts.length > 1 ? one(parts[1]) : a
  if (!b) return null
  // 允许略微超出当前表（写值会自动扩表），但拒绝"HELLO"这种被当成列字母的乱写
  const maxR = sheet.rowCount + 200
  const maxC = sheet.colCount + 26
  for (const p of [a, b]) {
    if (p.col != null && (p.col < 0 || p.col >= maxC)) return null
    if (p.row != null && (p.row < 0 || p.row >= maxR)) return null
  }
  const maxR2 = Math.max(0, sheet.rowCount - 1)
  const maxC2 = Math.max(0, sheet.colCount - 1)
  const r1 = Math.min(a.row ?? 0, b.row ?? 0)
  const r2 = Math.max(a.row ?? maxR2, b.row ?? maxR2)
  const c1 = Math.min(a.col ?? 0, b.col ?? 0)
  const c2 = Math.max(a.col ?? maxC2, b.col ?? maxC2)
  return { r1, c1, r2, c2 }
}

export function rangeLabel(r: Range4): string {
  const a = indexToCol(r.c1) + (r.r1 + 1)
  return r.r1 === r.r2 && r.c1 === r.c2 ? a : `${a}:${indexToCol(r.c2)}${r.r2 + 1}`
}

/* ------------------------------------------------------------ 输入净化 */

const BORDER_MODES: BorderMode[] = [
  'clear',
  'outer',
  'inner',
  'all',
  'inner-h',
  'inner-v',
  'top',
  'bottom',
  'left',
  'right',
]

function sanitizeStyle(input: unknown): Partial<CellStyle> {
  const out: Partial<CellStyle> = {}
  if (!input || typeof input !== 'object') return out
  const s = input as Record<string, any>
  if (typeof s.font === 'string') out.font = s.font.slice(0, 64)
  if (typeof s.size === 'number' && s.size >= 5 && s.size <= 96) out.size = Math.round(s.size)
  for (const k of ['bold', 'italic', 'underline', 'strike', 'wrap'] as const) {
    if (typeof s[k] === 'boolean') out[k] = s[k]
  }
  if (s.align === 'left' || s.align === 'center' || s.align === 'right') out.align = s.align
  if (s.valign === 'top' || s.valign === 'middle' || s.valign === 'bottom') out.valign = s.valign
  if (typeof s.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.color)) out.color = s.color
  if (typeof s.bg === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.bg)) out.bg = s.bg
  if (typeof s.numfmt === 'string') out.numfmt = s.numfmt.slice(0, 40)
  if (s.rotate === 0 || s.rotate === 45 || s.rotate === -45 || s.rotate === 90) out.rotate = s.rotate
  return out
}

function sanitizeSide(input: unknown): BorderSide | null {
  if (!input || typeof input !== 'object') return { w: 1, c: '#000000', s: 'solid' }
  const b = input as Record<string, any>
  const w = b.w === 2 || b.w === 3 ? b.w : 1
  const c = typeof b.c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(b.c) ? b.c : '#000000'
  const s = b.s === 'dashed' || b.s === 'dotted' || b.s === 'double' ? b.s : 'solid'
  return { w, c, s }
}

function toGrid(input: unknown): string[][] {
  if (!Array.isArray(input)) return []
  return (input as unknown[]).map((row) =>
    Array.isArray(row)
      ? (row as unknown[]).map((v) => (v == null ? '' : String(v)))
      : [row == null ? '' : String(row)]
  )
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/* ------------------------------------------------------------------ 执行 */

/** 需要 range 才能干活的操作 */
const RANGE_OPS = [
  'read',
  'write',
  'style',
  'border',
  'merge',
  'unmerge',
  'clear',
  'sort',
  'numfmt',
  'link',
  'comment',
]

/** 执行一条指令块。sheetName 用于拒绝跨表操作（当前只作用于用户正在看的表） */
export function runOps(
  sheet: SheetApi,
  ops: RawOp[],
  sheetName: string,
  author = '智能助手',
  presetSnapshot?: Snapshot | null
): OpsRunResult {
  const results: OpResult[] = []
  const errors: string[] = []
  let changedCells = 0
  // 撤销快照：先把所有写操作涉及的区域并起来，执行前整块留档
  // （一次回复可能有多个指令块，由调用方统一留档后传进来，保证撤销能回到最初状态）
  const snapshot: Snapshot | null =
    presetSnapshot !== undefined ? presetSnapshot : takeSnapshotFor(sheet, ops)

  for (const raw of ops) {
    const name = String(raw.op || '').toLowerCase()
    const ref = String(raw.range || '')
    // 跨工作表暂不支持：智能体能看见当前表名，写错了要明确告知而不是默默改错表
    if (raw.sheet && raw.sheet !== sheetName) {
      results.push({ op: name || '?', range: ref, ok: false, detail: `暂不支持跨工作表操作（当前表「${sheetName}」）` })
      continue
    }
    const r = RANGE_OPS.includes(name) ? parseRange(ref, sheet) : null
    if (!r) {
      // freeze / colw / rowh 不带 range；其余缺 range 一律视为指令写错了
      if (['freeze', 'colw', 'rowh'].includes(name)) {
        /* 这几种不需要 range */
      } else {
        results.push({ op: name || '?', range: ref, ok: false, detail: `无法识别的操作或区域：${name || '空'} ${ref}` })
        continue
      }
    }
    const rr = r as Range4
    switch (name) {
      case 'read': {
        const text = readRange(sheet, rr, raw.include)
        results.push({ op: 'read', range: rangeLabel(rr), ok: true, detail: `读取 ${rr.r2 - rr.r1 + 1} 行 × ${rr.c2 - rr.c1 + 1} 列`, read: text })
        break
      }
      case 'write': {
        const grid = toGrid(raw.values)
        if (!grid.length) {
          results.push({ op: 'write', range: rangeLabel(rr), ok: false, detail: 'values 为空' })
          break
        }
        let n = 0
        for (let i = 0; i < grid.length; i++) {
          const row = rr.r1 + i
          if (row > rr.r2 || row >= sheet.rowCount) break
          for (let j = 0; j < grid[i].length; j++) {
            const col = rr.c1 + j
            if (col > rr.c2 || col >= sheet.colCount) break
            sheet.setCellValue(row, col, grid[i][j])
            n++
          }
        }
        changedCells += n
        results.push({ op: 'write', range: rangeLabel(rr), ok: true, detail: `写入 ${n} 个单元格` })
        break
      }
      case 'style': {
        const patch = sanitizeStyle(raw.style)
        if (!Object.keys(patch).length) {
          results.push({ op: 'style', range: rangeLabel(rr), ok: false, detail: 'style 为空或字段都不合法' })
          break
        }
        sheet.applyStyleRange(rr.r1, rr.c1, rr.r2, rr.c2, patch)
        changedCells += (rr.r2 - rr.r1 + 1) * (rr.c2 - rr.c1 + 1)
        results.push({ op: 'style', range: rangeLabel(rr), ok: true, detail: `应用样式 ${Object.keys(patch).join('、')}` })
        break
      }
      case 'border': {
        const mode = String(raw.mode || 'all').toLowerCase() as BorderMode
        if (!BORDER_MODES.includes(mode)) {
          results.push({ op: 'border', range: rangeLabel(rr), ok: false, detail: `不支持的边框模式：${raw.mode}` })
          break
        }
        const side = mode === 'clear' ? null : sanitizeSide(raw.side)
        sheet.applyBorder(rr.r1, rr.c1, rr.r2, rr.c2, mode, side)
        changedCells += (rr.r2 - rr.r1 + 1) * (rr.c2 - rr.c1 + 1)
        results.push({
          op: 'border',
          range: rangeLabel(rr),
          ok: true,
          detail: mode === 'clear' ? '清除边框' : `设置边框（${mode}）`,
        })
        break
      }
      case 'merge': {
        sheet.mergeCells(rr.r1, rr.c1, rr.r2, rr.c2)
        results.push({ op: 'merge', range: rangeLabel(rr), ok: true, detail: '已合并' })
        break
      }
      case 'unmerge': {
        sheet.unmergeCells(rr.r1, rr.c1, rr.r2, rr.c2)
        results.push({ op: 'unmerge', range: rangeLabel(rr), ok: true, detail: '已取消合并' })
        break
      }
      case 'clear': {
        const what = raw.what === 'format' ? 'format' : raw.what === 'all' ? 'all' : 'content'
        sheet.clearRange(rr.r1, rr.c1, rr.r2, rr.c2, what)
        changedCells += (rr.r2 - rr.r1 + 1) * (rr.c2 - rr.c1 + 1)
        results.push({ op: 'clear', range: rangeLabel(rr), ok: true, detail: `清除${what === 'content' ? '内容' : what === 'format' ? '格式' : '全部'}` })
        break
      }
      case 'sort': {
        const col = typeof raw.byCol === 'number' ? raw.byCol : colToIndex(String(raw.byCol || ''))
        if (!isFinite(col) || col < rr.c1 || col > rr.c2) {
          results.push({ op: 'sort', range: rangeLabel(rr), ok: false, detail: `排序列 ${raw.byCol} 不在区域内` })
          break
        }
        const dir = raw.dir === 'desc' ? 'desc' : 'asc'
        sheet.sortRange(rr.r1, rr.c1, rr.r2, rr.c2, col, dir)
        changedCells += (rr.r2 - rr.r1 + 1) * (rr.c2 - rr.c1 + 1)
        results.push({ op: 'sort', range: rangeLabel(rr), ok: true, detail: `按 ${indexToCol(col)} 列${dir === 'asc' ? '升序' : '降序'}排序` })
        break
      }
      case 'numfmt': {
        const code = typeof raw.code === 'string' ? raw.code : ''
        sheet.setNumFmt(rr.r1, rr.c1, rr.r2, rr.c2, code)
        changedCells += (rr.r2 - rr.r1 + 1) * (rr.c2 - rr.c1 + 1)
        results.push({ op: 'numfmt', range: rangeLabel(rr), ok: true, detail: code ? `数字格式 ${code}` : '恢复常规格式' })
        break
      }
      case 'link': {
        const url = typeof raw.url === 'string' ? raw.url : ''
        let n = 0
        for (let row = rr.r1; row <= rr.r2 && row < sheet.rowCount; row++) {
          for (let col = rr.c1; col <= rr.c2 && col < sheet.colCount; col++) {
            sheet.setCellLink(row, col, url)
            n++
          }
        }
        changedCells += n
        results.push({ op: 'link', range: rangeLabel(rr), ok: true, detail: url ? `写入链接 ${n} 格` : `清除链接 ${n} 格` })
        break
      }
      case 'comment': {
        const text = String(raw.text || '')
        if (!text) {
          results.push({ op: 'comment', range: rangeLabel(rr), ok: false, detail: '批注内容为空' })
          break
        }
        sheet.setComment(rr.r1, rr.c1, text, String(raw.author || author))
        results.push({ op: 'comment', range: rangeLabel(rr), ok: true, detail: '已加批注' })
        break
      }
      case 'freeze': {
        const rows = clamp(Number(raw.rows) || 0, 0, sheet.rowCount - 1)
        const cols = clamp(Number(raw.cols) || 0, 0, sheet.colCount - 1)
        sheet.setFrozen(rows, cols)
        results.push({ op: 'freeze', range: '-', ok: true, detail: `冻结 ${rows} 行 ${cols} 列` })
        break
      }
      case 'colw': {
        const c = colToIndex(String(raw.col || ''))
        const px = clamp(Number(raw.px) || 0, 20, 800)
        if (!isFinite(c) || c < 0) {
          results.push({ op: 'colw', range: String(raw.col || ''), ok: false, detail: '列号无效' })
          break
        }
        sheet.setColWidth(c, px)
        results.push({ op: 'colw', range: indexToCol(c), ok: true, detail: `列宽 ${px}px` })
        break
      }
      case 'rowh': {
        const row = clamp((Number(raw.row) || 1) - 1, 0, sheet.rowCount - 1)
        const px = clamp(Number(raw.px) || 0, 12, 400)
        sheet.setRowHeight(row, px)
        results.push({ op: 'rowh', range: String(row + 1), ok: true, detail: `行高 ${px}px` })
        break
      }
      default:
        results.push({ op: String(raw.op || '?'), range: ref, ok: false, detail: '不支持的操作' })
    }
  }

  return {
    ops: results,
    applied: results.filter((x) => x.ok).length,
    changedCells,
    summary: '',
    snapshot,
    errors,
  }
}

/* ------------------------------------------------------------------ 读取 */

const STYLE_CAP = 60

function readRange(sheet: SheetApi, r: Range4, include?: string): string {
  const rows = r.r2 - r.r1 + 1
  const cols = r.c2 - r.c1 + 1
  const head = `${rangeLabel(r)}（${rows} 行 × ${cols} 列）`
  // 值：用 rangeToTsv 保持与剪贴板一致的转义规则（含换行的单元格不会串列）
  let text = sheet.rangeToTsv(r.r1, r.c1, r.r2, r.c2)
  const total = rows * cols
  if (total > 800) text += `\n…（共 ${total} 个单元格，超出部分省略）`
  if (include !== 'style' && include !== 'both') return `${head}：\n${text}`

  // 样式摘要：只报有样式的格子，够智能体判断"哪里加粗/有边框"即可
  const lines: string[] = []
  let n = 0
  for (let row = r.r1; row <= r.r2 && n < STYLE_CAP; row++) {
    for (let col = r.c1; col <= r.c2 && n < STYLE_CAP; col++) {
      // 用 getStyleAt 走 Yjs 直读，而不是 sheet.rows（React state 在同一轮里可能还没刷新）
      const s = sheet.getStyleAt(row, col)
      if (!s) continue
      const bits: string[] = []
      if (s.bold) bits.push('bold')
      if (s.italic) bits.push('italic')
      if (s.underline) bits.push('underline')
      if (s.bg) bits.push('bg=' + s.bg)
      if (s.color) bits.push('color=' + s.color)
      if (s.align) bits.push('align=' + s.align)
      if (s.numfmt) bits.push('numfmt=' + s.numfmt)
      if (s.border) {
        const sides = (['t', 'b', 'l', 'r'] as const).filter((k) => s.border?.[k])
        if (sides.length) bits.push('border=' + sides.join(''))
      }
      if (bits.length) {
        lines.push(`${indexToCol(col)}${row + 1}: ${bits.join(' ')}`)
        n++
      }
    }
  }
  const styleTxt = lines.length ? lines.join('\n') : '（该区域没有设置过样式）'
  return `${head}：\n${text}\n\n样式：\n${styleTxt}`
}

/* ------------------------------------------------------------------ 撤销 */

/** 两个区域取并集 */
export function unionBox(a: Range4 | null, b: Range4 | null): Range4 | null {
  if (!a) return b
  if (!b) return a
  return {
    r1: Math.min(a.r1, b.r1),
    c1: Math.min(a.c1, b.c1),
    r2: Math.max(a.r2, b.r2),
    c2: Math.max(a.c2, b.c2),
  }
}

/** 一组指令会动到的区域（read 不算），用来决定撤销要留多大一块 */
export function opsBox(sheet: SheetApi, ops: RawOp[]): Range4 | null {
  let box: Range4 | null = null
  for (const raw of ops) {
    const name = String(raw.op || '').toLowerCase()
    if (name === 'read') continue
    if (['freeze', 'colw', 'rowh'].includes(name)) continue
    const r = parseRange(String(raw.range || ''), sheet)
    if (r) box = unionBox(box, r)
  }
  return box
}

/** 按一组指令的影响范围留档（单指令块场景用） */
export function takeSnapshotFor(sheet: SheetApi, ops: RawOp[]): Snapshot | null {
  const box = opsBox(sheet, ops)
  return box ? takeSnapshot(sheet, box) : null
}

const SNAP_CAP = 4000

/** 留档：区域内每个格子的值与样式，外加当前所有合并（撤销时据此还原） */
export function takeSnapshot(sheet: SheetApi, box: Range4): Snapshot {
  const cells: Snapshot['cells'] = []
  let n = 0
  for (let r = box.r1; r <= box.r2 && n < SNAP_CAP; r++) {
    for (let c = box.c1; c <= box.c2 && n < SNAP_CAP; c++) {
      const cell = sheet.rows[r]?.[c]
      cells.push({ r, c, v: cell?.v ?? '', s: cell?.s ? { ...cell.s } : undefined })
      n++
    }
  }
  return { cells, merges: sheet.merges.map((m) => ({ ...m })) }
}

/** 回滚一次执行：先拆掉区域内的合并，再逐格还原值与样式，最后重建原来的合并 */
export function revertSnapshot(sheet: SheetApi, snap: Snapshot): void {
  if (!snap.cells.length) return
  const r1 = Math.min(...snap.cells.map((x) => x.r))
  const r2 = Math.max(...snap.cells.map((x) => x.r))
  const c1 = Math.min(...snap.cells.map((x) => x.c))
  const c2 = Math.max(...snap.cells.map((x) => x.c))
  const inBox = (m: { r: number; c: number; rs: number; cs: number }) =>
    m.r >= r1 && m.c >= c1 && m.r + m.rs - 1 <= r2 && m.c + m.cs - 1 <= c2
  // 撤销期间新增的合并先拆掉（只动本次操作范围内、且不在原快照里的）
  const old = new Set(snap.merges.map((m) => `${m.r},${m.c},${m.rs},${m.cs}`))
  for (const m of sheet.merges) {
    if (inBox(m) && !old.has(`${m.r},${m.c},${m.rs},${m.cs}`)) {
      sheet.unmergeCells(m.r, m.c, m.r + m.rs - 1, m.c + m.cs - 1)
    }
  }
  for (const cell of snap.cells) {
    sheet.setCellValue(cell.r, cell.c, cell.v)
    sheet.applyStyleObject(cell.r, cell.c, cell.r, cell.c, cell.s, 'replace')
  }
  for (const m of snap.merges) sheet.mergeCells(m.r, m.c, m.r + m.rs - 1, m.c + m.cs - 1)
}

/* -------------------------------------------------------------- 回灌文本 */

/** 把执行结果拼成给智能体看的「工具结果」，让它据此继续（尤其是 read 的数据） */
export function formatToolResult(res: OpsRunResult): string {
  const lines: string[] = ['【工具结果】你上一步的指令已执行：']
  for (const o of res.ops) {
    lines.push(`- ${o.op} ${o.range}：${o.ok ? o.detail : '失败 — ' + o.detail}`)
    if (o.read != null) {
      lines.push('```')
      lines.push(o.read)
      lines.push('```')
    }
  }
  lines.push('')
  lines.push('请基于上面的真实数据继续。如果已经拿到需要的信息，就输出最终答案；需要改表就再给一个指令块。')
  return lines.join('\n')
}
