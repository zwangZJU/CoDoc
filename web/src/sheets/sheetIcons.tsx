/**
 * 表格工具条图标集
 * 统一 24×24 线性网格（stroke = currentColor，1.6px），风格对齐「同写 CoDoc」设计令牌：
 * 单色轴线稿、无装饰、克制。飞书工具栏的图标语义在此一一对应。
 */
import type { CSSProperties } from 'react'

export type IconName =
  // 菜单栏
  | 'undo'
  | 'redo'
  | 'painter'
  | 'clear-format'
  | 'insert'
  | 'more'
  | 'find'
  | 'comment'
  | 'menu'
  // 格式栏
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'font-color'
  | 'fill'
  | 'border'
  | 'merge'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'valign-top'
  | 'valign-middle'
  | 'valign-bottom'
  | 'wrap'
  | 'percent'
  | 'sum'
  | 'freeze'
  | 'sort'
  | 'rotate'
  | 'view-split'
  | 'filter'
  | 'cond-format'
  | 'dropdown-list'
  | 'table'
  | 'align-distributed'
  | 'indent-inc'
  | 'indent-dec'
  // 通用
  | 'chevron-down'
  | 'chevron-right'
  | 'close'
  | 'plus'
  | 'minus'
  | 'check'
  | 'send'
  | 'sparkle'
  | 'link'
  | 'copy'
  | 'clipboard'
  | 'trash'
  | 'sheet'
  | 'image'
  | 'clock'
  | 'eraser'
  | 'stop'
  | 'expand'
  | 'grid'
  | 'prompt'
  | 'brain'
  | 'wrench'
  | 'shield'
  | 'list'
  | 'stop2'
  | 'refresh'

