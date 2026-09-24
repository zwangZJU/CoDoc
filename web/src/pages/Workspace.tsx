import { useEffect, useMemo, useState } from 'react'
import { api, type DocMeta } from '../store/api'
import { getLocalUser, colorOf } from '../store/user'
import CreateModal from '../components/CreateModal'
import ExportModal, { type DocFormat, type SheetFormat } from '../components/ExportModal'
import ShareDrawer from '../components/ShareDrawer'
import { withDoc, readSheets, readBlocks } from '../store/loadDocData'
import {
  download,
  sheetsToCsv,
  sheetsToMarkdown,
  blocksToMarkdown,
  blocksToText,
  printToPdf,
} from '../store/exporters'
import { exportWorkbook } from '../sheets/io'
import type { ImportPayload } from '../store/importPayload'

type ViewMode = 'grid' | 'list'
type FilterKey = 'all' | 'doc' | 'sheet'
type NavKey = 'all' | 'fav' | 'shared' | 'trash'
type SortKey = 'updated' | 'opened' | 'name' | 'members'

const NAV: { key: NavKey; label: string }[] = [
  { key: 'all', label: '全部文件' },
  { key: 'fav', label: '收藏' },
  { key: 'shared', label: '共享给我' },
  { key: 'trash', label: '回收站' },
]

const LS_FAV = 'codoc-favs'
const LS_TRASH = 'codoc-trash'
const LS_OPENED = 'codoc-opened'

