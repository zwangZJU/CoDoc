import { useEffect, useState } from 'react'
import Workspace from './pages/Workspace'
import Editor from './pages/Editor'
import WordEditor from './pages/WordEditor'
import { GuestGate, type GuestJoinInfo } from './components/GuestGate'
import TeamAdmin from './pages/TeamAdmin'
import { api } from './store/api'
import { getGuestUser, saveGuestUser, type LocalUser } from './store/user'
import type { ImportPayload } from './store/importPayload'

type Route =
  | { page: 'workspace' }
  | { page: 'loading'; docId: string; shared: boolean }
  | { page: 'editor'; docId: string; name: string; shared: boolean }
  | { page: 'word'; docId: string; name: string; shared: boolean }
  | { page: 'notfound'; docId: string }

function readDocParam(): string | null {
  const p = new URLSearchParams(location.search).get('doc')
  return p && p.trim() ? p.trim() : null
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => {
    const id = readDocParam()
    return id ? { page: 'loading', docId: id, shared: true } : { page: 'workspace' }
  })
  /** 新建并导入时，先把解析好的内容交给编辑器，由它在同步完成后写入 Yjs */
  const [pendingImport, setPendingImport] = useState<ImportPayload | null>(null)
  /** 已登记的访客身份（来自分享链接）；为空表示尚未登记，需要弹卡片。
   *  初始值直接同步读本机记忆——刷新页面后第一帧就恢复身份，
   *  不再闪一帧「请登记姓名」，也不会在恢复前看起来像换了个人。 */
  const [guest, setGuest] = useState<LocalUser | null>(() => getGuestUser())
  /** 当前查看的团队空间（非空表示进入某团队的团队空间视图） */
  const [teamView, setTeamView] = useState<{ id: string; name: string } | null>(null)
  /** 是否打开团队管理（管理员页面） */
  const [adminView, setAdminView] = useState(false)

  // 通过 ?doc= 进入时，先拉文档元数据还原标题与类型
  useEffect(() => {
    if (route.page !== 'loading') return
    let alive = true
    api
      .getDoc(route.docId)
      .then((d) => {
        if (!alive) return
        setRoute(d.kind === 'doc' ? { page: 'word', docId: d.id, name: d.name, shared: true } : { page: 'editor', docId: d.id, name: d.name, shared: true })
      })
      .catch((e) => {
        if (!alive) return
        setRoute({ page: 'notfound', docId: route.docId })
        console.warn('[CoDoc] 打开分享链接失败：', e?.message || e)
      })
    return () => {
      alive = false
    }
  }, [route])

  // 链接进入但本机已记住访客身份，直接套用，无需再弹卡片
  useEffect(() => {
    if ((route.page === 'editor' || route.page === 'word') && !guest) {
      const g = getGuestUser()
      if (g) setGuest(g)
    }
  }, [route, guest])

  const open = (docId: string, name: string, kind: 'sheet' | 'doc', payload?: ImportPayload) => {
    setPendingImport(payload || null)
    history.replaceState(null, '', '?doc=' + encodeURIComponent(docId))
    setRoute(kind === 'doc' ? { page: 'word', docId, name, shared: false } : { page: 'editor', docId, name, shared: false })
  }

  /** 编辑器内改名后，同步 App 路由里的标题（返回工作台 / 再次分享时用新名） */
  const applyDocRename = (next: string) => {
    setRoute((r) =>
      r.page === 'editor' || r.page === 'word'
        ? { ...r, name: next }
        : r
    )
  }

  const back = () => {
    setPendingImport(null)
    setGuest(null)
    setTeamView(null)
    setAdminView(false)
    history.replaceState(null, '', location.pathname)
    setRoute({ page: 'workspace' })
  }

  /** 访客卡片提交：登记身份（可选注册为成员）后放行进入 */
  const onJoin = (info: GuestJoinInfo) => {
    const u = saveGuestUser(info.name, info.colorIndex, info.remember)
    setGuest(u)
    if (info.register && (route.page === 'editor' || route.page === 'word')) {
      api.invite(route.docId, info.name, 'edit').catch(() => {
        /* 注册失败不阻断进入，仅在线名单可见 */
      })
    }
  }

  // 拉取文档元数据期间：loading 占位（此时 route.name 还未就绪，不能弹姓名卡片）
  if (route.page === 'loading') {
    return (
      <div className="guest-mask">
        <div className="guest-card">
          <div className="guest-badge">正在打开</div>
          <h2 className="guest-title">正在连接文档…</h2>
          <p className="guest-sub">正在加载《{route.docId}》的标题与协作房间，请稍候。</p>
        </div>
      </div>
    )
  }

  // 通过分享链接进入、且未登记访客身份 → 弹姓名卡片（不可跳过）
  if ((route.page === 'editor' || route.page === 'word') && route.shared && !guest) {
    return <GuestGate docName={route.name} docId={route.docId} onJoin={onJoin} />
  }

  // 编辑器 / 文档编辑器（最高业务优先级：正在协同编辑）
  if (route.page === 'word') {
    return (
      <WordEditor
        docId={route.docId}
        name={route.name}
        identity={guest}
        importPayload={pendingImport}
        onImported={() => setPendingImport(null)}
        onBack={back}
        onDocRenamed={applyDocRename}
      />
    )
  }
  if (route.page === 'editor') {
    return (
      <Editor
        docId={route.docId}
        name={route.name}
        identity={guest}
        importPayload={pendingImport}
        onImported={() => setPendingImport(null)}
        onBack={back}
        onDocRenamed={applyDocRename}
      />
    )
  }
  if (route.page === 'notfound') {
    return (
      <div className="guest-mask">
        <div className="guest-card">
          <div className="guest-badge">链接失效</div>
          <h2 className="guest-title">这份文档打不开了</h2>
          <p className="guest-sub">链接对应的文档不存在，或已被创建者删除。请向分享者确认最新链接。</p>
          <div className="modal-actions">
            <button className="btn-primary" onClick={back}>
              返回工作台
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 团队管理（管理员页面）
  if (adminView) {
    return (
      <TeamAdmin
        onClose={() => setAdminView(false)}
        onOpenTeam={(t) => {
          setAdminView(false)
          setTeamView(t)
        }}
      />
    )
  }

  // 团队空间（指定团队的文件视图）
  if (teamView) {
    return (
      <Workspace
        teamId={teamView.id}
        teamName={teamView.name}
        onExitTeam={() => setTeamView(null)}
        onManageTeam={() => {
          setTeamView(null)
          setAdminView(true)
        }}
        onOpenTeam={(t) => setTeamView(t)}
        onOpen={open}
      />
    )
  }

  return <Workspace onOpenTeam={(t) => setTeamView(t)} onOpen={open} />
}
