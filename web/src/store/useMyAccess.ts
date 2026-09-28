import { useEffect, useRef, useState } from 'react'
import { api, type MyAccess } from './api'

/**
 * 轮询"我在这份文档上的权限"。
 *
 * 为什么必须轮询而不是只查一次：所有者可能在另一个客户端改了你的权限、
 * 收回了链接、或把你移除了——这些变化必须让你这边立刻感知。
 * 服务端会同时断开你的协同连接，这里负责让 UI 跟上（降级为只读 / 提示权限被收回）。
 */
export function useMyAccess(docId: string, intervalMs = 8000) {
  const [access, setAccess] = useState<MyAccess | null>(null)
  const prevLevel = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const a = await api.getMyAccess(docId)
        if (!alive) return
        setAccess((old) => {
          const key = a.level + '|' + a.status
          const changed = prevLevel.current !== null && prevLevel.current !== key
          prevLevel.current = key
          return changed ? { ...a } : a
        })
      } catch {
        /* 网络抖动忽略下一次再试 */
      }
    }
    tick()
    const t = window.setInterval(tick, intervalMs)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [docId, intervalMs])

  return access
}

/** 是否具备写权限（服务端权限为准；还没查到时不拦，避免闪烁） */
export function canEditWith(a: MyAccess | null): boolean {
  if (!a) return true
  return a.level === 'owner' || a.level === 'manage' || a.level === 'edit'
}

/** 是否被服务端强制只读 */
export function forcedReadOnly(a: MyAccess | null): boolean {
  return !!a && a.level === 'view'
}

/** 权限是否已被完全收回 */
export function accessRevoked(a: MyAccess | null): boolean {
  return !!a && a.level === 'none'
}
