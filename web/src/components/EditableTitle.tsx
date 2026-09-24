import { useEffect, useRef, useState } from 'react'

interface Props {
  name: string
  disabled?: boolean
  onRename: (next: string) => Promise<void> | void
}

/**
 * 顶栏文件名：默认显示为标题，点击后变为输入框，
 * 回车 / 失焦保存，Esc 取消，空名自动回退为原名。
 */
export default function EditableTitle({ name, disabled, onRename }: Props) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  // 外部改名（分享链接进入等）时同步显示
  useEffect(() => setValue(name), [name])

  useEffect(() => {
    if (!editing) return
    const el = ref.current
    if (!el) return
    el.focus()
    // 光标移到末尾，方便直接追加
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  const start = () => {
    if (disabled) return
    setValue(name)
    setEditing(true)
  }

  const save = async () => {
    if (busy) return
    const next = value.trim()
    // 空名：不改，退回显示
    if (!next || next === name) {
      setValue(name)
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await onRename(next)
      setValue(next)
      setEditing(false)
    } catch {
      // 失败保留输入，让用户看到错误提示或重试
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={ref}
        className="doc-title-input"
        value={value}
        maxLength={120}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setValue(name)
            setEditing(false)
          }
        }}
        onBlur={save}
      />
    )
  }

  return (
    <span
      className="editable-title"
      title={name + '（点击重命名）'}
      onClick={start}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          start()
        }
      }}
    >
      {name || '未命名'}
    </span>
  )
}