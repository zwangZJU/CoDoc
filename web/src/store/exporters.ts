/** 各格式的序列化与下载（不依赖后端，浏览器内完成） */
import type { SheetSnapshot, BlockSnapshot } from './loadDocData'
import type { CellData } from '../sheets/useSheet'

export function download(name: string, mime: string, data: string | Uint8Array) {
  const blob =
    data instanceof Uint8Array
      ? new Blob([data as unknown as BlobPart], { type: mime })
      : new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function cellCsv(v: string): string {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

/**
 * 裁掉尾部空行空列。
 * 表格在编辑器里总是有一整块空区域（方便继续往下写），
 * 但导出成 CSV / Markdown 时不该把这些空单元格一起带走。
 */
function trimGrid(rows: CellData[][]): CellData[][] {
  let maxR = -1
  let maxC = -1
  rows.forEach((row, r) =>
    row.forEach((c, i) => {
      if ((c?.v ?? '').trim() !== '') {
        if (r > maxR) maxR = r
        if (i > maxC) maxC = i
      }
    })
  )
  if (maxR < 0 || maxC < 0) return []
  return rows.slice(0, maxR + 1).map((r) => r.slice(0, maxC + 1))
}

export function sheetsToCsv(sheets: SheetSnapshot[], only?: string): string {
  const list = only ? sheets.filter((s) => s.name === only) : sheets
  return list
    .map((s) =>
      trimGrid(s.rows)
        .map((r) => r.map((c) => cellCsv(c.v)).join(','))
        .join('\r\n')
    )
    .join('\r\n\r\n')
}

export function sheetsToMarkdown(sheets: SheetSnapshot[], only?: string): string {
  const list = only ? sheets.filter((s) => s.name === only) : sheets
  return list
    .map((s) => {
      const rows = trimGrid(s.rows).filter((r) => r.some((c) => c.v.trim()))
      if (rows.length === 0) return `## ${s.name}\n\n（空表）`
      // 列数对齐：裁剪后各行长度一致，这里再兜一次底，避免 Markdown 表格错位
      const colN = rows.reduce((n, r) => Math.max(n, r.length), 0)
      const pad = (r: CellData[]) => {
        const out = r.slice()
        while (out.length < colN) out.push({ v: '' })
        return out
      }
      const head = pad(rows[0]).map((c) => c.v || ' ')
      const body = rows.slice(1)
      return [
        `## ${s.name}`,
        '',
        '| ' + head.join(' | ') + ' |',
        '| ' + head.map(() => '---').join(' | ') + ' |',
        ...body.map(
          (r) => '| ' + pad(r).map((c) => c.v.replace(/\|/g, '\\|')).join(' | ') + ' |'
        ),
      ].join('\n')
    })
    .join('\n\n')
}

const MD_PREFIX: Record<BlockSnapshot['type'], string> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  h4: '#### ',
  h5: '##### ',
  h6: '###### ',
  h7: '###### ',
  h8: '###### ',
  h9: '###### ',
  ol: '1. ',
  li: '- ',
  task: '- [ ] ',
  code: '',
  quote: '> ',
  callout: '',
  sync: '',
  p: '',
}

export function blocksToMarkdown(blocks: BlockSnapshot[]): string {
  return blocks
    .map((b) => (b.text.trim() ? MD_PREFIX[b.type] + b.text : ''))
    .filter((s) => s !== '')
    .join('\n\n')
}

export function blocksToText(blocks: BlockSnapshot[]): string {
  return blocks
    .map((b) => b.text)
    .filter((s) => s.trim())
    .join('\n')
}

/** PDF：交给浏览器打印（在打印对话框里选"另存为 PDF"） */
export function printToPdf() {
  window.print()
}
