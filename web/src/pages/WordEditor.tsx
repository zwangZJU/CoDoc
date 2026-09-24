import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { UndoManager } from 'yjs'
import { useCollab } from '../store/useCollab'
import { colorOf } from '../store/user'
import ShareDrawer from '../components/ShareDrawer'
import HistoryDrawer from '../components/HistoryDrawer'
import { IdentityDialog } from '../components/GuestGate'
import ExportModal, { type DocFormat } from '../components/ExportModal'
import { download, blocksToMarkdown, blocksToText, printToPdf } from '../store/exporters'
import {
  blocksToDocx,
  docxToBlocks,
  type BlockType,
  type Run,
} from '../word/docx'
import type { ImportPayload } from '../store/importPayload'
import type { LocalUser } from '../store/user'
import EditableTitle from '../components/EditableTitle'
import { api } from '../store/api'

interface Props {
  docId: string
  name: string
  /** 通过分享链接进入时由 App 解析出的访客身份；工作台打开则为空 */
  identity?: LocalUser | null
  importPayload?: ImportPayload | null
  onImported?: () => void
  onBack: () => void
  onDocRenamed?: (next: string) => void
}

const LOCAL = Symbol('word-local')
const STRUCT = Symbol('word-struct')

type Align = 'left' | 'center' | 'right'
interface DeltaItem {
  insert: string
  attributes?: Record<string, any>
}
interface Blk {
  id: string
  type: BlockType
  align?: Align
  delta: DeltaItem[]
}
interface Peer {
  id: string
  name: string
  colorIndex: number
  block: string | null
  guest?: boolean
}

const TYPE_LABEL: Record<BlockType, string> = {
  p: '正文',
  h1: '标题 1',
  h2: '标题 2',
  h3: '标题 3',
  li: '列表',
}

// ---------- 纯函数工具 ----------
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function deltaToHtml(delta: DeltaItem[]): string {
  return delta
    .map((d) => {
      const t = typeof d.insert === 'string' ? d.insert : ''
      const a = d.attributes || {}
      const styles: string[] = []
      if (a.bold) styles.push('font-weight:700')
      if (a.italic) styles.push('font-style:italic')
      if (a.underline) styles.push('text-decoration:underline')
      let html = esc(t).replace(/\n/g, '<br>')
      if (styles.length) html = `<span style="${styles.join(';')}">${html}</span>`
      return html
    })
    .join('')
}
function markAttrs(r: Run): Record<string, any> {
  const a: Record<string, any> = {}
  if (r.b) a.bold = true
  if (r.i) a.italic = true
  if (r.u) a.underline = true
  return a
}
function splitDelta(delta: DeltaItem[], off: number): [DeltaItem[], DeltaItem[]] {
  const left: DeltaItem[] = []
  const right: DeltaItem[] = []
  let pos = 0
  for (const d of delta) {
    const t = typeof d.insert === 'string' ? d.insert : ''
    const len = t.length
    if (pos + len <= off) left.push(d)
    else if (pos >= off) right.push(d)
    else {
      const cut = off - pos
      left.push({ insert: t.slice(0, cut), attributes: d.attributes })
      right.push({ insert: t.slice(cut), attributes: d.attributes })
    }
    pos += len
  }
  return [left, right]
}
function runsFromNode(node: Node, marks: { b?: boolean; i?: boolean; u?: boolean }, out: Run[]) {
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) {
      const txt = n.textContent || ''
      if (txt) out.push({ text: txt, ...marks })
    } else if (n.nodeType === 1) {
      const e = n as HTMLElement
      const tag = e.tagName.toLowerCase()
      if (tag === 'br') {
        out.push({ text: '\n', ...marks })
        return
      }
      const st = (e.getAttribute('style') || '').toLowerCase()
      const m = { ...marks }
      if (tag === 'b' || tag === 'strong' || st.includes('font-weight')) m.b = true
      if (tag === 'i' || tag === 'em' || st.includes('font-style')) m.i = true
      if (tag === 'u' || st.includes('underline')) m.u = true
      runsFromNode(e, m, out)
    }
  })
}
function serializeEl(el: HTMLElement): Run[] {
  const out: Run[] = []
  runsFromNode(el, {}, out)
  // 合并相邻同样式的 run
  const merged: Run[] = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && last.b === r.b && last.i === r.i && last.u === r.u) last.text += r.text
    else merged.push({ ...r })
  }
  return merged
}
function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return 0
  const range = sel.getRangeAt(0)
  const pre = document.createRange()
  pre.selectNodeContents(el)
  if (!el.contains(range.startContainer)) return 0
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}
function setCaret(el: HTMLElement, offset: number) {
  const sel = window.getSelection()
  if (!sel) return
  let remaining = offset
  let node: Node | null = null
  let nodeOffset = 0
  const walk = (n: Node): boolean => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) {
        const len = (c.textContent || '').length
        if (remaining <= len) {
          node = c
          nodeOffset = remaining
          return true
        }
        remaining -= len
      } else if ((c as HTMLElement).tagName === 'BR') {
        if (remaining === 0) {
          node = c.parentNode
          nodeOffset = Array.from((c.parentNode as Node).childNodes).indexOf(c)
          return true
        }
        remaining -= 0
      } else if (walk(c)) return true
    }
    return false
  }
  if (!walk(el)) {
    node = el
    nodeOffset = el.childNodes.length
  }
  const r = document.createRange()
  try {
    r.setStart(node!, nodeOffset)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  } catch {
    /* ignore */
  }
}

