// ドキュメントモデル(document.json)。唯一の正。座標はすべてPDF座標(pt、左下原点)。

/** プロジェクトの形式。2: 複数PDF・複数ページ、目次 + ページごとのファイル(design.md §3-37) */
export const DOCUMENT_VERSION = 2

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
  /**
   * 画面に表示するか。省略は表示。非表示のオブジェクトは画面に出ず選択もできないが、
   * 出力(PDF / SVG / JSON)には影響しない(design.md §3-38)
   */
  visible?: boolean
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
  /**
   * 組む向き。省略は横書き。縦書きでは、原点が1字目の仮想ボディの上辺の中央になり、
   * 1字ずつ正立で下へ積む(src/shared/vertical.ts)。align は left = 上端、center = 中央、right = 下端が原点
   */
  writingMode?: 'horizontal' | 'vertical'
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
  /** 取り込み元のPDF(DocumentModel.sources の id) */
  sourceId: string
  /** 元PDFでのページ番号(1始まり) */
  sourcePageNumber: number
  mediaBox: Rect
  layers: Layer[]
}

export interface SourceInfo {
  id: string
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

/**
 * プロジェクト全体(画面とIPCで扱う形)。保存するときは、目次(ProjectManifest)と
 * ページごとのファイル(PageFile)に分ける。
 */
export interface DocumentModel {
  version: typeof DOCUMENT_VERSION
  createdAt: string
  /** 取り込んだPDF */
  sources: SourceInfo[]
  /** 対象ページ。PDFを取り込むと、対象ページごとに処理層(背景・候補・確定)ができる */
  pages: Page[]
}

/** 目次(document.json)でのページ。レイヤーとオブジェクトは file に持つ */
export interface PageRef {
  id: string
  sourceId: string
  sourcePageNumber: number
  mediaBox: Rect
  /** プロジェクトフォルダからの相対パス(pages/<ページID>.json) */
  file: string
}

/** document.json(目次) */
export interface ProjectManifest {
  version: typeof DOCUMENT_VERSION
  createdAt: string
  sources: SourceInfo[]
  pages: PageRef[]
}

/** pages/<ページID>.json */
export interface PageFile extends Page {
  version: typeof DOCUMENT_VERSION
}
