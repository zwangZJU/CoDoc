import { useCallback, useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { getSession, patchSession, type LocalUser } from './user'

// 经 vite 代理：开发期同域 /collab 转发到后端 1234
const WS_BASE =
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/collab'

/**
 * 建立协同房间，并把登录身份（姓名/颜色）写进 awareness。
 *
 * 连接不再带任何手工凭证：登录态在会话 Cookie 里，WebSocket 同源握手会自动带上，
 * 后端据此裁决这条连接是「可写」「只读」还是直接拒绝——权限在服务端落地，不靠前端自觉。
 * 这也顺带修掉了「换浏览器/换入口就变成另一个人」的老问题。
 */
export function useCollab(docName: string) {
  const [user, setUser] = useState<LocalUser | null>(() => getSession())
  const ydoc = useMemo(() => new Y.Doc(), [docName])

  // 调试用：开发期把 ydoc / provider 挂到 window，方便控制台直查协同状态
  if (import.meta.env.DEV) {
    ;(window as any).__ydoc = ydoc
  }
  const provider = useMemo(
    () => new WebsocketProvider(WS_BASE, docName, ydoc, { connect: true }),
    [docName, ydoc]
  )
  if (import.meta.env.DEV) {
    ;(window as any).__provider = provider
  }

  // 身份变化（改名/换色）要立刻广播出去，别人看到的在线名单才会跟着变
  useEffect(() => {
    // dev 下 Fast Refresh 重跑 cleanup 会把连接断开，这里顺手拉起来
    if (import.meta.hot && !provider.wsconnected) provider.connect()
    if (!user) return
    provider.awareness.setLocalStateField('user', {
      id: user.id,
      name: user.name,
      colorIndex: user.colorIndex,
    })
  }, [provider, user])

  useEffect(() => {
    return () => {
      /**
       * dev 下 Vite Fast Refresh 会重跑本 cleanup：destroy 掉的 provider 不会
       * 重建（useMemo 缓存还在），之后所有输入都只留在本地 ydoc、刷新即丢。
       * 这是「输入内容丢失」的真正根因——开发期只 disconnect（会在上面的
       * awareness effect 里重连）；生产环境没有 HMR，保持 destroy 防泄漏。
       */
      if (import.meta.hot) provider.disconnect()
      else provider.destroy()
    }
  }, [provider])

  /** 改名/换色：只影响本地展示与在线名单，不改变权限归属 */
  const rename = useCallback((name: string, colorIndex?: number) => {
    setUser(
      patchSession({
        ...(name ? { name: name.trim() } : {}),
        ...(colorIndex !== undefined ? { colorIndex } : {}),
      })
    )
  }, [])

  return { ydoc, provider, user, rename }
}