function readSet(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]')
  } catch {
    return []
  }
}
function writeSet(key: string, v: string[]) {
  localStorage.setItem(key, JSON.stringify(v))
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 名字 → 稳定协同色下标 */
function colorIndexOf(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % 6
}

interface Props {
  onOpen: (id: string, name: string, kind: 'sheet' | 'doc', payload?: ImportPayload) => void
  /** 团队空间模式：指定团队 id 则只显示该团队文件并隐藏个人导航 */
  teamId?: string
  teamName?: string
  onExitTeam?: () => void
  onManageTeam?: () => void
  onOpenTeam?: (t: { id: string; name: string }) => void
}

export default function Workspace({
  onOpen,
  teamId,
  teamName,
  onExitTeam,
  onManageTeam,
  onOpenTeam,
}: Props) {
  const me = useMemo(() => getLocalUser(), [])
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [teams, setTeams] = useState<{ id: string; name: string; fileCount: number }[]>([])
  const [live, setLive] = useState<Record<string, { conns: number; users: string[] }>>({})
  const [view, setView] = useState<ViewMode>('grid')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [nav, setNav] = useState<NavKey>('all')
  const [sort, setSort] = useState<SortKey>('updated')
  const [q, setQ] = useState('')
  const [favs, setFavs] = useState<string[]>(() => readSet(LS_FAV))
  const [trash, setTrash] = useState<string[]>(() => readSet(LS_TRASH))
  const [opened, setOpened] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_OPENED) || '{}')
    } catch {
      return {}
    }
  })

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ doc: DocMeta; x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<DocMeta | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [shareId, setShareId] = useState<string | null>(null)
  const [exportDoc, setExportDoc] = useState<DocMeta | null>(null)

  const flash = (m: string) => {
    setNotice(m)
    window.setTimeout(() => setNotice((n) => (n === m ? null : n)), 2800)
  }
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

  const refresh = () =>
    api
      .listDocs(teamId)
      .then((d) => setDocs(d.docs))
      .catch(() => setDocs([]))

  const refreshTeams = () =>
    api
      .listTeams()
      .then((r) =>
        setTeams(r.teams.map((t) => ({ id: t.id, name: t.name, fileCount: t.fileCount || 0 })))
      )
      .catch(() => setTeams([]))

  // 在线情况：5s 轮询（协同房间连接数 + awareness 用户名）
  useEffect(() => {
    const tick = () => api.getLive().then((r) => setLive(r.rooms)).catch(() => {})
    tick()
    const t = window.setInterval(tick, 5000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    refresh()
  }, [teamId])
  useEffect(() => {
    refreshTeams()
  }, [teamId])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const toggleFav = (id: string) => {
    setFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      writeSet(LS_FAV, next)
      return next
    })
  }

  const moveToTrash = (d: DocMeta) => {
    setTrash((prev) => {
      const next = [...new Set([...prev, d.id])]
      writeSet(LS_TRASH, next)
      return next
    })
    flash(`「${d.name}」已移入回收站`)
  }

  const restoreDoc = (d: DocMeta) => {
    setTrash((prev) => {
      const next = prev.filter((x) => x !== d.id)
      writeSet(LS_TRASH, next)
      return next
    })
    flash(`已还原「${d.name}」`)
  }

  const purgeDoc = async (d: DocMeta) => {
    if (!window.confirm(`彻底删除「${d.name}」？此操作不可恢复。`)) return
    try {
      await api.deleteDoc(d.id)
      setTrash((prev) => {
        const next = prev.filter((x) => x !== d.id)
        writeSet(LS_TRASH, next)
        return next
      })
      flash('已彻底删除')
    } catch (e) {
      flash('删除失败：' + errMsg(e))
    }
  }

  const rename = async (id: string, name: string) => {
    try {
      await api.renameDoc(id, name)
      await refresh()
      flash('已重命名')
    } catch (e) {
      flash('重命名失败：' + errMsg(e))
    }
  }

  const openDoc = (d: DocMeta, payload?: ImportPayload) => {
    setOpened((prev) => {
      const next = { ...prev, [d.id]: Date.now() }
      localStorage.setItem(LS_OPENED, JSON.stringify(next))
      return next
    })
    onOpen(d.id, d.name, d.kind, payload)
  }

  const createDoc = async (name: string, kind: 'sheet' | 'doc') => {
    const d = await api.createDoc(name, kind, me.name, teamId)
    await refresh()
    return { id: d.id, name: d.name, kind: d.kind }
  }

  // ---------- 导出（从工作台直接导出：临时连一次协同房间取最新内容） ----------
  const doExportSheet = async (d: DocMeta, fmt: SheetFormat, currentOnly: boolean) => {
    try {
      const sheets = await withDoc(d.id, (ydoc) => readSheets(ydoc))
      const target = sheets.filter((s) => s.rows.some((r) => r.some((c) => c.v.trim())))
      if (target.length === 0) {
        flash('这个表格还没有内容')
        return
      }
      if (fmt === 'xlsx') {
        exportWorkbook(
          (currentOnly ? target.slice(0, 1) : target).map((s) => ({
            name: s.name,
            rows: s.rows,
            merges: s.merges,
            colw: s.colw,
            rowh: s.rowh,
          })),
          d.name + '.xlsx'
        )
      } else if (fmt === 'csv') {
        download(d.name + '.csv', 'text/csv;charset=utf-8', sheetsToCsv(target, currentOnly ? target[0].name : undefined))
      } else if (fmt === 'md') {
        download(d.name + '.md', 'text/markdown;charset=utf-8', sheetsToMarkdown(target, currentOnly ? target[0].name : undefined))
      } else {
        printToPdf()
      }
    } catch (e) {
      flash('导出失败：' + errMsg(e))
    }
  }

  const doExportDoc = async (d: DocMeta, fmt: DocFormat) => {
    try {
      const blocks = await withDoc(d.id, (ydoc) => readBlocks(ydoc))
      if (blocks.length === 0) {
        flash('这个文档还没有内容')
        return
      }
      if (fmt === 'docx') {
        const { blocksToDocx } = await import('../word/docx')
        const data = blocksToDocx(
          blocks.map((b) => ({ id: b.id || 'x', type: b.type, runs: [{ text: b.text }] }))
        )
        download(
          d.name + '.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          data
        )
      } else if (fmt === 'md') {
        download(d.name + '.md', 'text/markdown;charset=utf-8', blocksToMarkdown(blocks))
      } else if (fmt === 'txt') {
        download(d.name + '.txt', 'text/plain;charset=utf-8', blocksToText(blocks))
      } else {
        printToPdf()
      }
    } catch (e) {
      flash('导出失败：' + errMsg(e))
    }
  }

  // ---------- 列表计算 ----------
  const base = useMemo(() => {
    let list = docs
    // 团队空间只显示该团队文件；个人空间只显示非团队文件（避免重复）
    if (teamId) list = list.filter((d) => d.teamId === teamId)
    else list = list.filter((d) => !d.teamId)
    if (nav === 'fav') list = list.filter((d) => favs.includes(d.id))
    else if (nav === 'shared') list = list.filter((d) => (d.members || 0) > 1)
    else if (nav === 'trash') list = docs.filter((d) => trash.includes(d.id))
    else list = list.filter((d) => !trash.includes(d.id))
    if (filter !== 'all') list = list.filter((d) => d.kind === filter)
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      list = list.filter((d) => d.name.toLowerCase().includes(s))
    }
    const sorted = [...list]
    if (sort === 'updated') sorted.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    else if (sort === 'opened') sorted.sort((a, b) => (opened[b.id] || 0) - (opened[a.id] || 0))
    else if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    else sorted.sort((a, b) => (b.members || 0) - (a.members || 0))
    return sorted
  }, [docs, nav, favs, trash, filter, q, sort, opened])

  const liveCount = (id: string) => live[id]?.users.length || live[id]?.conns || 0
  const liveUsers = (id: string) => live[id]?.users || []
  const liveDocs = docs.filter((d) => liveCount(d.id) > 0).length

  const emptyText = (() => {
    if (nav === 'trash') return '回收站是空的。删除的文件会先放到这里，可随时还原。'
    if (nav === 'fav') return '还没有收藏的文件。在文件卡片右上「⋯」里可以收藏。'
    if (nav === 'shared') return '还没有别人共享给你的文件。'
    if (q.trim()) return `没有名称包含「${q.trim()}」的文件。`
    if (filter !== 'all') return '这个类型下还没有文件。'
    return '还没有文件。点左上角「新建」创建空白文档 / 表格，或把本地文件拖进来导入。'
  })()

  const renderCard = (d: DocMeta) => {
    const online = liveCount(d.id)
    const users = liveUsers(d.id)
    const inTrash = nav === 'trash'
    return (
      <div className="fcard__wrap" key={d.id}>
        <div
          className="fcard"
          onClick={() => (inTrash ? restoreDoc(d) : openDoc(d))}
          title={inTrash ? '点击还原' : '点击打开'}
        >
          <span className={'fcard__thumb ' + (d.kind === 'doc' ? 'is-doc' : 'is-sheet')}>
            {d.kind === 'doc' ? (
              <>
                <i className="t" />
                <i style={{ width: '88%' }} />
                <i style={{ width: '74%' }} />
                <i style={{ width: '93%' }} />
                <i style={{ width: '60%' }} />
              </>
            ) : null}
            <span className="fcard__kind">{d.kind === 'doc' ? '▤' : '▦'}</span>
          </span>
          <span className="fcard__body">
            <span className="fcard__name">{d.name}</span>
            <span className="fcard__meta">
              <span
                className="avatar avatar--xs"
                style={{ background: colorOf(colorIndexOf(d.owner || '我')).c }}
              >
                {(d.owner || '我').slice(0, 1)}
              </span>
              {d.owner || '我'} · {fmtTime(d.updatedAt || d.createdAt)}
            </span>
            <span className="fcard__live">
              {online > 0 ? (
                <>
                  <span className="av-group">
                    {users.slice(0, 4).map((u) => (
                      <span
                        key={u}
                        className="avatar avatar--xs"
                        title={u + ' 正在编辑'}
                        style={{ background: colorOf(colorIndexOf(u)).c }}
                      >
                        {u.slice(0, 1)}
                        <span
                          className="presence-dot"
                          style={{ background: colorOf(colorIndexOf(u)).c }}
                        />
                      </span>
                    ))}
                  </span>
                  <span className="fcard__live-text">{online} 人正在编辑</span>
                </>
              ) : (
                <span className="fcard__live-text muted">最近无协同</span>
              )}
            </span>
          </span>
        </div>
        <button
          className="card-menu-btn fcard__more"
          aria-label="更多操作"
          onClick={(e) => {
            e.stopPropagation()
            setMenu({ doc: d, x: e.clientX, y: e.clientY })
          }}
        >
          ⋯
        </button>
      </div>
    )
  }

  const renderRow = (d: DocMeta) => {
    const online = liveCount(d.id)
    return (
      <div className="frow" key={d.id} onClick={() => (nav === 'trash' ? restoreDoc(d) : openDoc(d))}>
        <span className={'frow-icon ' + d.kind}>{d.kind === 'doc' ? '▤' : '▦'}</span>
        <span className="frow-name">{d.name}</span>
        <span className="frow-owner">
          <span
            className="avatar avatar--xs"
            style={{ background: colorOf(colorIndexOf(d.owner || '我')).c }}
          >
            {(d.owner || '我').slice(0, 1)}
          </span>
          {d.owner || '我'}
        </span>
        <span className="frow-time">{fmtTime(d.updatedAt || d.createdAt)}</span>
        <span className="frow-live">
          {online > 0 ? (
            <span className="live-badge">
              <span className="live-dot" />
              {online} 人正在编辑
            </span>
          ) : (
            <span className="muted">—</span>
          )}
        </span>
        <button
          className="card-menu-btn"
          onClick={(e) => {
            e.stopPropagation()
            setMenu({ doc: d, x: e.clientX, y: e.clientY })
          }}
        >
          ⋯
        </button>
      </div>
    )
  }

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="topbar-left">
          {teamId ? (
            <>
              <button className="btn-ghost" onClick={onExitTeam} title="返回我的空间">
                ← 我的空间
              </button>
              <span className="brand">{teamName || '团队空间'}</span>
            </>
          ) : (
            <span className="brand">
              同写 <b>CoDoc</b>
            </span>
          )}
        </div>
        <input
          className="ws-search"
          placeholder="搜索文件名…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="topbar-right">
          <span className="avatar" style={{ background: colorOf(me.colorIndex).c }} title={me.name}>
            {me.name.slice(0, 1)}
          </span>
        </div>
      </header>

      <div className="ws-body">
        <aside className="sidebar">
          <button
            className="btn-primary sidebar-new"
            disabled={busy}
            onClick={() => setCreateOpen(true)}
          >
            + 新建 / 导入
          </button>
          {!teamId && (
            <nav className="sidebar-nav">
              {NAV.map((n) => (
                <button
                  key={n.key}
                  className={'nav-item' + (nav === n.key ? ' active' : '')}
                  onClick={() => setNav(n.key)}
                >
                  {n.label}
                  {n.key === 'all' && docs.length ? (
                    <span className="nav-count">
                      {docs.filter((d) => !d.teamId && !trash.includes(d.id)).length}
                    </span>
                  ) : null}
                  {n.key === 'fav' && favs.length ? <span className="nav-count">{favs.length}</span> : null}
                </button>
              ))}
            </nav>
          )}
          <div className="sidebar-section">
            <div className="sidebar-sec-head">
              <h4>团队空间</h4>
              <button className="link-btn" onClick={onManageTeam} title="管理团队与成员">
                管理
              </button>
            </div>
            {teams.length === 0 ? (
              <div className="sidebar-empty">还没有团队，点「管理」创建</div>
            ) : (
              teams.map((t) => (
                <button
                  key={t.id}
                  className={'team-item' + (teamId === t.id ? ' active' : '')}
                  onClick={() => onOpenTeam?.({ id: t.id, name: t.name })}
                >
                  <span>{t.name}</span>
                  <span className="team-count">{t.fileCount} 个文件</span>
                </button>
              ))
            )}
          </div>
          <div className="sidebar-section">
            <h4>实时协同</h4>
            {liveDocs === 0 ? (
              <div className="sidebar-empty">当前没有人在编辑</div>
            ) : (
              <div className="sidebar-live">{liveDocs} 个文档正在被协同编辑</div>
            )}
          </div>
        </aside>

        <main className="ws-main">
          <div className="page-head">
            <div>
              <h1 className="page-head__title">
                {teamId ? teamName || '团队空间' : NAV.find((n) => n.key === nav)!.label}
              </h1>
              <div className="page-head__sub">
                共 {base.length} 个文件
                {liveDocs ? ` · ${liveDocs} 个正在被协同编辑` : ' · 当前无人在线编辑'}
              </div>
            </div>
            <div className="page-head__right">
              <div className="segmented ws-view-toggle">
                <button
                  className={view === 'grid' ? 'active' : ''}
                  onClick={() => setView('grid')}
                  title="网格视图"
                >
                  ▦
                </button>
                <button
                  className={view === 'list' ? 'active' : ''}
                  onClick={() => setView('list')}
                  title="列表视图"
                >
                  ☰
                </button>
              </div>
              <select
                className="tselect"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                aria-label="排序方式"
              >
                <option value="updated">最近修改</option>
                <option value="opened">最近打开</option>
                <option value="name">按名称</option>
                <option value="members">协作者最多</option>
              </select>
            </div>
          </div>

          <div className="ws-filters">
            <div className="segmented">
              {(
                [
                  ['all', '全部'],
                  ['doc', '文档'],
                  ['sheet', '表格'],
                ] as [FilterKey, string][]
              ).map(([f, label]) => (
                <button
                  key={f}
                  className={filter === f ? 'active' : ''}
                  onClick={() => setFilter(f)}
                >
                  {label}
                </button>
              ))}
            </div>
            {liveDocs > 0 && (
              <span className="live-badge">
                <span className="live-dot" />
                正在协同 {liveDocs}
              </span>
            )}
          </div>

          {base.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">○</div>
              <p className="empty__text">{emptyText}</p>
              {nav !== 'trash' && (
                <button className="btn-primary" onClick={() => setCreateOpen(true)}>
                  新建或导入文件
                </button>
              )}
            </div>
          ) : view === 'grid' ? (
            <div className="card-grid">{base.map(renderCard)}</div>
          ) : (
            <div className="frow-list">{base.map(renderRow)}</div>
          )}
        </main>
      </div>

      <CreateModal
        open={createOpen}
        existingNames={docs.map((d) => d.name)}
        onClose={() => setCreateOpen(false)}
        onCreate={createDoc}
        onImport={(d, payload) => {
          openDoc({ ...d } as DocMeta, payload)
        }}
        onToast={flash}
      />

      {shareId && (
        <ShareDrawer
          docId={shareId}
          selfName={me.name}
          onClose={() => setShareId(null)}
          onToast={flash}
        />
      )}

      {exportDoc && (
        <ExportModal
          open
          kind={exportDoc.kind}
          docName={exportDoc.name}
          peers={Math.max(0, liveCount(exportDoc.id) - 1)}
          onlineTotal={Math.max(1, liveCount(exportDoc.id))}
          onClose={() => setExportDoc(null)}
          onToast={flash}
          onExportSheet={(fmt, opts) => {
            doExportSheet(exportDoc, fmt, opts.currentOnly)
          }}
          onExportDoc={(fmt) => {
            doExportDoc(exportDoc, fmt)
          }}
        />
      )}

      {menu && (
        <div
          className="ctx-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 180), top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {nav === 'trash' ? (
            <>
              <button
                onClick={() => {
                  restoreDoc(menu.doc)
                  setMenu(null)
                }}
              >
                还原
              </button>
              <button
                className="danger"
                onClick={() => {
                  purgeDoc(menu.doc)
                  setMenu(null)
                }}
              >
                彻底删除
              </button>
            </>
          ) : teamId ? (
            <>
              <button
                onClick={() => {
                  openDoc(menu.doc)
                  setMenu(null)
                }}
              >
                打开
              </button>
              <button
                onClick={() => {
                  setShareId(menu.doc.id)
                  setMenu(null)
                }}
              >
                分享与权限
              </button>
              <button
                onClick={() => {
                  setExportDoc(menu.doc)
                  setMenu(null)
                }}
              >
                导出
              </button>
              <button
                onClick={() => {
                  setRenameTarget(menu.doc)
                  setRenameVal(menu.doc.name)
                  setMenu(null)
                }}
              >
                重命名
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  openDoc(menu.doc)
                  setMenu(null)
                }}
              >
                打开
              </button>
              <button
                onClick={() => {
                  setShareId(menu.doc.id)
                  setMenu(null)
                }}
              >
                分享与权限
              </button>
              <button
                onClick={() => {
                  setExportDoc(menu.doc)
                  setMenu(null)
                }}
              >
                导出
              </button>
              <button
                onClick={() => {
                  toggleFav(menu.doc.id)
                  setMenu(null)
                  flash(favs.includes(menu.doc.id) ? '已取消收藏' : '已收藏')
                }}
              >
                {favs.includes(menu.doc.id) ? '取消收藏' : '收藏'}
              </button>
              <button
                onClick={() => {
                  setRenameTarget(menu.doc)
                  setRenameVal(menu.doc.name)
                  setMenu(null)
                }}
              >
                重命名
              </button>
              <button
                className="danger"
                onClick={() => {
                  moveToTrash(menu.doc)
                  setMenu(null)
                }}
              >
                移入回收站
              </button>
            </>
          )}
        </div>
      )}

      {renameTarget && (
        <div className="modal-mask" onClick={() => setRenameTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>重命名</h3>
            <input
              autoFocus
              className="modal-input"
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  rename(renameTarget.id, renameVal.trim() || renameTarget.name)
                  setRenameTarget(null)
                }
              }}
            />
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  rename(renameTarget.id, renameVal.trim() || renameTarget.name)
                  setRenameTarget(null)
                }}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && <div className="notice">{notice}</div>}
    </div>
  )
}
