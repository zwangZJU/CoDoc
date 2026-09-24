/** 各格式的序列化与下载（不依赖后端，浏览器内完成） */
import type { SheetSnapshot, BlockSnapshot } from './loadDocData'

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

export function sheetsToCsv(sheets: SheetSnapshot[], only?: string): string {
  const list = only ? sheets.filter((s) => s.name === only) : sheets
  return list
    .map((s) => s.rows.map((r) => r.map((c) => cellCsv(c.v)).join(',')).join('\r\n'))
    .join('\r\n\r\n')
}

export function sheetsToMarkdown(sheets: SheetSnapshot[], only?: string): string {
  const list = only ? sheets.filter((s) => s.name === only) : sheets
  return list
    .map((s) => {
      const rows = s.rows.filter((r) => r.some((c) => c.v.trim()))
      if (rows.length === 0) return `## ${s.name}\n\n（空表）`
      const head = rows[0].map((c) => c.v || ' ')
      const body = rows.slice(1)
      return [
        `## ${s.name}`,
        '',
        '| ' + head.join(' | ') + ' |',
        '| ' + head.map(() => '---').join(' | ') + ' |',
        ...body.map((r) => '| ' + r.map((c) => c.v.replace(/\|/g, '\\|')).join(' | ') + ' |'),
      ].join('\n')
    })
    .join('\n\n')
}

const MD_PREFIX: Record<BlockSnapshot['type'], string> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  li: '- ',
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
