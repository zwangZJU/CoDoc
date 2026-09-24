// src/word/zip.ts
function makeCRCTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}
var CRC_TABLE = makeCRCTable();
function crc32(buf) {
  let c = 4294967295;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 255] ^ c >>> 8;
  }
  return (c ^ 4294967295) >>> 0;
}
function encStr(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}
function push16(view, off, v) {
  view.setUint16(off, v & 65535, true);
}
function push32(view, off, v) {
  view.setUint32(off, v >>> 0, true);
}
function createZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = encStr(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    push32(lv, 0, 67324752);
    push16(lv, 4, 20);
    push16(lv, 6, 0);
    push16(lv, 8, 0);
    push16(lv, 10, 0);
    push16(lv, 12, 0);
    push32(lv, 14, crc);
    push32(lv, 18, size);
    push32(lv, 22, size);
    push16(lv, 26, nameBytes.length);
    push16(lv, 28, 0);
    local.set(nameBytes, 30);
    chunks.push(local, f.data);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    push32(cv, 0, 33639248);
    push16(cv, 4, 20);
    push16(cv, 6, 20);
    push16(cv, 8, 0);
    push16(cv, 10, 0);
    push16(cv, 12, 0);
    push16(cv, 14, 0);
    push32(cv, 16, crc);
    push32(cv, 20, size);
    push32(cv, 24, size);
    push16(cv, 28, nameBytes.length);
    push16(cv, 30, 0);
    push16(cv, 32, 0);
    push16(cv, 34, 0);
    push16(cv, 36, 0);
    push32(cv, 38, 0);
    push32(cv, 42, offset);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length + f.data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    chunks.push(c);
    cdSize += c.length;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  push32(ev, 0, 101010256);
  push16(ev, 4, 0);
  push16(ev, 6, 0);
  push16(ev, 8, files.length);
  push16(ev, 10, files.length);
  push32(ev, 12, cdSize);
  push32(ev, 16, cdStart);
  push16(ev, 20, 0);
  chunks.push(end);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
function readZip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const result = /* @__PURE__ */ new Map();
  let off = 0;
  while (off + 4 <= buf.length) {
    const sig = view.getUint32(off, true);
    if (sig !== 67324752) break;
    const comp = view.getUint16(off + 8, true);
    const crc = view.getUint32(off + 14, true);
    const compSize = view.getUint32(off + 18, true);
    const uncompSize = view.getUint32(off + 22, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const nameBytes = buf.subarray(off + 30, off + 30 + nameLen);
    const name = String.fromCharCode(...nameBytes);
    const dataStart = off + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (comp === 0) {
      result.set(name, data.slice());
    }
    off = dataStart + compSize;
  }
  return result;
}

// src/word/docx.ts
function blockText(b) {
  return b.runs.map((r) => r.text).join("");
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function parseXML(xml) {
  const root = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z:][\w:-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  let m;
  let last = 0;
  while (m = re.exec(xml)) {
    const text = xml.slice(last, m.index);
    const top = stack[stack.length - 1];
    if (text.trim()) top.text += text;
    last = re.lastIndex;
    const closing = m[1] === "/";
    const tag = m[2];
    const attrStr = m[3] || "";
    const selfClose = m[4] === "/";
    if (closing) {
      stack.pop();
      continue;
    }
    const node = { tag, attrs: {}, children: [], text: "" };
    const ar = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    let am;
    while (am = ar.exec(attrStr)) node.attrs[am[1]] = am[2];
    top.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}
function find(n, tag) {
  for (const c of n.children) {
    if (c.tag === tag) return c;
    const r = find(c, tag);
    if (r) return r;
  }
  return void 0;
}
function findAll(n, tag) {
  const out = [];
  for (const c of n.children) {
    if (c.tag === tag) out.push(c);
    out.push(...findAll(c, tag));
  }
  return out;
}
function docxToBlocks(buf) {
  const files = readZip(buf);
  const doc = files.get("word/document.xml");
  if (!doc) return [];
  const xml = new TextDecoder().decode(doc);
  const tree = parseXML(xml);
  const body = find(tree, "w:body");
  if (!body) return [];
  const paras = findAll(body, "w:p");
  const blocks2 = [];
  let i = 0;
  for (const p of paras) {
    const pPr = find(p, "w:pPr");
    let type = "p";
    let align;
    if (pPr) {
      const style = find(pPr, "w:pStyle");
      const styleVal = style?.attrs["w:val"] || "";
      if (styleVal.startsWith("Heading1") || styleVal === "Heading1") type = "h1";
      else if (styleVal.startsWith("Heading2")) type = "h2";
      else if (styleVal.startsWith("Heading3")) type = "h3";
      else if (styleVal === "ListParagraph" || styleVal.startsWith("List")) type = "li";
      const jc = find(pPr, "w:jc");
      const jv = jc?.attrs["w:val"];
      if (jv === "center") align = "center";
      else if (jv === "right") align = "right";
      else if (jv === "left" || jv === "both" || jv === "start") align = "left";
    }
    const runs = [];
    const rs = findAll(p, "w:r");
    for (const r of rs) {
      const t = find(r, "w:t");
      const text = t ? t.text : "";
      if (!text) continue;
      const rPr = find(r, "w:rPr");
      const b = !!find(rPr || { tag: "", attrs: {}, children: [], text: "" }, "w:b");
      const i2 = !!find(rPr || { tag: "", attrs: {}, children: [], text: "" }, "w:i");
      const u = !!find(rPr || { tag: "", attrs: {}, children: [], text: "" }, "w:u");
      runs.push({ text, b: b || void 0, i: i2 || void 0, u: u || void 0 });
    }
    if (runs.length === 0) runs.push({ text: "" });
    blocks2.push({ id: "b" + i++, type, align, runs });
  }
  return blocks2;
}
function runXML(r) {
  const rPr = [];
  if (r.b) rPr.push("<w:b/><w:bCs/>");
  if (r.i) rPr.push("<w:i/><w:iCs/>");
  if (r.u) rPr.push('<w:u w:val="single"/>');
  const pr = rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : "";
  return `<w:r>${pr}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
}
function blockXML(b) {
  const pPr = [];
  const styleMap = {
    p: "Normal",
    h1: "Heading1",
    h2: "Heading2",
    h3: "Heading3",
    li: "ListParagraph"
  };
  pPr.push(`<w:pStyle w:val="${styleMap[b.type]}"/>`);
  if (b.align === "center") pPr.push('<w:jc w:val="center"/>');
  else if (b.align === "right") pPr.push('<w:jc w:val="right"/>');
  else if (b.align === "left") pPr.push('<w:jc w:val="left"/>');
  const pr = `<w:pPr>${pPr.join("")}</w:pPr>`;
  const runs = b.runs.map(runXML).join("");
  return `<w:p>${pr}${runs}</w:p>`;
}
function buildParts(blocks2) {
  const body = blocks2.map(blockXML).join("\n");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${body}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:sz w:val="36"/><w:b/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:sz w:val="28"/><w:b/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:sz w:val="24"/><w:b/></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`;
  const enc = (s) => new Uint8Array(new TextEncoder().encode(s));
  return [
    { name: "[Content_Types].xml", data: enc(contentTypes) },
    { name: "_rels/.rels", data: enc(rels) },
    { name: "word/document.xml", data: enc(document) },
    { name: "word/_rels/document.xml.rels", data: enc(docRels) },
    { name: "word/styles.xml", data: enc(styles) }
  ];
}
function blocksToDocx(blocks2) {
  return createZip(buildParts(blocks2));
}

// test-docx.ts
var blocks = [
  { id: "b0", type: "h1", runs: [{ text: "\u6807\u9898\u4E00", b: true }] },
  { id: "b1", type: "p", align: "center", runs: [{ text: "\u666E\u901A\u6BB5\u843D ", i: true }, { text: "\u7B2C\u4E8C\u6BB5", u: true }] },
  { id: "b2", type: "li", runs: [{ text: "\u5217\u8868\u9879" }] },
  { id: "b3", type: "h2", runs: [{ text: "\u526F\u6807\u9898" }] }
];
var docx = blocksToDocx(blocks);
console.log("docx bytes:", docx.length);
var back = docxToBlocks(docx);
console.log("roundtrip blocks:", back.length);
console.log("h1:", back[0].type, JSON.stringify(back[0].runs[0]));
console.log("p :", back[1].align, JSON.stringify(back[1].runs));
console.log("li:", back[2].type, blockText(back[2]));
console.log("h2:", back[3].type, blockText(back[3]));
var ok = back.length === 4 && back[0].type === "h1" && back[0].runs[0].b === true && back[1].align === "center" && back[1].runs[0].i === true && back[1].runs[1].u === true && back[2].type === "li" && blockText(back[2]) === "\u5217\u8868\u9879" && back[3].type === "h2" && blockText(back[3]) === "\u526F\u6807\u9898";
console.log(ok ? "DOCX_ROUNDTRIP_OK" : "DOCX_ROUNDTRIP_FAIL");
