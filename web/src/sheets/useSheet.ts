import * as Y from 'yjs'
import { UndoManager } from 'yjs'
import { useEffect, useMemo, useState } from 'react'
import { colToIndex } from './refs'
import { evalFormula } from './formula'

export const DEFAULT_ROWS = 50
export const DEFAULT_COLS = 26
export const DEFAULT_COL_W = 72
export const DEFAULT_ROW_H = 28

/** 本地事务 origin：仅本地用户操作会被 UndoManager 追踪（远端 provider、初始化用别的 origin） */
const LOCAL = Symbol('local-edit')
/** 初始化 / 导入事务 origin：不被 UndoManager 追踪（避免撤销把整张表删掉） */
const INIT = Symbol('init')

export interface BorderSide {
  /** 线宽（px）：1=细 2=中 3=粗 */
  w: number
  /** 颜色 */
  c: string
  /** 线型，缺省 solid */
  s?: 'solid' | 'dashed' | 'dotted' | 'double'
}
/** 边框落笔模式（对齐飞书边框面板的 10 个图标） */
export type BorderMode =
  | 'clear'
  | 'outer'
  | 'inner'
  | 'all'
  | 'inner-h'
  | 'inner-v'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
export interface CellStyle {
  font?: string
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  wrap?: boolean
  align?: 'left' | 'center' | 'right'
  valign?: 'top' | 'middle' | 'bottom'
  border?: { t?: BorderSide; l?: BorderSide; b?: BorderSide; r?: BorderSide }
  /** 数字格式代码（来自 xlsx 的 numFmt，如 "0.00%"） */
  numfmt?: string
  /** 字体颜色 */
  color?: string
  /** 单元格底色 */
  bg?: string
  /** 单元格超链接（飞书「插入 → 链接」）：点击单元格文本可打开 */
  link?: string
  /** 文本旋转角度（度），暂只支持 0 / 45 / -45 / 90 */
  rotate?: number
}
export interface CellData {
  v: string
  s?: CellStyle
}
/** 单元格批注（飞书「评论」的轻量实现，随文档协同同步） */
export interface CellComment {
  text: string
  author: string
  ts: number
}
/** 冻结行列数（0 表示不冻结） */
export interface FrozenInfo {
  rows: number
  cols: number
}
export interface MergeInfo {
  r: number
  c: number
  rs: number
  cs: number
}

function emptyCell(): CellData {
  return { v: '' }
}

function makeEmptySheet(): Y.Array<Y.Array<CellData>> {
  const arr = new Y.Array<Y.Array<CellData>>()
  for (let r = 0; r < DEFAULT_ROWS; r++) {
    const row = new Y.Array<CellData>()
    const cells: CellData[] = []
    for (let c = 0; c < DEFAULT_COLS; c++) cells.push(emptyCell())
    row.insert(0, cells)
    arr.push([row])
  }
  return arr
}

// ---------------------------------------------------------------- TSV 编解码

/**
 * 单元格文本 -> TSV 字段。
 * 含换行 / 制表符 / 引号时按 Excel 的规矩用双引号包起来，
 * 这样「一个带回车的单元格」复制出去再粘回来，仍然落在同一个格子里。
 */
export function tsvCell(v: string): string {
  return /["\t\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

/**
 * 解析 TSV（Excel / 飞书 / 本表格复制出来的格式），支持双引号包裹的字段。
 * 引号里的换行属于单元格内容，不会被当成「换一行」。
 */
export function parseTsv(text: string): string[][] {
  const s = text.replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let started = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
      continue
    }
    // 只有出现在「字段开头」的引号才是包裹符，字段中间的引号按普通字符处理
    if (ch === '"' && !started) {
      inQuotes = true
      started = true
      continue
    }
    if (ch === '\t') {
      row.push(field)
      field = ''
      started = false
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      started = false
      continue
    }
    field += ch
    started = true
  }
  row.push(field)
  rows.push(row)
  // 复制时末尾常带一个换行，收掉它，避免多粘出一个空行
  while (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop()
  }
  return rows
}

