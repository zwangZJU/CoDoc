const base = 'http://127.0.0.1:5173'
async function check(path) {
  try {
    const r = await fetch(base + path)
    const t = await r.text()
    return { path, status: r.status, len: t.length, head: t.slice(0, 80).replace(/\n/g, ' ') }
  } catch (e) {
    return { path, error: String(e) }
  }
}
const out = []
out.push(await check('/'))
out.push(await check('/src/main.tsx'))
out.push(await check('/src/sheets/SheetEditor.tsx'))
out.push(await check('/src/sheets/useSheet.ts'))
console.log(JSON.stringify(out, null, 2))
