import { useEffect, useMemo, useState } from 'react'
import { api, type Team } from '../store/api'
import { colorOf } from '../store/user'

/**
 * 团队管理（管理员页面）：左侧团队列表 + 新建，右侧团队详情
 * —— 改名 / 描述、删除团队、添加成员、切换角色、移除成员。
 * 数据落盘（后端 data/teams.json），重启不丢。
 */
export default function TeamAdmin({
  onClose,
  onOpenTeam,
}: {
  onClose: () => void
  onOpenTeam: (t: { id: string; name: string }) => void
}) {
  const [teams, setTeams] = useState<Team[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [selId, setSelId] = useState<string | null>(null)

  // 新建团队
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')

  // 编辑团队
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')

  // 添加成员
  const [memName, setMemName] = useState('')
  const [memRole, setMemRole] = useState<'admin' | 'member'>('member')

  const flash = (m: string) => {
    setNotice(m)
    window.setTimeout(() => setNotice((n) => (n === m ? null : n)), 2600)
  }
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

  const load = () =>
    api
      .listTeams()
      .then((r) => {
        setTeams(r.teams)
        setSelId((cur) =>
          cur && r.teams.some((t) => t.id === cur) ? cur : r.teams[0]?.id ?? null
        )
      })
      .catch(() => setTeams([]))

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = useMemo(() => teams.find((t) => t.id === selId) || null, [teams, selId])

  // 切换选中团队时同步编辑表单
  useEffect(() => {
    if (selected) {
      setEditName(selected.name)
      setEditDesc(selected.desc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  const createTeam = async () => {
    const name = newName.trim()
    if (!name) {
      flash('请填写团队名称')
      return
    }
    setBusy(true)
    try {
      const r = await api.createTeam(name, newDesc.trim())
      setNewName('')
      setNewDesc('')
      await load()
      setSelId(r.id)
      flash('已创建团队「' + name + '」')
    } catch (e) {
      flash('创建失败：' + errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const saveTeam = async () => {
    if (!selected) return
    const name = editName.trim()
    if (!name) {
      flash('团队名称不能为空')
      return
    }
    try {
      await api.updateTeam(selected.id, { name, desc: editDesc })
      await load()
      flash('已保存')
    } catch (e) {
      flash('保存失败：' + errMsg(e))
    }
  }

  const delTeam = async () => {
    if (!selected) return
    if (
      !window.confirm(
        `删除团队「${selected.name}」？团队下的文件会退回个人空间（不会删除），此操作不可恢复。`
      )
    )
      return
    try {
      await api.deleteTeam(selected.id)
      await load()
      flash('已删除团队')
    } catch (e) {
      flash('删除失败：' + errMsg(e))
    }
  }

  const addMember = async () => {
    if (!selected) return
    const name = memName.trim()
    if (!name) {
      flash('请填写成员姓名')
      return
    }
    setBusy(true)
    try {
      const r = await api.addTeamMember(selected.id, name, memRole)
      setMemName('')
      await load()
      flash(r.existed ? `${name} 已在团队中` : `已添加 ${name}`)
    } catch (e) {
      flash('添加失败：' + errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const setRole = async (mid: string, role: 'admin' | 'member') => {
    if (!selected) return
    try {
      await api.updateTeamMember(selected.id, mid, role)
      await load()
    } catch (e) {
      flash('修改失败：' + errMsg(e))
    }
  }

  const removeMember = async (mid: string) => {
    if (!selected) return
    try {
      await api.removeTeamMember(selected.id, mid)
      await load()
      flash('已移除成员')
    } catch (e) {
      flash('移除失败：' + errMsg(e))
    }
  }

  return (
    <div className="team-admin">
      <header className="ta-topbar">
        <div className="topbar-left">
          <button className="btn-ghost" onClick={onClose} title="返回工作台">
            ← 返回
          </button>
          <span className="brand">团队管理</span>
        </div>
        <span className="avatar" style={{ background: colorOf(0).c }} title="我">
          我
        </span>
      </header>

      <div className="ta-body">
        {/* 左：团队列表 + 新建 */}
        <aside className="ta-left">
          <div className="ta-left-head">
            <h4>团队</h4>
            <span className="ta-count">{teams.length}</span>
          </div>
          <div className="ta-new">
            <input
              className="modal-input"
              placeholder="团队名称"
              value={newName}
              maxLength={20}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createTeam()}
            />
            <input
              className="modal-input"
              placeholder="描述（可选）"
              value={newDesc}
              maxLength={120}
              onChange={(e) => setNewDesc(e.target.value)}
            />
            <button className="btn-primary" disabled={busy} onClick={createTeam}>
              + 新建团队
            </button>
          </div>
          <div className="ta-list">
            {teams.length === 0 ? (
              <div className="sidebar-empty">还没有团队，在上面创建第一个</div>
            ) : (
              teams.map((t) => (
                <button
                  key={t.id}
                  className={'ta-item' + (t.id === selId ? ' active' : '')}
                  onClick={() => setSelId(t.id)}
                >
                  <span className="ta-item-name">{t.name}</span>
                  <span className="ta-item-sub">
                    {(t.memberCount || 0)} 名成员 · {(t.fileCount || 0)} 个文件
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* 右：团队详情 */}
        <main className="ta-right">
          {!selected ? (
            <div className="empty">
              <div className="empty-icon">○</div>
              <p className="empty__text">选择左侧团队进行编辑，或新建一个团队。</p>
            </div>
          ) : (
            <div className="ta-detail">
              <div className="ta-detail-head">
                <h2>{selected.name}</h2>
                <button className="btn-ghost danger-text" onClick={delTeam}>
                  删除团队
                </button>
              </div>

              <label className="field-label">团队名称</label>
              <input
                className="modal-input"
                value={editName}
                maxLength={20}
                onChange={(e) => setEditName(e.target.value)}
              />
              <label className="field-label">团队描述</label>
              <textarea
                className="modal-input ta-desc"
                value={editDesc}
                rows={2}
                maxLength={120}
                onChange={(e) => setEditDesc(e.target.value)}
              />
              <div className="modal-actions">
                <button className="btn-primary" onClick={saveTeam}>
                  保存
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => onOpenTeam({ id: selected.id, name: selected.name })}
                >
                  进入团队空间
                </button>
              </div>

              <div className="ta-divider" />

              <label className="field-label">添加成员</label>
              <div className="ta-add-mem">
                <input
                  className="modal-input"
                  placeholder="成员姓名"
                  value={memName}
                  maxLength={12}
                  onChange={(e) => setMemName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addMember()}
                />
                <select
                  className="tselect"
                  value={memRole}
                  onChange={(e) => setMemRole(e.target.value as 'admin' | 'member')}
                >
                  <option value="member">成员</option>
                  <option value="admin">管理员</option>
                </select>
                <button className="btn-primary" disabled={busy} onClick={addMember}>
                  添加
                </button>
              </div>

              <label className="field-label">成员 · {selected.members.length}</label>
              <div className="ta-members">
                {selected.members.map((m, i) => {
                  const c = colorOf(i)
                  return (
                    <div className="member-row" key={m.id}>
                      <span className="avatar" style={{ background: c.c }}>
                        {m.name.slice(0, 1)}
                      </span>
                      <span className="member-meta">
                        <span className="member-name">
                          {m.name}
                          {m.id === 'owner' && (
                            <span className="member-self-tag">创建者</span>
                          )}
                        </span>
                        <span className="member-sub">
                          {m.role === 'admin' ? '管理员' : '成员'}
                        </span>
                      </span>
                      {m.id === 'owner' ? (
                        <span className="member-sub">不可移除</span>
                      ) : (
                        <span className="member-perm">
                          <button
                            className={m.role === 'member' ? 'on' : ''}
                            onClick={() => setRole(m.id, 'member')}
                            title="设为成员"
                          >
                            成员
                          </button>
                          <button
                            className={m.role === 'admin' ? 'on' : ''}
                            onClick={() => setRole(m.id, 'admin')}
                            title="设为管理员"
                          >
                            管理员
                          </button>
                          <button
                            className="member-remove"
                            title="移除成员"
                            onClick={() => removeMember(m.id)}
                          >
                            ×
                          </button>
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="hint">
                演示环境未接账号系统，成员以姓名标识，重名会自动合并。数据落盘保存，重启不丢。
              </p>
            </div>
          )}
        </main>
      </div>

      {notice && <div className="notice">{notice}</div>}
    </div>
  )
}
