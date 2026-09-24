import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { useCollab } from '../store/useCollab'
import { useAwareness } from '../store/useAwareness'
import { useSheet } from '../sheets/useSheet'
import SheetEditor from '../sheets/SheetEditor'
import TopBar from '../components/TopBar'
import { CollaboratorPanel, PresenceBar } from '../components/PresenceBar'
import { IdentityDialog } from '../components/GuestGate'
import ShareDrawer from '../components/ShareDrawer'
import HistoryDrawer from '../components/HistoryDrawer'
import ExportModal, { type SheetFormat } from '../components/ExportModal'
import { exportWorkbook, importWorkbook, type ImportedSheet } from '../sheets/io'
import { readSheets } from '../store/loadDocData'
import { download, sheetsToCsv, sheetsToMarkdown, printToPdf } from '../store/exporters'
import type { CellData, MergeInfo } from '../sheets/useSheet'
import { DEFAULT_COLS, DEFAULT_ROWS } from '../sheets/useSheet'
import type { ImportPayload } from '../store/importPayload'
import type { LocalUser } from '../store/user'
import { api } from '../store/api'

/** 导入后至少保留这么多行，方便继续编辑（不足时补空行，不影响原始数据） */
const MIN_SHEET_ROWS = DEFAULT_ROWS
/** 导入后至少保留这么多列（文件只有 8 列时也要能看到 Z，不能只到 H） */
const MIN_SHEET_COLS = DEFAULT_COLS

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

