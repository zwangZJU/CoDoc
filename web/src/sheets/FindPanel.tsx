/**
 * 查找和替换面板（对齐飞书：贴在工具栏下方的一条浮动工具条）
 * · 实时统计命中数，支持上一个 / 下一个跳转
 * · 支持区分大小写、整格匹配
 * · 替换 / 全部替换直接写入 Yjs，可撤销
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SheetApi } from './useSheet'
import { Ico } from './sheetIcons'

interface Props {
  sheet: SheetApi
  readOnly: boolean
  onClose: () => void
  onJump: (r: number, c: number) => void
  onNotify: (msg: string) => void
}

interface Hit {
  r: number
  c: number
}

export default function FindPanel({ sheet, readOnly, onClose, onJump, onNotify }: Props) {
  const [q, setQ] = useState('')
  const [rep, setRep] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeCell, setWholeCell] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // 命中集合（按行优先顺序）
  const hits = useMemo<Hit[]>(() => {
    const needle = caseSensitive ? q : q.toLowerCase()
    if (!needle) return []
    const out: Hit[] = []
    const rows = sheet.rows
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]
      for (let c = 0; c < row.length; c++) {
        const raw = row[c]?.v ?? ''
        if (!raw) continue
        const hay = caseSensitive ? raw : raw.toLowerCase()
        const ok = wholeCell ? hay === needle : hay.includes(needle)
        if (ok) out.push({ r, c })
      }
    }
    return out
  }, [q, sheet.rows, caseSensitive, wholeCell])

  useEffect(() => setCursor(0), [q, caseSensitive, wholeCell])

  const current = hits.length ? hits[Math.min(cursor, hits.length - 1)] : null

  useEffect(() => {
    if (current) onJump(current.r, current.c)
    // 只在命中项变化时跳转
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.r, current?.c])

  const goto = (delta: number) => {
    if (!hits.length) return
    setCursor((i) => (i + delta + hits.length) % hits.length)
  }

  const replaceOne = () => {
    if (readOnly) {
      onNotify('只读模式下无法替换')
      return
    }
    if (!current) return
    const raw = sheet.rows[current.r]?.[current.c]?.v ?? ''
    const next = wholeCell
      ? rep
      : caseSensitive
      ? raw.split(q).join(rep)
      : raw.replace(new RegExp(escapeRe(q), 'gi'), rep)
    sheet.setCellValue(current.r, current.c, next)
    onNotify(`已替换 1 处（${colName(current.c)}${current.r + 1}）`)
  }

  const replaceAll = () => {
    if (readOnly) {
      onNotify('只读模式下无法替换')
      return
    }
    if (!q || !hits.length) return
    const list = [...hits]
    list.forEach(({ r, c }) => {
      const raw = sheet.rows[r]?.[c]?.v ?? ''
      const next = wholeCell
        ? rep
        : caseSensitive
        ? raw.split(q).join(rep)
        : raw.replace(new RegExp(escapeRe(q), 'gi'), rep)
      sheet.setCellValue(r, c, next)
    })
    onNotify(`已全部替换 ${list.length} 处`)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) goto(-1)
      else goto(1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="find-bar" onKeyDown={onKeyDown}>
      <div className="find-group">
        <Ico n="find" size={15} className="find-ico" />
        <input
          ref={inputRef}
          className="find-input"
          placeholder="查找内容"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="find-count">{q ? `${hits.length ? Math.min(cursor + 1, hits.length) : 0}/${hits.length}` : ''}</span>
        <button className="find-nav" title="上一个（Shift+Enter）" disabled={!hits.length} onClick={() => goto(-1)}>
          <Ico n="chevron-down" size={14} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button className="find-nav" title="下一个（Enter）" disabled={!hits.length} onClick={() => goto(1)}>
          <Ico n="chevron-down" size={14} />
        </button>
      </div>

      <span className="find-sep" />

      <div className="find-group">
        <input
          className="find-input"
          placeholder="替换为"
          value={rep}
          onChange={(e) => setRep(e.target.value)}
        />
        <button className="find-btn" disabled={!current || readOnly} onClick={replaceOne}>
          替换
        </button>
        <button className="find-btn" disabled={!hits.length || readOnly} onClick={replaceAll}>
          全部替换
        </button>
      </div>

      <span className="find-sep" />

      <label className="find-opt">
        <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
        区分大小写
      </label>
      <label className="find-opt">
        <input type="checkbox" checked={wholeCell} onChange={(e) => setWholeCell(e.target.checked)} />
        整格匹配
      </label>

      <span className="tb-grow" />

      <button className="find-nav" title="关闭（Esc）" onClick={onClose}>
        <Ico n="close" size={14} />
      </button>
    </div>
  )
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
