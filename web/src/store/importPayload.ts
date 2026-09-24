/**
 * 导入载荷：在工作台解析完成后交给对应编辑器写入 Yjs。
 * 这样"导入"是一次性初始化写入，而不是绕过协同直接改本地表。
 */
import type { ImportedSheet } from '../sheets/io'
import type { Block } from '../word/docx'

export type ImportPayload =
  | { target: 'sheet'; file: string; sheets: ImportedSheet[] }
  | { target: 'doc'; file: string; blocks: Block[] }