export default function Editor({
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
  const [showRename, setShowRename] = useState(false)
  const peers = useAwareness(provider)
  const [activeSheet, setActiveSheet] = useState('Sheet1')
  const sheet = useSheet(ydoc, activeSheet)
  const [drawer, setDrawer] = useState<'none' | 'people' | 'share' | 'history'>('none')
  const [exportOpen, setExportOpen] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [jumpTo, setJumpTo] = useState<{ r: number; c: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const importedRef = useRef(false)

  const flash = (msg: string) => {
    setNotice(msg)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2800)
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

  /** 把解析好的工作表写进 Yjs（导入 / 模板初始化共用） */
  const writeSheets = (sheets: ImportedSheet[], label: string) => {
    const sheetsMap = ydoc.getMap<any>('sheets')
    const mergesMap = ydoc.getMap('merges')
    const colwMap = ydoc.getMap('colw')
    const rowhMap = ydoc.getMap('rowh')
    ydoc.transact(() => {
      Array.from(sheetsMap.keys()).forEach((k) => sheetsMap.delete(k))
      Array.from(mergesMap.keys()).forEach((k) => mergesMap.delete(k))
      Array.from(colwMap.keys()).forEach((k) => colwMap.delete(k))
      Array.from(rowhMap.keys()).forEach((k) => rowhMap.delete(k))
      sheets.forEach((s) => {
        // 稠密化：行列必须补齐，否则 Yjs 会因 undefined 项直接抛错导致整次导入失败
        // 列数同样要补到默认列数——否则导入 8 列的文件，网页上就只剩 A~H，没法继续往右写
        const colCount = Math.max(
          s.rows.reduce((n, r) => Math.max(n, r.length), 0),
          MIN_SHEET_COLS
        )
        const rowCount = Math.max(s.rows.length, MIN_SHEET_ROWS)
        const arr = new Y.Array<Y.Array<CellData>>()
        for (let r = 0; r < rowCount; r++) {
          const src = s.rows[r]
          const cells: CellData[] = new Array(colCount)
          for (let c = 0; c < colCount; c++) {
            const cell = src?.[c]
            cells[c] = cell && typeof cell === 'object' && 'v' in cell ? cell : { v: '' }
          }
          const row = new Y.Array<CellData>()
          row.insert(0, cells)
          arr.push([row])
        }
        const sheetName = s.name || 'Sheet' + (sheetsMap.size + 1)
        sheetsMap.set(sheetName, arr)

        const mergeInner = new Y.Map<MergeInfo>()
        ;(s.merges || []).forEach((m) => mergeInner.set(`${m.r},${m.c}`, m))
        mergesMap.set(sheetName, mergeInner)

        const colwInner = new Y.Map<number>()
        Object.keys(s.colw || {}).forEach((k) => colwInner.set(k, Math.round(s.colw[k])))
        colwMap.set(sheetName, colwInner)

        const rowhInner = new Y.Map<number>()
        Object.keys(s.rowh || {}).forEach((k) => rowhInner.set(k, Math.round(s.rowh[k])))
        rowhMap.set(sheetName, rowhInner)
      })
    })
    setActiveSheet(sheets[0]?.name || 'Sheet1')
    flash(label)
  }

  // 等到与服务端同步完成，再应用一次待导入内容（避免被远端空状态覆盖）
  const [syncTick, setSyncTick] = useState(0)
  useEffect(() => {
    if (provider.synced) return
    const h = (s: boolean) => s && setSyncTick((t) => t + 1)
    provider.on('sync', h)
    return () => provider.off('sync', h)
  }, [provider, provider.synced])

  useEffect(() => {
    if (!importPayload || importedRef.current) return
    if (importPayload.target !== 'sheet') return
    if (!provider.synced) return
    importedRef.current = true
    writeSheets(
      importPayload.sheets,
      `已导入：${importPayload.sheets.length} 个工作表（${importPayload.file}）`
    )
    onImported?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importPayload, provider.synced, syncTick])

  const onExport = (fmt: SheetFormat, opts: { currentOnly: boolean; sheet: string }) => {
    try {
      const sheets = readSheets(ydoc).filter((s) => s.rows.some((r) => r.some((c) => c.v.trim())))
      if (sheets.length === 0) {
        flash('当前没有可导出的内容')
        return
      }
      const target = opts.currentOnly ? sheets.filter((s) => s.name === opts.sheet) : sheets
      if (fmt === 'xlsx') {
        exportWorkbook(
          target.map((s) => ({
            name: s.name,
            rows: s.rows,
            merges: s.merges,
            colw: s.colw,
            rowh: s.rowh,
          })),
          (docName || 'workbook') + '.xlsx'
        )
      } else if (fmt === 'csv') {
        download((docName || 'workbook') + '.csv', 'text/csv;charset=utf-8', sheetsToCsv(target))
      } else if (fmt === 'md') {
        download((docName || 'workbook') + '.md', 'text/markdown;charset=utf-8', sheetsToMarkdown(target))
      } else {
        printToPdf()
      }
    } catch (err) {
      flash('导出失败：' + errMsg(err))
    }
  }

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const imported = await importWorkbook(file)
      writeSheets(imported, `已导入：${imported.length} 个工作表（${file.name}）`)
    } catch (err) {
      flash('导入失败：' + errMsg(err))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="editor">
      <TopBar
        name={docName}
        kind="sheet"
        onBack={onBack}
        onShare={() => setDrawer('share')}
        onPeople={() => setDrawer('people')}
        onHistory={() => setDrawer('history')}
        onExport={() => setExportOpen(true)}
        onToggleReadOnly={() => setReadOnly((v) => !v)}
        readOnly={readOnly}
        fileRef={fileRef}
        peers={peers}
        user={user}
        onRename={() => setShowRename(true)}
        onDocRename={renameDoc}
        renameDisabled={readOnly || renaming}
      />
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={onImportFile} />

      {readOnly && (
        <div className="readonly-banner">
          你正在以只读方式查看此表格，网格已锁定。
          <button onClick={() => setReadOnly(false)}>恢复编辑</button>
        </div>
      )}

      <div className="editor-body">
        <SheetEditor
          sheet={sheet}
          setActiveSheet={setActiveSheet}
          peers={peers}
          user={user}
          provider={provider}
          jumpTo={jumpTo}
          readOnly={readOnly}
          docId={docId}
        />
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
        <CollaboratorPanel
          peers={peers}
          user={user}
          onClose={() => setDrawer('none')}
          onJump={(c) => setJumpTo({ r: c.r, c: c.c })}
        />
      )}

      <ExportModal
        open={exportOpen}
        kind="sheet"
        docName={docName}
        peers={peers.length}
        onlineTotal={peers.length + 1}
        sheetNames={sheet.sheetNames}
        activeSheet={activeSheet}
        onClose={() => setExportOpen(false)}
        onToast={flash}
        onExportSheet={onExport}
      />

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

      {notice && (
        <div className="notice" key={notice}>
          {notice}
        </div>
      )}
    </div>
  )
}
