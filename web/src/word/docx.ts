// 最小 docx 读写（无第三方依赖）。
// 文档模型以「段落 + 行内片段(runs)」表示，足以驱动 Word / WPS / LibreOffice 打开。

import { createZip, readZip, type ZipFile } from './zip'

export type BlockType = 'p' | 'h1' | 'h2' | 'h3' | 'li'

export interface Run {
  text: string
  b?: boolean
  i?: boolean
  u?: boolean
}

export interface Block {
  id: string
  type: BlockType
  align?: 'left' | 'center' | 'right'
  runs: Run[]
}

export function blockText(b: Block): string {
  return b.runs.map((r) => r.text).join('')
}

// ---------- XML 转义 ----------
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------- 微型 XML 解析（够用即可，不支持 CDATA/注释） ----------
interface XNode {
  tag: string
  attrs: Record<string, string>
  children: XNode[]
  text: string
}
function parseXML(xml: string): XNode {
  const root: XNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: XNode[] = [root]
  const re = /<(\/?)([a-zA-Z:][\w:-]*)((?:\s+[^<>]*?)?)(\/?)>/g
  let m: RegExpExecArray | null
  let last = 0
  while ((m = re.exec(xml))) {
    const text = xml.slice(last, m.index)
    const top = stack[stack.length - 1]
    if (text.trim()) top.text += text
    last = re.lastIndex
    const closing = m[1] === '/'
    const tag = m[2]
    const attrStr = m[3] || ''
    const selfClose = m[4] === '/'
    if (closing) {
      stack.pop()
      continue
    }
    const node: XNode = { tag, attrs: {}, children: [], text: '' }
    const ar = /([\w:-]+)\s*=\s*"([^"]*)"/g
    let am: RegExpExecArray | null
    while ((am = ar.exec(attrStr))) node.attrs[am[1]] = am[2]
    top.children.push(node)
    if (!selfClose) stack.push(node)
  }
  return root
}
function find(n: XNode, tag: string): XNode | undefined {
  for (const c of n.children) {
    if (c.tag === tag) return c
    const r = find(c, tag)
    if (r) return r
  }
  return undefined
}
function findAll(n: XNode, tag: string): XNode[] {
  const out: XNode[] = []
  for (const c of n.children) {
    if (c.tag === tag) out.push(c)
    out.push(...findAll(c, tag))
  }
  return out
}

// ---------- docx -> blocks ----------
export function docxToBlocks(buf: Uint8Array): Block[] {
  const files = readZip(buf)
  const doc = files.get('word/document.xml')
  if (!doc) return []
  const xml = new TextDecoder().decode(doc)
  const tree = parseXML(xml)
  const body = find(tree, 'w:body')
  if (!body) return []
  const paras = findAll(body, 'w:p')
  const blocks: Block[] = []
  let i = 0
  for (const p of paras) {
    const pPr = find(p, 'w:pPr')
    let type: BlockType = 'p'
    let align: 'left' | 'center' | 'right' | undefined
    if (pPr) {
      const style = find(pPr, 'w:pStyle')
      const styleVal = style?.attrs['w:val'] || ''
      if (styleVal.startsWith('Heading1') || styleVal === 'Heading1') type = 'h1'
      else if (styleVal.startsWith('Heading2')) type = 'h2'
      else if (styleVal.startsWith('Heading3')) type = 'h3'
      else if (styleVal === 'ListParagraph' || styleVal.startsWith('List')) type = 'li'
      const jc = find(pPr, 'w:jc')
      const jv = jc?.attrs['w:val']
      if (jv === 'center') align = 'center'
      else if (jv === 'right') align = 'right'
      else if (jv === 'left' || jv === 'both' || jv === 'start') align = 'left'
    }
    const runs: Run[] = []
    const rs = findAll(p, 'w:r')
    for (const r of rs) {
      const t = find(r, 'w:t')
      const text = t ? t.text : ''
      if (!text) continue
      const rPr = find(r, 'w:rPr')
      const b = !!find(rPr || { tag: '', attrs: {}, children: [], text: '' }, 'w:b')
      const i = !!find(rPr || { tag: '', attrs: {}, children: [], text: '' }, 'w:i')
      const u = !!find(rPr || { tag: '', attrs: {}, children: [], text: '' }, 'w:u')
      runs.push({ text, b: b || undefined, i: i || undefined, u: u || undefined })
    }
    if (runs.length === 0) runs.push({ text: '' })
    blocks.push({ id: 'b' + i++, type, align, runs })
  }
  return blocks
}

// ---------- blocks -> docx ----------
function runXML(r: Run): string {
  const rPr: string[] = []
  if (r.b) rPr.push('<w:b/><w:bCs/>')
  if (r.i) rPr.push('<w:i/><w:iCs/>')
  if (r.u) rPr.push('<w:u w:val="single"/>')
  const pr = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : ''
  return `<w:r>${pr}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`
}

function blockXML(b: Block): string {
  const pPr: string[] = []
  const styleMap: Record<BlockType, string> = {
    p: 'Normal',
    h1: 'Heading1',
    h2: 'Heading2',
    h3: 'Heading3',
    li: 'ListParagraph',
  }
  pPr.push(`<w:pStyle w:val="${styleMap[b.type]}"/>`)
  if (b.align === 'center') pPr.push('<w:jc w:val="center"/>')
  else if (b.align === 'right') pPr.push('<w:jc w:val="right"/>')
  else if (b.align === 'left') pPr.push('<w:jc w:val="left"/>')
  const pr = `<w:pPr>${pPr.join('')}</w:pPr>`
  const runs = b.runs.map(runXML).join('')
  return `<w:p>${pr}${runs}</w:p>`
}

function buildParts(blocks: Block[]): ZipFile[] {
  const body = blocks.map(blockXML).join('\n')
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${body}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:sz w:val="36"/><w:b/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:sz w:val="28"/><w:b/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:sz w:val="24"/><w:b/></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`

  const enc = (s: string) => new Uint8Array(new TextEncoder().encode(s))
  return [
    { name: '[Content_Types].xml', data: enc(contentTypes) },
    { name: '_rels/.rels', data: enc(rels) },
    { name: 'word/document.xml', data: enc(document) },
    { name: 'word/_rels/document.xml.rels', data: enc(docRels) },
    { name: 'word/styles.xml', data: enc(styles) },
  ]
}

export function blocksToDocx(blocks: Block[]): Uint8Array {
  return createZip(buildParts(blocks))
}
