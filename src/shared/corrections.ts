// 修正ファイル(JSON)。アプリの外(AI など)で作り、取り込んで候補を一括で直す。
// 形式の説明は docs/corrections-format.md。座標はPDF座標(pt、左下原点)。
import type { ObjectRole, Rect, TextObject } from './model.ts'

export const CORRECTIONS_VERSION = 1

/** Text に設定できる属性。x, y はベースライン上の基準点 */
export interface TextSettings {
  text?: string
  fontFamily?: string
  fontWeight?: number
  fontSize?: number
  letterSpacing?: number
  x?: number
  y?: number
  align?: TextObject['align']
  fill?: string
  outline?: boolean
  role?: ObjectRole
  fieldCode?: string | null
  /**
   * 文字のインクが収まる枠 [x0, y0, x1, y1]。指定すると、フォントの字形に合わせて
   * サイズ・位置・字間をアプリが決める(fontSize, x, y, letterSpacing の指定より優先)。
   */
  fitBox?: Rect
}

export type CorrectionOperation =
  /** 既存の Text の属性を上書きする */
  | { op: 'replace'; id: string; set: TextSettings; reason?: string }
  /** Text を追加する。text と、fitBox または (x, y, fontSize) が必要 */
  | { op: 'add'; text: TextSettings; reason?: string }
  /** オブジェクトを削除する */
  | { op: 'delete'; id: string; reason?: string }

export interface CorrectionsFile {
  version: typeof CORRECTIONS_VERSION
  /** 対象ページ(元PDFでのページ番号)。省略すると最初のページ */
  page?: number
  note?: string
  operations: CorrectionOperation[]
}

/** main が読んだ修正ファイル。中身は未検証 */
export interface PickedCorrections {
  fileName: string
  data: unknown
}

/** 確認用データの書き出し結果 */
export interface ReviewExportResult {
  dir: string
  files: string[]
  textCount: number
  /** 取れていないインクのまとまりの数 */
  uncoveredCount: number
  /** 背景に合っていない Text の数 */
  misfitCount: number
}