export interface SheetApi {
  rows: CellData[][]
  rowCount: number
  colCount: number
  sheetNames: string[]
  activeSheet: string
  merges: MergeInfo[]
  colw: Record<number, number>
  rowh: Record<number, number>
  /** 当前工作表冻结的行列数 */
  frozen: FrozenInfo
  /** 当前工作表全部批注，key = "r,c" */
  comments: Record<string, CellComment>
  addSheet: (n?: string) => string
  renameSheet: (from: string, to: string) => boolean
  deleteSheet: (name: string) => boolean
  copySheet: (name: string) => string | null
  clearSheet: () => void
  setCellValue: (r: number, c: number, v: string) => void
  getCellRaw: (ref: string) => string
  applyStyleRange: (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    patch: Partial<CellStyle>
  ) => void
  applyBorder: (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    mode: BorderMode,
    bstyle: BorderSide | null
  ) => void
  mergeCells: (r1: number, c1: number, r2: number, c2: number) => void
  unmergeCells: (r1: number, c1: number, r2: number, c2: number) => void
  addRow: (at: number) => void
  deleteRow: (at: number) => void
  addCol: (at: number) => void
  deleteCol: (at: number) => void
  setColWidth: (c: number, px: number) => void
  setRowHeight: (r: number, px: number) => void
  /** 清空范围：内容 / 格式 / 两者 */
  clearRange: (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    what: 'content' | 'format' | 'all'
  ) => void
  /** 取某格样式快照（格式刷用） */
  getStyleAt: (r: number, c: number) => CellStyle | undefined
  /** 整体套用一份样式（格式刷落笔）：replace = 覆盖，merge = 逐项叠加 */
  applyStyleObject: (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    style: CellStyle | undefined,
    mode?: 'replace' | 'merge'
  ) => void
  /** 区域内按某列排序（整行跟随移动） */
  sortRange: (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    byCol: number,
    dir: 'asc' | 'desc'
  ) => void
  /** 批量设置数字格式；code 为空表示恢复「常规」 */
  setNumFmt: (r1: number, c1: number, r2: number, c2: number, code: string) => void
  /** 设置/清除单元格超链接 */
  setCellLink: (r: number, c: number, url: string) => void
  /** 写/改批注 */
  setComment: (r: number, c: number, text: string, author: string) => void
  deleteComment: (r: number, c: number) => void
  /** 冻结首行 / 首列等 */
  setFrozen: (rows: number, cols: number) => void
  /** 选区转 TSV（复制用） */
  rangeToTsv: (r1: number, c1: number, r2: number, c2: number) => string
  /** 从剪贴板 TSV 写入（粘贴用），返回写入的行列数 */
  pasteTsv: (r: number, c: number, text: string) => { rows: number; cols: number }
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

export function useSheet(ydoc: Y.Doc, activeSheet: string): SheetApi {
  const sheets = useMemo(() => ydoc.getMap('sheets'), [ydoc])
  const mergesMap = useMemo(() => ydoc.getMap('merges'), [ydoc])
  const colwMap = useMemo(() => ydoc.getMap('colw'), [ydoc])
  const rowhMap = useMemo(() => ydoc.getMap('rowh'), [ydoc])
  const frozenMap = useMemo(() => ydoc.getMap('frozen'), [ydoc])
  const commentsMap = useMemo(() => ydoc.getMap('comments'), [ydoc])

  const [rows, setRows] = useState<CellData[][]>([])
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [merges, setMerges] = useState<MergeInfo[]>([])
  const [colw, setColw] = useState<Record<number, number>>({})
  const [rowh, setRowh] = useState<Record<number, number>>({})
  const [frozen, setFrozenState] = useState<FrozenInfo>({ rows: 0, cols: 0 })
  const [comments, setComments] = useState<Record<string, CellComment>>({})

  const sheet = sheets.get(activeSheet) as
    | Y.Array<Y.Array<CellData>>
    | undefined

  // 初始化当前 sheet 及配套 map（用 INIT origin，不进入撤销栈）
  useEffect(() => {
    const ensure = (m: Y.Map<any>) => {
      if (!m.has(activeSheet)) m.set(activeSheet, new Y.Map())
    }
    if (
      !sheets.has(activeSheet) ||
      !mergesMap.has(activeSheet) ||
      !colwMap.has(activeSheet) ||
      !rowhMap.has(activeSheet) ||
      !frozenMap.has(activeSheet) ||
      !commentsMap.has(activeSheet)
    ) {
      ydoc.transact(() => {
        if (!sheets.has(activeSheet)) sheets.set(activeSheet, makeEmptySheet())
        ensure(mergesMap)
        ensure(colwMap)
        ensure(rowhMap)
        ensure(frozenMap)
        ensure(commentsMap)
      }, INIT)
    }
  }, [sheets, mergesMap, colwMap, rowhMap, frozenMap, commentsMap, activeSheet, ydoc])

  // 数据快照
  useEffect(() => {
    if (!sheet) {
      setRows([])
      return
    }
    const sync = () => {
      const arr: CellData[][] = []
      sheet.forEach((row) => {
        const r: CellData[] = []
        row.forEach((cell: any) => {
          if (cell && typeof cell === 'object' && 'v' in cell) r.push(cell as CellData)
          else r.push({ v: cell == null ? '' : String(cell) })
        })
        arr.push(r)
      })
      setRows(arr)
    }
    sheet.observeDeep(sync)
    sync()
    return () => sheet.unobserveDeep(sync)
  }, [sheet])

  useEffect(() => {
    const sync = () => setSheetNames(Array.from(sheets.keys()))
    sheets.observe(sync)
    sync()
    return () => sheets.unobserve(sync)
  }, [sheets])

  const mergeInner = mergesMap.get(activeSheet) as Y.Map<MergeInfo> | undefined
  useEffect(() => {
    if (!mergeInner) {
      setMerges([])
      return
    }
    const sync = () => {
      const a: MergeInfo[] = []
      mergeInner.forEach((v) => a.push(v))
      setMerges(a)
    }
    mergeInner.observe(sync)
    sync()
    return () => mergeInner.unobserve(sync)
  }, [mergeInner])

  const colwInner = colwMap.get(activeSheet) as Y.Map<number> | undefined
  useEffect(() => {
    if (!colwInner) {
      setColw({})
      return
    }
    const sync = () => {
      const o: Record<number, number> = {}
      colwInner.forEach((v, k) => (o[Number(k)] = v))
      setColw(o)
    }
    colwInner.observe(sync)
    sync()
    return () => colwInner.unobserve(sync)
  }, [colwInner])

  const rowhInner = rowhMap.get(activeSheet) as Y.Map<number> | undefined
  useEffect(() => {
    if (!rowhInner) {
      setRowh({})
      return
    }
    const sync = () => {
      const o: Record<number, number> = {}
      rowhInner.forEach((v, k) => (o[Number(k)] = v))
      setRowh(o)
    }
    rowhInner.observe(sync)
    sync()
    return () => rowhInner.unobserve(sync)
  }, [rowhInner])

  // 冻结行列：per-sheet Y.Map，键 rows / cols
  const frozenInner = frozenMap.get(activeSheet) as Y.Map<number> | undefined
  useEffect(() => {
    if (!frozenInner) {
      setFrozenState({ rows: 0, cols: 0 })
      return
    }
    const sync = () =>
      setFrozenState({
        rows: Number(frozenInner.get('rows') || 0),
        cols: Number(frozenInner.get('cols') || 0),
      })
    frozenInner.observe(sync)
    sync()
    return () => frozenInner.unobserve(sync)
  }, [frozenInner])

  // 批注：per-sheet Y.Map，键 "r,c"
  const commentsInner = commentsMap.get(activeSheet) as Y.Map<CellComment> | undefined
  useEffect(() => {
    if (!commentsInner) {
      setComments({})
      return
    }
    const sync = () => {
      const o: Record<string, CellComment> = {}
      commentsInner.forEach((v, k) => (o[String(k)] = v as CellComment))
      setComments(o)
    }
    commentsInner.observe(sync)
    sync()
    return () => commentsInner.unobserve(sync)
  }, [commentsInner])

  // ---- 底层写入（不自带事务） ----
  const readCell = (r: number, c: number): CellData => rows[r]?.[c] ?? { v: '' }

  /**
   * 把整张表补到至少 needRows 行 × needCols 列（**所有行一起补**）。
   * 只补某一行会留下参差行，表格渲染时列宽错位、合并区也会跟着乱。
   */
  const ensureSize = (needRows: number, needCols: number) => {
    if (!sheet) return
    const cols = Math.max(needCols, sheet.length ? sheet.get(0)?.length ?? 0 : 0)
    for (let r = 0; r < sheet.length; r++) {
      const rowA = sheet.get(r)
      if (!rowA || rowA.length >= cols) continue
      const add: CellData[] = []
      for (let c = rowA.length; c < cols; c++) add.push(emptyCell())
      rowA.push(add)
    }
    for (let r = sheet.length; r < needRows; r++) {
      const rowA = new Y.Array<CellData>()
      const cells: CellData[] = []
      for (let c = 0; c < cols; c++) cells.push(emptyCell())
      rowA.insert(0, cells)
      sheet.push([rowA])
    }
  }

  const writeCell = (
    s: Y.Array<Y.Array<CellData>>,
    r: number,
    c: number,
    next: CellData
  ) => {
    let rowA = s.get(r)
    if (!rowA) {
      rowA = new Y.Array<CellData>()
      s.insert(r, [rowA])
    }
    while (rowA.length <= c) rowA.push([emptyCell()])
    rowA.delete(c, 1)
    rowA.insert(c, [next])
  }

  // ---- UndoManager（仅追踪本地 origin） ----
  const [undoMgr, setUndoMgr] = useState<UndoManager | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  useEffect(() => {
    if (!sheet) {
      setUndoMgr(null)
      return
    }
    // 撤销范围 = 单元格数据 + 合并 / 列宽 / 行高 / 冻结 / 批注
    // （只把当前工作表挂上去，避免撤销影响到别的工作表）
    const scope: Y.AbstractType<any>[] = [sheet]
    for (const m of [mergesMap, colwMap, rowhMap, frozenMap, commentsMap]) {
      const inner = m.get(activeSheet)
      if (inner) scope.push(inner as Y.AbstractType<any>)
    }
    const um = new UndoManager(scope, {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: 300,
    })
    setUndoMgr(um)
    return () => um.destroy()
  }, [sheet, activeSheet, mergesMap, colwMap, rowhMap, frozenMap, commentsMap])

  useEffect(() => {
    if (!undoMgr) {
      setCanUndo(false)
      setCanRedo(false)
      return
    }
    const upd = () => {
      setCanUndo(undoMgr.undoStack.length > 0)
      setCanRedo(undoMgr.redoStack.length > 0)
    }
    undoMgr.on('stack-item-added', upd)
    undoMgr.on('stack-item-popped', upd)
    undoMgr.on('stack-cleared', upd)
    upd()
    return () => {
      undoMgr.off('stack-item-added', upd)
      undoMgr.off('stack-item-popped', upd)
      undoMgr.off('stack-cleared', upd)
    }
  }, [undoMgr])

  // ---- 公共操作 ----
  const setCellValue = (r: number, c: number, v: string) => {
    if (!sheet) return
    ydoc.transact(() => {
      ensureSize(r + 1, c + 1)
      const cur = readCell(r, c)
      writeCell(sheet, r, c, { v, s: cur.s })
    }, LOCAL)
  }

  const getCellRaw = (ref: string): string => {
    const m = ref.toUpperCase().match(/^([A-Z]+)(\d+)$/)
    if (!m) return ''
    const c = colToIndex(m[1])
    const r = parseInt(m[2], 10) - 1
    return readCell(r, c).v
  }

  const applyStyleRange = (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    patch: Partial<CellStyle>
  ) => {
    if (!sheet) return
    ydoc.transact(() => {
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          const cur = readCell(r, c)
          writeCell(sheet, r, c, { v: cur.v, s: { ...(cur.s || {}), ...patch } })
        }
      }
    }, LOCAL)
  }

  const applyBorder = (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    mode: BorderMode,
    bstyle: BorderSide | null
  ) => {
    if (!sheet) return
    ydoc.transact(() => {
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          const cur = readCell(r, c)
          const b = { ...(cur.s?.border || {}) }
          const setSide = (side: 't' | 'l' | 'b' | 'r', val: BorderSide | null) => {
            if (val) b[side] = val
            else delete b[side]
          }
          const isTop = r === r1
          const isBot = r === r2
          const isLeft = c === c1
          const isRight = c === c2
          if (mode === 'all') {
            setSide('t', bstyle)
            setSide('l', bstyle)
            setSide('b', bstyle)
            setSide('r', bstyle)
          } else if (mode === 'outer') {
            if (isTop) setSide('t', bstyle)
            if (isBot) setSide('b', bstyle)
            if (isLeft) setSide('l', bstyle)
            if (isRight) setSide('r', bstyle)
          } else if (mode === 'inner') {
            if (!isBot) setSide('b', bstyle)
            if (!isRight) setSide('r', bstyle)
            if (!isTop) setSide('t', bstyle)
            if (!isLeft) setSide('l', bstyle)
          } else if (mode === 'inner-h') {
            // 内部横线：给每行加底边（最后一行也算，形成完整横线网格）
            setSide('b', bstyle)
          } else if (mode === 'inner-v') {
            setSide('r', bstyle)
          } else if (mode === 'top') {
            if (isTop) setSide('t', bstyle)
          } else if (mode === 'bottom') {
            if (isBot) setSide('b', bstyle)
          } else if (mode === 'left') {
            if (isLeft) setSide('l', bstyle)
          } else if (mode === 'right') {
            if (isRight) setSide('r', bstyle)
          } else if (mode === 'clear') {
            setSide('t', null)
            setSide('l', null)
            setSide('b', null)
            setSide('r', null)
          }
          writeCell(sheet, r, c, { v: cur.v, s: { ...(cur.s || {}), border: b } })
        }
      }
    }, LOCAL)
  }

  const mergeCells = (r1: number, c1: number, r2: number, c2: number) => {
    const R1 = Math.min(r1, r2)
    const R2 = Math.max(r1, r2)
    const C1 = Math.min(c1, c2)
    const C2 = Math.max(c1, c2)
    if (R2 - R1 < 1 && C2 - C1 < 1) return
    const inner = mergesMap.get(activeSheet) as Y.Map<MergeInfo> | undefined
    if (!inner) return
    ydoc.transact(() => {
      const toDel: string[] = []
      inner.forEach((v, k) => {
        if (
          v.r <= R2 &&
          v.r + v.rs - 1 >= R1 &&
          v.c <= C2 &&
          v.c + v.cs - 1 >= C1
        )
          toDel.push(k as string)
      })
      toDel.forEach((k) => inner.delete(k))
      inner.set(R1 + ',' + C1, { r: R1, c: C1, rs: R2 - R1 + 1, cs: C2 - C1 + 1 })
    }, LOCAL)
  }

  const unmergeCells = (r1: number, c1: number, r2: number, c2: number) => {
    const R1 = Math.min(r1, r2)
    const R2 = Math.max(r1, r2)
    const C1 = Math.min(c1, c2)
    const C2 = Math.max(c1, c2)
    const inner = mergesMap.get(activeSheet) as Y.Map<MergeInfo> | undefined
    if (!inner) return
    ydoc.transact(() => {
      const toDel: string[] = []
      inner.forEach((v, k) => {
        if (v.r >= R1 && v.r <= R2 && v.c >= C1 && v.c <= C2) toDel.push(k as string)
      })
      toDel.forEach((k) => inner.delete(k))
    }, LOCAL)
  }

  // 行列索引平移（增/删行列时同步 merges / colw / rowh）
  const shiftIndexMapUp = (m: Y.Map<number> | undefined, at: number) => {
    if (!m) return
    const collected: [string, number][] = []
    m.forEach((v, k) => {
      const i = Number(k)
      if (i >= at) collected.push([String(i + 1), v])
    })
    const toDel: string[] = []
    m.forEach((_v, k) => {
      if (Number(k) >= at) toDel.push(k as string)
    })
    toDel.forEach((k) => m.delete(k))
    collected.forEach(([k, v]) => m.set(k, v))
  }

  const removeAndShiftDown = (m: Y.Map<number> | undefined, at: number) => {
    if (!m) return
    const collected: [string, number][] = []
    m.forEach((v, k) => {
      const i = Number(k)
      if (i > at) collected.push([String(i - 1), v])
    })
    const toDel: string[] = []
    m.forEach((_v, k) => {
      if (Number(k) >= at) toDel.push(k as string)
    })
    toDel.forEach((k) => m.delete(k))
    collected.forEach(([k, v]) => m.set(k, v))
  }

  const rewriteMerges = (fn: (m: MergeInfo) => MergeInfo | null) => {
    const inner = mergesMap.get(activeSheet) as Y.Map<MergeInfo> | undefined
    if (!inner) return
    const entries: MergeInfo[] = []
    inner.forEach((v) => {
      const r = fn(v)
      if (r) entries.push(r)
    })
    inner.clear()
    for (const m of entries) inner.set(m.r + ',' + m.c, m)
  }

  const addRow = (at: number) => {
    if (!sheet) return
    const colCount = sheet.length ? sheet.get(0)?.length ?? DEFAULT_COLS : DEFAULT_COLS
    ydoc.transact(() => {
      const newRow = new Y.Array<CellData>()
      const cells: CellData[] = []
      for (let c = 0; c < colCount; c++) cells.push(emptyCell())
      newRow.insert(0, cells)
      sheet.insert(at, [newRow])
      rewriteMerges((m) => {
        if (m.r >= at) return { ...m, r: m.r + 1 }
        if (m.r < at && m.r + m.rs - 1 >= at) return { ...m, rs: m.rs + 1 }
        return m
      })
      shiftIndexMapUp(rowhMap.get(activeSheet) as Y.Map<number>, at)
    }, LOCAL)
  }

  const deleteRow = (at: number) => {
    if (!sheet) return
    ydoc.transact(() => {
      sheet.delete(at, 1)
      rewriteMerges((m) => {
        if (m.r > at) return { ...m, r: m.r - 1 }
        if (m.r === at) {
          if (m.rs > 1) return { ...m, rs: m.rs - 1 }
          return null
        }
        if (m.r < at && m.r + m.rs - 1 >= at) return { ...m, rs: m.rs - 1 }
        return m
      })
      removeAndShiftDown(rowhMap.get(activeSheet) as Y.Map<number>, at)
    }, LOCAL)
  }

  const addCol = (at: number) => {
    if (!sheet) return
    const rowCount = sheet.length
    ydoc.transact(() => {
      for (let r = 0; r < rowCount; r++) {
        const rowA = sheet.get(r)
        if (rowA) rowA.insert(at, [emptyCell()])
      }
      rewriteMerges((m) => {
        if (m.c >= at) return { ...m, c: m.c + 1 }
        if (m.c < at && m.c + m.cs - 1 >= at) return { ...m, cs: m.cs + 1 }
        return m
      })
      shiftIndexMapUp(colwMap.get(activeSheet) as Y.Map<number>, at)
    }, LOCAL)
  }

  const deleteCol = (at: number) => {
    if (!sheet) return
    const rowCount = sheet.length
    ydoc.transact(() => {
      for (let r = 0; r < rowCount; r++) {
        const rowA = sheet.get(r)
        if (rowA && rowA.length > at) rowA.delete(at, 1)
      }
      rewriteMerges((m) => {
        if (m.c > at) return { ...m, c: m.c - 1 }
        if (m.c === at) {
          if (m.cs > 1) return { ...m, cs: m.cs - 1 }
          return null
        }
        if (m.c < at && m.c + m.cs - 1 >= at) return { ...m, cs: m.cs - 1 }
        return m
      })
      removeAndShiftDown(colwMap.get(activeSheet) as Y.Map<number>, at)
    }, LOCAL)
  }

  const setColWidth = (c: number, px: number) => {
    const inner = colwMap.get(activeSheet) as Y.Map<number> | undefined
    if (!inner) return
    ydoc.transact(() => inner.set(String(c), Math.max(28, Math.round(px))), LOCAL)
  }

  const setRowHeight = (r: number, px: number) => {
    const inner = rowhMap.get(activeSheet) as Y.Map<number> | undefined
    if (!inner) return
    ydoc.transact(() => inner.set(String(r), Math.max(20, Math.round(px))), LOCAL)
  }

  // ---- 深拷贝工具（工作表复制 / 重命名用，避免 Yjs 类型跨键共享） ----
  const cloneCell = (c: CellData | undefined): CellData => {
    const v = c && typeof c === 'object' && 'v' in c ? c.v : c == null ? '' : String(c)
    const s = c && typeof c === 'object' ? c.s : undefined
    return s ? { v, s: JSON.parse(JSON.stringify(s)) } : { v }
  }
  const cloneSheetArray = (src: Y.Array<Y.Array<CellData>>) => {
    const out = new Y.Array<Y.Array<CellData>>()
    const list: Y.Array<CellData>[] = []
    src.forEach((rowA) => {
      const nr = new Y.Array<CellData>()
      const cells: CellData[] = []
      rowA.forEach((cell) => cells.push(cloneCell(cell)))
      // 空行也要补一个占位，否则 Yjs 会因为空内容丢失该行
      if (cells.length === 0) cells.push(emptyCell())
      nr.insert(0, cells)
      list.push(nr)
    })
    out.push(list)
    return out
  }
  const cloneAnyMap = <T,>(src: Y.Map<T> | undefined): Y.Map<T> => {
    const m = new Y.Map<T>()
    src?.forEach((v, k) => m.set(k as string, v))
    return m
  }

  // ---- 范围清理 ----
  const clearRange = (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    what: 'content' | 'format' | 'all'
  ) => {
    if (!sheet) return
    const R1 = Math.min(r1, r2)
    const R2 = Math.max(r1, r2)
    const C1 = Math.min(c1, c2)
    const C2 = Math.max(c1, c2)
    ydoc.transact(() => {
      for (let r = R1; r <= R2; r++) {
        for (let c = C1; c <= C2; c++) {
          const cur = readCell(r, c)
          if (what === 'content') writeCell(sheet, r, c, { v: '', s: cur.s })
          else if (what === 'format') writeCell(sheet, r, c, { v: cur.v })
          else writeCell(sheet, r, c, { v: '' })
        }
      }
    }, LOCAL)
  }

  // ---- 格式刷：读样式 / 落样式 ----
  const getStyleAt = (r: number, c: number): CellStyle | undefined => {
    const s = readCell(r, c).s
    return s ? (JSON.parse(JSON.stringify(s)) as CellStyle) : undefined
  }

  const applyStyleObject = (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    style: CellStyle | undefined,
    mode: 'replace' | 'merge' = 'replace'
  ) => {
    if (!sheet) return
    const R1 = Math.min(r1, r2)
    const R2 = Math.max(r1, r2)
    const C1 = Math.min(c1, c2)
    const C2 = Math.max(c1, c2)
    ydoc.transact(() => {
      for (let r = R1; r <= R2; r++) {
        for (let c = C1; c <= C2; c++) {
          const cur = readCell(r, c)
          const next =
            mode === 'replace'
              ? style
                ? (JSON.parse(JSON.stringify(style)) as CellStyle)
                : undefined
              : { ...(cur.s || {}), ...(style || {}) }
          writeCell(sheet, r, c, { v: cur.v, s: next })
        }
      }
    }, LOCAL)
  }

  const setNumFmt = (r1: number, c1: number, r2: number, c2: number, code: string) => {
    if (!sheet) return
    const R1 = Math.min(r1, r2)
    const R2 = Math.max(r1, r2)
    const C1 = Math.min(c1, c2)
    const C2 = Math.max(c1, c2)
    ydoc.transact(() => {
      for (let r = R1; r <= R2; r++) {
        for (let c = C1; c <= C2; c++) {
          const cur = readCell(r, c)
          const s: CellStyle = { ...(cur.s || {}) }
          if (code) s.numfmt = code
          else delete s.numfmt
          writeCell(sheet, r, c, { v: cur.v, s })
        }
      }
    }, LOCAL)
  }

  const setCellLink = (r: number, c: number, url: string) => {
    if (!sheet) return
    const cur = readCell(r, c)
    const s: CellStyle = { ...(cur.s || {}) }
    if (url) s.link = url
    else delete s.link
    ydoc.transact(() => writeCell(sheet, r, c, { v: cur.v, s }), LOCAL)
  }

  // ---- 批注 ----
  const setComment = (r: number, c: number, text: string, author: string) => {
    const inner = commentsMap.get(activeSheet) as Y.Map<CellComment> | undefined
    if (!inner) return
    const key = r + ',' + c
    if (!text.trim()) {
      ydoc.transact(() => inner.delete(key), LOCAL)
      return
    }
    ydoc.transact(
      () => inner.set(key, { text: text.trim(), author, ts: Date.now() }),
      LOCAL
    )
  }
  const deleteComment = (r: number, c: number) => {
    const inner = commentsMap.get(activeSheet) as Y.Map<CellComment> | undefined
    if (!inner) return
    ydoc.transact(() => inner.delete(r + ',' + c), LOCAL)
  }

  // ---- 冻结行列 ----
  const setFrozen = (rowN: number, colN: number) => {
    const inner = frozenMap.get(activeSheet) as Y.Map<number> | undefined
    if (!inner) return
    ydoc.transact(() => {
      inner.set('rows', Math.max(0, Math.min(10, Math.round(rowN))))
      inner.set('cols', Math.max(0, Math.min(10, Math.round(colN))))
    }, LOCAL)
  }

  // ---- 复制 / 粘贴（TSV） ----
  const rangeToTsv = (r1: number, c1: number, r2: number, c2: number) => {
    const out: string[] = []
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      const line: string[] = []
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        const raw = readCell(r, c).v
        // 复制到外部剪贴板时给「公式的求值结果」，与 Excel / 飞书一致
        line.push(tsvCell(raw.startsWith('=') ? evalFormula(raw, getCellRaw) : raw))
      }
      out.push(line.join('\t'))
    }
    return out.join('\n')
  }
  const pasteTsv = (r0: number, c0: number, text: string) => {
    if (!sheet) return { rows: 0, cols: 0 }
    const grid = parseTsv(text)
    const colN = grid.reduce((n, l) => Math.max(n, l.length), 0)
    ydoc.transact(() => {
      // 粘贴区可能超出当前表：先把整张表补齐，避免越界写入 / 出现参差行
      ensureSize(r0 + grid.length, c0 + colN)
      grid.forEach((cells, i) => {
        cells.forEach((v, j) => {
          const cur = readCell(r0 + i, c0 + j)
          writeCell(sheet, r0 + i, c0 + j, { v, s: cur.s })
        })
      })
    }, LOCAL)
    return { rows: grid.length, cols: colN }
  }

  // ---- 排序（整行跟随移动） ----
  const sortRange = (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    byCol: number,
    dir: 'asc' | 'desc'
  ) => {
    if (!sheet) return
    const R1 = Math.min(r1, r2)
    const R2 = Math.max(r1, r2)
    const C1 = Math.min(c1, c2)
    const C2 = Math.max(c1, c2)
    if (R2 - R1 < 1) return
    const snap: CellData[][] = []
    for (let r = R1; r <= R2; r++) {
      const row: CellData[] = []
      for (let c = C1; c <= C2; c++) row.push(cloneCell(readCell(r, c)))
      snap.push(row)
    }
    const keyIdx = Math.min(Math.max(0, byCol - C1), (snap[0]?.length || 1) - 1)
    const toNum = (s: string) => {
      const t = s.replace(/[,¥$%\s]/g, '')
      if (t === '' || isNaN(Number(t))) return null
      return Number(t)
    }
    const order = snap.map((_, i) => i)
    order.sort((a, b) => {
      const va = (snap[a][keyIdx]?.v ?? '').trim()
      const vb = (snap[b][keyIdx]?.v ?? '').trim()
      if (va === '' && vb !== '') return 1
      if (vb === '' && va !== '') return -1
      const na = toNum(va)
      const nb = toNum(vb)
      const d =
        na !== null && nb !== null ? na - nb : va.localeCompare(vb, 'zh-Hans-CN', { numeric: true })
      return dir === 'asc' ? d : -d
    })
    ydoc.transact(() => {
      order.forEach((srcIdx, i) => {
        snap[srcIdx].forEach((cell, j) => {
          writeCell(sheet, R1 + i, C1 + j, cloneCell(cell))
        })
      })
    }, LOCAL)
  }

  const addSheet = (n?: string): string => {
    const name = n || `Sheet${sheetNames.length + 1}`
    if (sheets.has(name)) return name
    ydoc.transact(() => {
      sheets.set(name, makeEmptySheet())
      mergesMap.set(name, new Y.Map())
      colwMap.set(name, new Y.Map())
      rowhMap.set(name, new Y.Map())
      frozenMap.set(name, new Y.Map())
      commentsMap.set(name, new Y.Map())
    }, LOCAL)
    return name
  }

  /** 重命名工作表（连同合并 / 列宽 / 行高 / 冻结 / 批注一起搬过去） */
  const renameSheet = (from: string, to: string): boolean => {
    const name = to.trim()
    if (!name || name === from || sheets.has(name)) return false
    const src = sheets.get(from) as Y.Array<Y.Array<CellData>> | undefined
    if (!src) return false
    ydoc.transact(() => {
      sheets.set(name, cloneSheetArray(src))
      sheets.delete(from)
      const pairs: [Y.Map<any>, Y.Map<any>][] = [
        [mergesMap, cloneAnyMap(mergesMap.get(from) as Y.Map<any>)],
        [colwMap, cloneAnyMap(colwMap.get(from) as Y.Map<any>)],
        [rowhMap, cloneAnyMap(rowhMap.get(from) as Y.Map<any>)],
        [frozenMap, cloneAnyMap(frozenMap.get(from) as Y.Map<any>)],
        [commentsMap, cloneAnyMap(commentsMap.get(from) as Y.Map<any>)],
      ]
      for (const [map, copy] of pairs) {
        map.set(name, copy)
        map.delete(from)
      }
    }, LOCAL)
    return true
  }

  /** 删除工作表（至少保留一张） */
  const deleteSheet = (name: string): boolean => {
    if (!sheets.has(name) || sheets.size <= 1) return false
    ydoc.transact(() => {
      sheets.delete(name)
      for (const m of [mergesMap, colwMap, rowhMap, frozenMap, commentsMap]) m.delete(name)
    }, LOCAL)
    return true
  }

  /** 复制工作表：内容 + 全部附属信息 */
  const copySheet = (name: string): string | null => {
    const src = sheets.get(name) as Y.Array<Y.Array<CellData>> | undefined
    if (!src) return null
    let next = `${name} 副本`
    let i = 2
    while (sheets.has(next)) next = `${name} 副本 ${i++}`
    ydoc.transact(() => {
      sheets.set(next, cloneSheetArray(src))
      mergesMap.set(next, cloneAnyMap(mergesMap.get(name) as Y.Map<any>))
      colwMap.set(next, cloneAnyMap(colwMap.get(name) as Y.Map<any>))
      rowhMap.set(next, cloneAnyMap(rowhMap.get(name) as Y.Map<any>))
      frozenMap.set(next, cloneAnyMap(frozenMap.get(name) as Y.Map<any>))
      commentsMap.set(next, cloneAnyMap(commentsMap.get(name) as Y.Map<any>))
    }, LOCAL)
    return next
  }

  /** 清空当前工作表内容（保留格式） */
  const clearSheet = () => {
    if (!sheet) return
    const R = rows.length
    const C = rows[0]?.length || 0
    if (R && C) clearRange(0, 0, R - 1, C - 1, 'content')
  }

  const undo = () => undoMgr?.undo()
  const redo = () => undoMgr?.redo()

  const rowCount = rows.length
  const colCount = rows[0]?.length ?? 0

  return {
    rows,
    rowCount,
    colCount,
    sheetNames,
    activeSheet,
    merges,
    colw,
    rowh,
    frozen,
    comments,
    addSheet,
    renameSheet,
    deleteSheet,
    copySheet,
    clearSheet,
    setCellValue,
    getCellRaw,
    applyStyleRange,
    applyBorder,
    mergeCells,
    unmergeCells,
    addRow,
    deleteRow,
    addCol,
    deleteCol,
    setColWidth,
    setRowHeight,
    clearRange,
    getStyleAt,
    applyStyleObject,
    sortRange,
    setNumFmt,
    setCellLink,
    setComment,
    deleteComment,
    setFrozen,
    rangeToTsv,
    pasteTsv,
    undo,
    redo,
    canUndo,
    canRedo,
  }
}
