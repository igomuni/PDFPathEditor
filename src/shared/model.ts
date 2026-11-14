// ドキュメントモデル(document.json)。唯一の正。座標はすべてPDF座標(pt、左下原点)。

export const DOCUMENT_VERSION = 1

/** PDFの変換行列 [a b c d e f]。x' = a·x + c·y + e, y' = b·x + d·y + f */
export type Matrix = [number, number, number, number, number, number]

/** [x0, y0, x1, y1](pt、左下原点) */
export type Rect = [number, number, number, number]

export type LayerKind = 'background' | 'candidates' | 'confirmed' | 'diff'

export type ObjectRole =
  | 'background'
  | 'frame'
  | 'label'
  | 'inputCell'
  | 'qr'
  | 'formId'
  | 'other'

interface ObjectBase {
  /** 安定ID。生成後は変えない */
  id: string
  role: ObjectRole
  /** 項目コード(G01 等)。未付与は null */
  fieldCode: string | null
  transform: Matrix
  /** レイヤー内のZ順(大きいほど手前) */
  z: number
  tags: string[]
  meta: Record<string, unknown>
}

/** 単位正方形 [0,1]×[0,1] に画像を置き、transform でページ上に配置する(PDFの画像XObjectと同じ規約) */
export interface ImageObject extends ObjectBase {
  type: 'image'
  /** プロジェクトフォルダからの相対パス(assets/...) */
  asset: string
  pixelWidth: number
  pixelHeight: number
}

// Path / Text は後続マイルストーンで追加する
export type DocObject = ImageObject

export interface Layer {
  id: string
  kind: LayerKind
  name: string
  locked: boolean
  visible: boolean
  opacity: number
  objects: DocObject[]
}

export interface Page {
  id: string
  /** 元PDFでのページ番号(1始まり) */
  sourcePageNumber: number
  mediaBox: Rect
  layers: Layer[]
}

export interface SourceInfo {
  /** プロジェクトフォルダからの相対パス(source/...) */
  file: string
  originalFileName: string
  sha256: string
  byteLength: number
  pageCount: number
  encrypted: boolean
  encryptFilter: string | null
  /** PDFの権限フラグ(pdf.js の PermissionFlag 値)。制限なしは null */
  permissions: number[] | null
}

export interface DocumentModel {
  version: typeof DOCUMENT_VERSION
  createdAt: string
  source: SourceInfo
  pages: Page[]
}
