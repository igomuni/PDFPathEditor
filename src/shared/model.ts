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
  /** 印字された項目コード(G01 等)そのもの */
  | 'fieldCode'
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

export interface PathNode {
  x: number
  y: number
  /** ベジェの制御点(絶対座標)。直線の頂点では省略する */
  in?: [number, number]
  out?: [number, number]
}

/** 罫線は「2頂点の開いたPath + 線幅」で持つ(中心線表現) */
export interface PathObject extends ObjectBase {
  type: 'path'
  nodes: PathNode[]
  closed: boolean
  /** CSS/PDF 共通で扱える #rrggbb。なしは null */
  fill: string | null
  stroke: string | null
  /** 線幅(pt) */
  strokeWidth: number
  /** 破線パターン(pt)。[線, 隙間, ...]。最初の頂点から始まる。実線は null */
  dash: number[] | null
  lineCap: 'butt' | 'round' | 'square'
}

/**
 * 実フォントのテキスト。ローカル座標の原点がベースライン上の基準点で、transform でページに置く。
 * align が left なら原点は行の左端、center なら中央、right なら右端。
 */
export interface TextObject extends ObjectBase {
  type: 'text'
  text: string
  /** フォントは family と weight で指す(src/shared/fonts.ts) */
  fontFamily: string
  fontWeight: number
  /** pt */
  fontSize: number
  /** 字間。各文字の送りに足す量(pt) */
  letterSpacing: number
  fill: string
  align: 'left' | 'center' | 'right'
  /** 出力時に文字を輪郭Pathとして描く(見た目の再現用)。false なら実フォントのTextとして出力する */
  outline: boolean
}

export type DocObject = ImageObject | PathObject | TextObject

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