export default function WordEditor({
  docId,
  name,
  identity,
  importPayload,
  onImported,
  onBack,
  onDocRenamed,
}: Props) {
  const { ydoc, provider, user, rename } = useCollab(docId, identity)
  const [docName, setDocName] = useState(name)
  const [renaming, setRenaming] = useState(false)
  const blocksArr = useMemo(() => ydoc.getArray<Y.Map<any>>('blocks'), [ydoc])
  const meta = useMemo(() => ydoc.getMap<any>('wmeta'), [ydoc])

  const [blocks, setBlocks] = useState<Blk[]>([])
  const [peers, setPeers] = useState<Peer[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [ready, setReady] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [drawer, setDrawer] = useState<'none' | 'share' | 'history' | 'people'>('none')
  const [exportOpen, setExportOpen] = useState(false)
  const [showRename, setShowRename] = useState(false)

  const refs = useRef<Map<string, HTMLDivElement>>(new Map())
  const focusRef = useRef<string | null>(null)
  const pending = useRef<{ id: string; offset: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const noticeTimer = useRef<number | null>(null)

  const flash = (m: string) => {
    setNotice(m)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3000)
  }
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

  /** 改名：调用后端持久化，成功后同步本地与 App 状态 */
  const renameDoc = async (next: string) => {
    if (renaming || next.trim() === docName) return
    setRenaming(true)
    try {
      const r = await api.renameDoc(docId, next.trim())
      setDocName(r.name)
      flash('已重命名')
      onDocRenamed?.(r.name)
    } catch (e) {
      flash('重命名失败：' + errMsg(e))
      throw e
    } finally {
      setRenaming(false)
    }
  }

  const snapshot = (): Blk[] => {
    const out: Blk[] = []
    blocksArr.forEach((m) => {
      const t = m.get('text') as Y.Text | undefined
      out.push({
        id: (m.get('id') as string) || '',
        type: (m.get('type') as BlockType) || 'p',
        align: (m.get('align') as Align) || undefined,
        delta: t ? (t.toDelta() as DeltaItem[]) : [{ insert: '' }],
      })
    })
    return out
  }
  const findMap = (id: string): Y.Map<any> | undefined => {
    let found: Y.Map<any> | undefined
    blocksArr.forEach((m) => {
      if (m.get('id') === id) found = m
    })
    return found
  }
  const getText = (id: string): Y.Text | undefined =>
    findMap(id)?.get('text') as Y.Text | undefined

  const makeBlock = (type: BlockType = 'p'): Y.Map<any> => {
    const m = new Y.Map<any>()
    m.set('id', Math.random().toString(36).slice(2, 10))
    m.set('type', type)
    m.set('text', new Y.Text())
    return m
  }

  // 等待首次与服务端同步完成，避免在空 doc 上误建初始段落
  useEffect(() => {
    if (provider.synced) {
      setReady(true)
      return
    }
    const h = (s: boolean) => {
      if (s) setReady(true)
    }
    provider.on('sync', h)
    return () => provider.off('sync', h)
  }, [provider])

  // 初始化：至少一个段落（同步完成后才判定）
  useEffect(() => {
    if (!ready) return
    if (blocksArr.length === 0 && !meta.get('init')) {
      ydoc.transact(() => {
        meta.set('init', true)
        if (blocksArr.length === 0) blocksArr.push([makeBlock('p')])
      }, STRUCT)
    }
    setBlocks(snapshot())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, blocksArr])

  // 观察文档变化
  useEffect(() => {
    const upd = (_events: any, tr: Y.Transaction) => {
      if (tr.origin === LOCAL) return
      setBlocks(snapshot())
    }
    blocksArr.observeDeep(upd)
    return () => blocksArr.unobserveDeep(upd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocksArr])

  // 未聚焦的块：把 Yjs 内容写回 DOM
  useEffect(() => {
    for (const b of blocks) {
      if (focusRef.current === b.id) continue
      const el = refs.current.get(b.id)
      if (!el) continue
      const html = deltaToHtml(b.delta)
      if (el.innerHTML !== html) el.innerHTML = html
    }
  }, [blocks])

  // 撤销/重做
  const undoMgr = useRef<UndoManager | null>(null)
  useEffect(() => {
    const um = new UndoManager(blocksArr, { trackedOrigins: new Set([LOCAL]) })
    undoMgr.current = um
    const upd = () => {
      setCanUndo(um.undoStack.length > 0)
      setCanRedo(um.redoStack.length > 0)
    }
    um.on('stack-item-added', upd)
    um.on('stack-item-popped', upd)
    um.on('stack-cleared', upd)
    upd()
    return () => um.destroy()
  }, [blocksArr])

  // 光标落位（结构操作后）
  useEffect(() => {
    if (!pending.current) return
    const { id, offset } = pending.current
    pending.current = null
    const el = refs.current.get(id)
    if (el) {
      el.focus()
      setCaret(el, offset)
    }
  }, [blocks])

  // 在线协作者：聚焦块位置
  useEffect(() => {
    const aw = provider.awareness
    const upd = () => {
      const arr: Peer[] = []
      aw.getStates().forEach((st: any, clientId: number) => {
        if (clientId === aw.clientID) return
        if (!st?.user) return
        arr.push({
          id: st.user.id,
          name: st.user.name,
          colorIndex: st.user.colorIndex,
          block: (st.wblock as string) ?? null,
          guest: !!st.user.guest,
        })
      })
      setPeers(arr)
    }
    aw.on('change', upd)
    upd()
    return () => aw.off('change', upd)
  }, [provider])

  const commitFocus = (id: string | null) => {
    focusRef.current = id
    setActive(id)
    provider.awareness.setLocalStateField('wblock', id)
  }

  // 本地输入同步到 Yjs
  const pushBlock = (id: string) => {
    const el = refs.current.get(id)
    const yt = getText(id)
    if (!el || !yt) return
    const runs = serializeEl(el)
    const delta: any[] = runs.map((r) => ({ insert: r.text, attributes: markAttrs(r) }))
    ydoc.transact(() => {
      ;(yt as any).applyDelta([{ delete: yt.length }, ...delta])
    }, LOCAL)
  }

  const onKeyDown = (id: string, e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = refs.current.get(id)
    if (!el) return
    const yt = getText(id)
    if (!yt) return
    if (e.key === 'Enter') {
      e.preventDefault()
      const off = caretOffset(el)
      const delta = yt.toDelta() as DeltaItem[]
      const [left, right] = splitDelta(delta, off)
      const m = findMap(id)
      const newType: BlockType = m?.get('type') === 'li' ? 'li' : 'p'
      const nb = makeBlock(newType)
      const nbText = nb.get('text') as Y.Text
      const idx = blocksArr.toArray().indexOf(m!)
      ydoc.transact(() => {
        ;(yt as any).applyDelta([{ delete: yt.length }, ...left.map((d) => ({ insert: d.insert, attributes: d.attributes }))])
        if (right.length) nbText.applyDelta(right.map((d) => ({ insert: d.insert, attributes: d.attributes })))
        blocksArr.insert(idx + 1, [nb])
      }, STRUCT)
      pending.current = { id: nb.get('id') as string, offset: 0 }
      focusRef.current = null
      setBlocks(snapshot())
      return
    }
    if (e.key === 'Backspace') {
      const off = caretOffset(el)
      if (off === 0) {
        const idx = blocksArr.toArray().indexOf(findMap(id)!)
        if (idx > 0) {
          e.preventDefault()
          const prev = blocksArr.get(idx - 1)
          const prevText = prev.get('text') as Y.Text
          const prevLen = prevText.length
          const delta = yt.toDelta() as DeltaItem[]
          ydoc.transact(() => {
            ;(prevText as any).applyDelta(delta.map((d) => ({ insert: d.insert, attributes: d.attributes })))
            blocksArr.delete(idx, 1)
          }, STRUCT)
          pending.current = { id: prev.get('id') as string, offset: prevLen }
          focusRef.current = null
          setBlocks(snapshot())
        }
      }
    }
  }

  // 工具栏动作
  const setType = (t: BlockType) => {
    const id = focusRef.current || active
    if (!id) return
    const m = findMap(id)
    if (!m) return
    ydoc.transact(() => m.set('type', t), STRUCT)
    setBlocks(snapshot())
  }
  const setAlign = (a: Align) => {
    const id = focusRef.current || active
    if (!id) return
    const m = findMap(id)
    if (!m) return
    ydoc.transact(() => m.set('align', m.get('align') === a ? undefined : a), STRUCT)
    setBlocks(snapshot())
  }
  const exec = (cmd: 'bold' | 'italic' | 'underline') => {
    document.execCommand(cmd)
    const id = focusRef.current
    if (id) pushBlock(id)
  }

  const curType: BlockType =
    (active && (findMap(active)?.get('type') as BlockType)) || 'p'
  const curAlign: Align | undefined = active
    ? (findMap(active)?.get('align') as Align | undefined)
    : undefined

  // 把一组段落整体写入 Yjs（导入 .docx / 模板 / .md 共用）
  const writeBlocks = (
    parsed: { id?: string; type: BlockType; align?: Align; runs: Run[] }[],
    label: string
  ) => {
    ydoc.transact(() => {
      blocksArr.delete(0, blocksArr.length)
      meta.set('init', true)
      const items = parsed.map((b) => {
        const m = new Y.Map<any>()
        m.set('id', b.id || Math.random().toString(36).slice(2, 10))
        m.set('type', b.type)
        if (b.align) m.set('align', b.align)
        const t = new Y.Text()
        m.set('text', t)
        const delta = b.runs
          .filter((r) => r.text)
          .map((r) => ({ insert: r.text, attributes: markAttrs(r) }))
        if (delta.length) t.applyDelta(delta)
        return m
      })
      blocksArr.push(items)
    }, STRUCT)
    setBlocks(snapshot())
    flash(label)
  }

  // 待导入内容（工作台解析好传过来的）：同步完成后写入一次
  const importedRef = useRef(false)
  const [syncTick, setSyncTick] = useState(0)
  useEffect(() => {
    if (provider.synced) return
    const h = (s: boolean) => s && setSyncTick((t) => t + 1)
    provider.on('sync', h)
    return () => provider.off('sync', h)
  }, [provider, provider.synced])

  useEffect(() => {
    if (!importPayload || importedRef.current) return
    if (importPayload.target !== 'doc') return
    if (!ready || !provider.synced) return
    importedRef.current = true
    writeBlocks(
      importPayload.blocks as { id?: string; type: BlockType; align?: Align; runs: Run[] }[],
      `已导入：${importPayload.blocks.length} 个段落（${importPayload.file}）`
    )
    onImported?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importPayload, ready, provider.synced, syncTick])

  // 导入 docx
  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      const parsed = docxToBlocks(buf)
      if (!parsed.length) throw new Error('文档中没有可用段落')
      writeBlocks(parsed, `已导入：${parsed.length} 个段落（${file.name}）`)
    } catch (err) {
      flash('导入失败：' + errMsg(err))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // 当前段落文本（导出用）
  const plainBlocks = () =>
    blocks.map((b) => ({
      id: b.id,
      type: b.type,
      align: b.align,
      runs: b.delta
        .filter((d) => typeof d.insert === 'string')
        .map((d) => ({
          text: d.insert,
          b: !!d.attributes?.bold,
          i: !!d.attributes?.italic,
          u: !!d.attributes?.underline,
        })),
    }))

  // 导出（S7 多格式）
  const onExportFormat = (fmt: DocFormat) => {
    try {
      if (blocks.length === 0 || blocks.every((b) => !b.delta.length)) {
        flash('文档还没有内容')
        return
      }
      const base = docName || 'document'
      if (fmt === 'docx') {
        const data = blocksToDocx(plainBlocks())
        download(
          base + '.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          data
        )
      } else if (fmt === 'md') {
        download(
          base + '.md',
          'text/markdown;charset=utf-8',
          blocksToMarkdown(
            blocks.map((b) => ({
              id: b.id,
              type: b.type,
              text: b.delta.map((d) => String(d.insert ?? '')).join(''),
            }))
          )
        )
      } else if (fmt === 'txt') {
        download(
          base + '.txt',
          'text/plain;charset=utf-8',
          blocksToText(
            blocks.map((b) => ({
              id: b.id,
              type: b.type,
              text: b.delta.map((d) => String(d.insert ?? '')).join(''),
            }))
          )
        )
      } else {
        printToPdf()
      }
    } catch (err) {
      flash('导出失败：' + errMsg(err))
    }
  }

  // 大纲：只取标题层级
  const outline = useMemo(
    () =>
      blocks
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b.type === 'h1' || b.type === 'h2' || b.type === 'h3')
        .map(({ b, i }) => ({
          id: b.id,
          level: b.type,
          text: b.delta.map((d) => String(d.insert ?? '')).join('') || '（空标题）',
          index: i + 1,
        })),
    [blocks]
  )

  const scrollToBlock = (id: string) => {
    const el = refs.current.get(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('flash-target')
      window.setTimeout(() => el.classList.remove('flash-target'), 1200)
    }
  }

  const peersByBlock = useMemo(() => {
    const map = new Map<string, Peer>()
    for (const p of peers) if (p.block) map.set(p.block, p)
    return map
  }, [peers])

  return (
    <div className="editor">
      <header className="topbar">
        <div className="topbar-left">
          <button className="btn-ghost icon" onClick={onBack} title="返回工作台">
            ‹
          </button>
          <EditableTitle
            name={docName}
            disabled={renaming}
            onRename={renameDoc}
          />
          <span className="doc-kind">文档</span>
          <button
            className="wpresence presence-btn-clean"
            onClick={() => setDrawer('people')}
            title="查看协作者"
          >
            {peers.slice(0, 5).map((p) => {
              const c = colorOf(p.colorIndex)
              return (
                <span key={p.id} className="avatar" style={{ background: c.ink }} title={p.name}>
                  {p.name.slice(0, 1)}
                </span>
              )
            })}
            {peers.length > 5 && <span className="avatar more">+{peers.length - 5}</span>}
          </button>
        </div>
        <div className="topbar-right">
          <div className="topbar-more">
            <button className="btn-ghost" onClick={() => setReadOnly((v) => !v)}>
              {readOnly ? '恢复编辑' : '只读查看'}
            </button>
            <button className="btn-ghost" onClick={() => setDrawer('history')}>
              历史
            </button>
            <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={readOnly}>
              导入
            </button>
            <button className="btn-ghost" onClick={() => setExportOpen(true)}>
              导出
            </button>
          </div>
          <button className="btn-primary" onClick={() => setDrawer('share')}>
            分享
          </button>
        </div>
      </header>
      <input ref={fileRef} type="file" accept=".docx" hidden onChange={onImport} />

      <div className="word-toolbar">
        <button
          className="tbtn"
          disabled={!canUndo}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => undoMgr.current?.undo()}
          title="撤销（仅本人，Ctrl+Z）"
        >
          ↶
        </button>
        <button
          className="tbtn"
          disabled={!canRedo}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => undoMgr.current?.redo()}
          title="重做（Ctrl+Y）"
        >
          ↷
        </button>
        <span className="toolbar-sep" />
        {(['p', 'h1', 'h2', 'h3', 'li'] as BlockType[]).map((t) => (
          <button
            key={t}
            className={'tbtn' + (curType === t ? ' active' : '')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setType(t)}
            title={TYPE_LABEL[t]}
          >
            {TYPE_LABEL[t]}
          </button>
        ))}
        <span className="toolbar-sep" />
        <button
          className={'tbtn' + (curAlign === 'left' ? ' active' : '')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAlign('left')}
          title="左对齐"
        >
          <AlignGlyph mode="left" />
        </button>
        <button
          className={'tbtn' + (curAlign === 'center' ? ' active' : '')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAlign('center')}
          title="居中"
        >
          <AlignGlyph mode="center" />
        </button>
        <button
          className={'tbtn' + (curAlign === 'right' ? ' active' : '')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setAlign('right')}
          title="右对齐"
        >
          <AlignGlyph mode="right" />
        </button>
        <span className="toolbar-sep" />
        <button
          className="tbtn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('bold')}
          title="加粗"
        >
          <b>B</b>
        </button>
        <button
          className="tbtn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('italic')}
          title="斜体"
        >
          <i>I</i>
        </button>
        <button
          className="tbtn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('underline')}
          title="下划线"
        >
          <u>U</u>
        </button>
        <span className="toolbar-hint">选中文字后点 B / I / U 应用格式</span>
      </div>

      {readOnly && (
        <div className="readonly-banner">
          你正在以只读方式查看此文档，段落已锁定，工具条不可操作。
          <button onClick={() => setReadOnly(false)}>恢复编辑</button>
        </div>
      )}

      <div className="word-body">
        <aside className="word-outline">
          <h4>大纲</h4>
          {outline.length === 0 ? (
            <div className="outline-item empty-item">还没有标题</div>
          ) : (
            outline.map((o) => (
              <button
                key={o.id}
                className={'outline-item ' + o.level}
                onClick={() => scrollToBlock(o.id)}
                title={o.text}
              >
                {o.text}
              </button>
            ))
          )}
          <h4 style={{ marginTop: 16 }}>段落 · {blocks.length}</h4>
        </aside>

        <div className={'word-scroll' + (readOnly ? ' readonly' : '')}>
          <div className="word-page">
          {blocks.map((b) => {
            const peer = peersByBlock.get(b.id)
            const pc = peer ? colorOf(peer.colorIndex) : null
            return (
              <div key={b.id} className="wblock-wrap">
                {peer && (
                  <span className="wblock-tag" style={{ background: pc!.ink }}>
                    {peer.name}
                  </span>
                )}
                <div
                  className={
                    'wblock wblock-' +
                    b.type +
                    (peer ? ' has-peer' : '') +
                    (active === b.id ? ' focused' : '')
                  }
                  style={{
                    textAlign: b.align,
                    ...(peer ? { borderLeftColor: pc!.ink } : {}),
                  }}
                  contentEditable={!readOnly}
                  suppressContentEditableWarning
                  ref={(el) => {
                    if (el) refs.current.set(b.id, el)
                    else refs.current.delete(b.id)
                  }}
                  onFocus={() => commitFocus(b.id)}
                  onBlur={() => {
                    if (focusRef.current === b.id) {
                      commitFocus(null)
                      const el = refs.current.get(b.id)
                      const yt = getText(b.id)
                      if (el && yt) el.innerHTML = deltaToHtml(yt.toDelta() as DeltaItem[])
                    }
                  }}
                  onInput={() => pushBlock(b.id)}
                  onKeyDown={(e) => onKeyDown(b.id, e)}
                  onKeyUp={() => {
                    if (focusRef.current !== b.id) commitFocus(b.id)
                  }}
                />
              </div>
            )
          })}
          </div>
        </div>
      </div>

      {drawer === 'share' && (
        <ShareDrawer
          docId={docId}
          selfName={user.name}
          onClose={() => setDrawer('none')}
          onToast={flash}
        />
      )}
      {drawer === 'history' && (
        <HistoryDrawer
          docId={docId}
          selfName={user.name}
          onlinePeers={peers.length + 1}
          onClose={() => setDrawer('none')}
          onToast={flash}
        />
      )}
      {drawer === 'people' && (
        <div className="drawer-mask" onClick={() => setDrawer('none')}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h3>协作者 · {peers.length + 1}</h3>
              <button className="btn-ghost" onClick={() => setDrawer('none')}>
                ×
              </button>
            </div>
            <div className="drawer-body">
              <div className="people-row">
                <span
                  className="avatar clickable"
                  style={{ background: colorOf(user.colorIndex).c }}
                  onClick={() => setShowRename(true)}
                >
                  {user.name.slice(0, 1)}
                </span>
                <span className="member-meta">
                  <span className="member-name">
                    {user.name}
                    <span className="member-self-tag">你</span>
                    {user.guest && <span className="guest-tag">访客</span>}
                  </span>
                  <span className="member-sub">
                    正在编辑第 {(blocks.findIndex((b) => b.id === active) + 1) || '—'} 段
                  </span>
                  <button className="member-rename" onClick={() => setShowRename(true)}>
                    修改名字
                  </button>
                </span>
              </div>
              {peers.length === 0 ? (
                <p className="hint">当前只有你在编辑这份文档。把分享链接发给同事即可一起协作。</p>
              ) : (
                peers.map((p) => {
                  const idx = p.block ? blocks.findIndex((b) => b.id === p.block) + 1 : 0
                  const c = colorOf(p.colorIndex)
                  return (
                    <div
                      className="people-row"
                      key={p.id}
                      onClick={() => p.block && scrollToBlock(p.block)}
                      style={{ cursor: p.block ? 'pointer' : 'default' }}
                    >
                      <span className="avatar" style={{ background: c.ink }}>
                        {p.name.slice(0, 1)}
                      </span>
                      <span className="member-meta">
                        <span className="member-name">
                          {p.name}
                          {p.guest && <span className="guest-tag">访客</span>}
                        </span>
                        <span className="member-sub">
                          {idx ? '正在编辑第 ' + idx + ' 段' : '在线查看'}
                        </span>
                      </span>
                    </div>
                  )
                })
              )}
              <p className="hint">点击某人可跳转到他正在编辑的段落。</p>
            </div>
          </aside>
        </div>
      )}

      <ExportModal
        open={exportOpen}
        kind="doc"
        docName={docName}
        peers={peers.length}
        onlineTotal={peers.length + 1}
        onClose={() => setExportOpen(false)}
        onToast={flash}
        onExportDoc={onExportFormat}
      />

      {notice && (
        <div className="notice" key={notice}>
          {notice}
        </div>
      )}

      {showRename && (
        <IdentityDialog
          user={user}
          provider={provider}
          onSave={(n, c) => {
            rename(n, c)
            setShowRename(false)
          }}
          onClose={() => setShowRename(false)}
        />
      )}
    </div>
  )
}

function AlignGlyph({ mode }: { mode: 'left' | 'center' | 'right' }) {
  const bars: [number, number][] =
    mode === 'left'
      ? [[3, 18], [3, 12], [3, 16]]
      : mode === 'center'
      ? [[4, 16], [7, 10], [3, 18]]
      : [[3, 18], [9, 12], [5, 16]]
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {bars.map(([x, w], i) => (
        <rect key={i} x={x} y={5 + i * 6} width={w} height="2" rx="0.5" />
      ))}
    </svg>
  )
}
