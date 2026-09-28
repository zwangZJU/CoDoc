import { useEffect, useState } from 'react'
import { api, type AuthConfig } from '../store/api'
import { isValidName } from '../store/user'

/**
 * 登录页。
 *
 * 两种模式由后端配置决定（GET /api/auth/config）：
 *  - oidc：跳标准 OIDC 授权码流程（Casdoor / Authing / 飞书 / Okta 均可），按钮文案随配置变化
 *  - dev：本地一键登录，填个名字即可（未配置 IdP 时默认开放，方便本地开发）
 *
 * 登录态由后端下发的 HttpOnly Cookie 持有，前端不保存任何凭证。
 */
export function Login({
  docName,
  onLoggedIn,
}: {
  /** 从分享链接进来时，告诉他将要打开哪份文档 */
  docName?: string
  onLoggedIn: () => void
}) {
  const [cfg, setCfg] = useState<AuthConfig | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api
      .authConfig()
      .then(setCfg)
      .catch(() => setCfg({ mode: 'dev', devLogin: true, providerLabel: '企业账号', appOrigin: '' }))
  }, [])

  const failed =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('login') === 'failed'
  const failMsg =
    typeof location !== 'undefined'
      ? new URLSearchParams(location.search).get('msg') || ''
      : ''

  const ssoLogin = () => {
    const next = location.pathname + location.search
    location.href = '/api/auth/login?next=' + encodeURIComponent(next)
  }

  const devLogin = async () => {
    if (!isValidName(name)) return
    setBusy(true)
    setErr('')
    try {
      await api.devLogin(name.trim())
      onLoggedIn()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="guest-mask">
      <div className="guest-card">
        <div className="guest-badge">CoDoc 同写</div>
        <h2 className="guest-title">{docName ? `登录后打开《${docName}》` : '登录 CoDoc'}</h2>
        <p className="guest-sub">
          {docName
            ? '这份文档需要登录后访问。登录后你的编辑会标记成你，权限也跟着你的账号走。'
            : '登录后即可创建和协作文档。身份绑定账号，换设备、换浏览器都还是你。'}
        </p>

        {failed && (
          <p className="guest-err" role="alert">
            登录失败：{failMsg || '请重试'}
          </p>
        )}

        {!cfg ? (
          <p className="guest-sub">正在读取登录配置…</p>
        ) : cfg.mode === 'oidc' ? (
          <div className="modal-actions">
            <button className="btn-primary" onClick={ssoLogin}>
              使用{cfg.providerLabel}登录
            </button>
          </div>
        ) : (
          <>
            <label className="field-label" htmlFor="login-name">
              你的姓名
            </label>
            <input
              id="login-name"
              className="modal-input"
              placeholder="例如：张三 / Alice"
              maxLength={12}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && devLogin()}
              autoFocus
            />
            {err && <p className="guest-err">{err}</p>}
            <div className="modal-actions">
              <button className="btn-primary" disabled={!isValidName(name) || busy} onClick={devLogin}>
                {busy ? '登录中…' : '登录'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