/** 每个图标的 path 描述（可含多段子路径） */
const P: Record<IconName, string> = {
  undo: 'M4 9h11a5 5 0 0 1 0 10H9 M4 9l4-4 M4 9l4 4',
  redo: 'M20 9H9a5 5 0 0 0 0 10h6 M20 9l-4-4 M20 9l-4 4',
  painter: 'M4 3h9v4H4z M8.5 7v3 M6 10h5v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z',
  'clear-format': 'M7 17l8-8a2.1 2.1 0 0 1 3 3l-8 8H7z M20 20H4 M11 20h9',
  insert: 'M4 4h16v16H4z M12 8.5v7 M8.5 12h7',
  more: 'M6 12h.01 M12 12h.01 M18 12h.01',
  find: 'M10 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M14 14l3.5 3.5 M7.5 8.5h5 M7.5 11h3',
  comment: 'M4 5h16v10H10l-6 5V5z M8 9h8 M8 12h5',
  menu: 'M4 6h16 M4 12h16 M4 18h10',

  bold: 'M7 5h6a3.5 3.5 0 0 1 0 7H7z M7 12h7a3.5 3.5 0 0 1 0 7H7z',
  italic: 'M14.5 5h-4 M13.5 19h-4 M14 5l-3.5 14',
  underline: 'M7 5v6a5 5 0 0 0 10 0V5 M6 20h12',
  strike: 'M5 12h14 M16 7.5A4 3.4 0 0 0 12 5c-2.2 0-4 1-4 2.8 0 2.6 8 1.9 8 4.6 0 1.9-2 2.9-4 2.9-2.1 0-3.6-1-4-2.4',
  'font-color': 'M6.5 16.5l4.8-11.5 4.8 11.5 M8.6 12.4h5.4',
  fill: 'M6 13.2l5.8-5.8 6 6-5.9 5.9z M11.8 7.4V4.6 M19.4 13.6c.9 1.3 1.4 2.3 1.4 3.1a1.4 1.4 0 0 1-2.8 0c0-.8.5-1.8 1.4-3.1z',
  border: 'M4 4h16v16H4z M12 4v16 M4 12h16',
  merge: 'M4 4h16v16H4z M9 12h6 M12 9l3 3-3 3',
  'align-left': 'M4 6h16 M4 11h9 M4 16h13',
  'align-center': 'M4 6h16 M7.5 11h9 M5.5 16h13',
  'align-right': 'M4 6h16 M11 11h9 M7 16h13',
  'valign-top': 'M5 4h14 M7 8v11 M12 8v7 M17 8v13',
  'valign-middle': 'M5 12h14 M8 6v12 M13 7.5v9 M18 6.5v11',
  'valign-bottom': 'M5 20h14 M7 5v11 M12 9v7 M17 3v13',
  wrap: 'M4 6h16 M4 12h10a3 3 0 0 1 0 6h-3 M4 19h4 M13.5 15.5L11 18l2.5 2.5',
  percent: 'M8.5 6.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M15.5 13.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M6.5 17.5l11-11',
  sum: 'M17.5 5H7l5.5 7L7 19h10.5',
  freeze: 'M12 3v18 M4.6 7.6l14.8 8.8 M19.4 7.6L4.6 16.4',
  sort: 'M8 5v13 M5 15l3 3 3-3 M16 19V6 M13 8l3-3 3 3',
  rotate: 'M12 5v4h-4 M12 5a7 7 0 1 1-6.5 4.6 M12 9l-4-4',
  'view-split': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 3v18',
  filter: 'M4 5h16l-6 7v5.5l-4 2.5v-8z',
  'cond-format': 'M4 5h16v6H4z M4 13h16v6H4z M7 8h6 M7 16h10',
  'dropdown-list': 'M4 5h16v14H4z M12 5v14 M14.5 10.5l2 2 2-2',
  table: 'M4 5h16v14H4z M4 10h16 M4 15h16 M10 5v14',
  'align-distributed': 'M4 6h16 M4 11h16 M4 16h16',
  'indent-inc': 'M4 5v14 M20 5v14 M9 12h7 M13 9l3 3-3 3',
  'indent-dec': 'M4 5v14 M20 5v14 M15 12H8 M11 9l-3 3 3 3',

  'chevron-down': 'M6 9.5l6 6 6-6',
  'chevron-right': 'M9.5 6l6 6-6 6',
  close: 'M6 6l12 12 M18 6L6 18',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  check: 'M5 13l4.5 4.5L19 6.5',
  send: 'M4.5 11.2L19.5 4.5 13 19.5l-2.6-6.1z M10.4 13.4L19.5 4.5',
  sparkle: 'M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9z M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  link: 'M10.5 13.5a3.6 3.6 0 0 1 0-5l2-2a3.6 3.6 0 0 1 5 5l-1 1 M13.5 10.5a3.6 3.6 0 0 1 0 5l-2 2a3.6 3.6 0 0 1-5-5l1-1',
  copy: 'M9 9h10v11H9z M6 15V4h10',
  clipboard: 'M9 4h6v3H9z M6 6.5h12V20H6z',
  trash: 'M5 7h14 M9.5 7V4.5h5V7 M7.5 7l.8 13h7.4l.8-13',
  sheet: 'M4 4h16v16H4z M4 10h16 M10 4v16',
  image: 'M4 5h16v14H4z M9 11.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M5 17.5l5-5 4 4 2-2 3 3',
  clock: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M12 8.5V12h3',
  eraser: 'M8 18l-3-3 8-8 3 3-5 5 M13 18h7 M11 20H5l3-2',
  stop: 'M6 6h12v12H6z',
  refresh: 'M17.65 6.35A8 8 0 1 0 20 12h-2.5a5.5 5.5 0 1 1-1.6-3.9L12 11.5h8V3.5z',
  expand: 'M9 4H4v5 M15 20h5v-5 M4 4l6 6 M20 20l-6-6',
  grid: 'M9 3v18 M15 3v18 M3 9h18 M3 15h18',
    prompt: 'M4 5l7 7-7 7 M13 19h7',
    brain: 'M9.5 4A3.5 3.5 0 0 1 12 6a3.5 3.5 0 0 1 2.5-2A3.5 3.5 0 0 1 20 7.5c0 .86-.31 1.65-.8 2.25A3.5 3.5 0 0 1 21 12a3.5 3.5 0 0 1-2.9 3.45A3.5 3.5 0 0 1 12 19.5a3.5 3.5 0 0 1-6.1-1.05A3.5 3.5 0 0 1 3 12c0-.9.3-1.7.8-2.25A3.5 3.5 0 0 1 3 7.5 3.5 3.5 0 0 1 9.5 4z M12 8.5v7 M8.8 10.2v3.6 M15.2 10.2v3.6',
    wrench: 'M14.6 4.6a5 5 0 0 0-6.3 6.4L3.6 15.7a2 2 0 0 0 2.8 2.8l4.7-4.7a5 5 0 0 0 6.4-6.3l-2.5 2.5-1.8-.3-.3-1.8z M20 4l-1.3 1.3',
    shield: 'M12 3l7 3v6c0 4.5-2.8 7.5-7 9-4.2-1.5-7-4.5-7-9V6z M9 12l2 2 4-4',
    list: 'M8.5 5h11 M8.5 12h11 M8.5 19h11 M4.5 5h.01 M4.5 12h.01 M4.5 19h.01',
    stop2: 'M8 8h8v8H8z',
}

export function Ico({
  n,
  size = 16,
  className,
  style,
  strokeWidth = 1.6,
}: {
  n: IconName
  size?: number
  className?: string
  style?: CSSProperties
  strokeWidth?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path d={P[n]} />
    </svg>
  )
}

/** 「更多」的三点需要更粗的点，单独兜一层描边宽度 */
export const DOT_ICON_WIDTH = 2.6
