// 出力(PDF / SVG / JSON)と、背景との自動差分検証の結果

/** 出力PDFをラスタライズして背景ラスターと比べた結果。インクは二値化して数える */
export interface DiffMetrics {
  dpi: number
  /** ずれを許す画素数。この範囲に相手のインクがあれば一致とみなす */
  tolerancePx: number
  /** 背景のインクの画素数 */
  backgroundInk: number
  /** 出力のインクの画素数 */
  outputInk: number
  /** 再現率: 背景のインクのうち、出力に対応するインクがある割合(0〜1) */
  recall: number
  /** 過剰率: 出力のインクのうち、背景に対応するインクがない割合(0〜1) */
  excess: number
  /** 不一致画素率: 対応のないインク(欠落 + 過剰)がページ全体の画素に占める割合(0〜1) */
  mismatch: number
}

export interface ExportPageResult {
  /** 元PDFでのページ番号 */
  pageNumber: number
  /** 出力したオブジェクトの数 */
  objectCount: number
  /** 背景ラスターがないページは null */
  metrics: DiffMetrics | null
}

export interface ExportResult {
  /** 出力先フォルダ(プロジェクトの exports/) */
  dir: string
  /** 作ったファイル名 */
  files: string[]
  pages: ExportPageResult[]
}
