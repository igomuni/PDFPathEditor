import type { DocumentModel, ImageObject, Matrix, Page, ProjectManifest, SourceInfo } from './model'
import type { OcrEngineId } from './ocr'

export const IPC = {
  importPdf: 'project:import-pdf',
  addPdf: 'project:add-pdf',
  addPages: 'project:add-pages',
  deletePage: 'project:delete-page',
  openProject: 'project:open',
  openRecentProject: 'project:open-recent',
  listRecentProjects: 'project:list-recent',
  clearRecentProjects: 'project:clear-recent',
  /** 未保存の変更があるかを main に伝える(ウィンドウを閉じるときの確認用) */
  setDirty: 'project:set-dirty',
  /** 未保存の変更をどうするか尋ねる */
  confirmUnsaved: 'project:confirm-unsaved',
  /** main → renderer: 保存してからウィンドウを閉じる */
  saveBeforeClose: 'project:save-before-close',
  /** 保存が済んだのでウィンドウを閉じてよい */
  closeNow: 'project:close-now',
  /** main → renderer: メニューで最近使ったプロジェクトが選ばれた */
  recentProjectPicked: 'project:recent-picked',
  /** main → renderer: 最近使ったプロジェクトの一覧が変わった */
  recentProjectsChanged: 'project:recent-changed',
  saveDocument: 'project:save-document',
  exportDocument: 'project:export',
  exportReview: 'project:export-review',
  pickCorrections: 'project:pick-corrections',
  readAsset: 'project:read-asset',
  detectCandidates: 'project:detect-candidates',
  detectText: 'project:detect-text',
  listOcrEngines: 'ocr:list-engines',
  listFonts: 'fonts:list',
  readFont: 'fonts:read',
  menuCommand: 'menu:command'
} as const

export const DEFAULT_IMPORT_PAGE = 2
export const DEFAULT_IMPORT_PAGES = String(DEFAULT_IMPORT_PAGE)
export const DEFAULT_IMPORT_DPI = 300

export interface ImportOptions {
  /** 取り込むページ。「2」「1-3,5」の形(src/shared/project.ts の parsePageSpec) */
  pages: string
  dpi: number
}

export interface OpenedProject {
  projectDir: string
  document: DocumentModel
  /** 旧形式から読み替えた(まだ新しい構成では保存していない) */
  migrated: boolean
}

/** 保存する内容。目次と、変更のあったページだけを送る */
export interface SavePayload {
  manifest: ProjectManifest
  pages: Page[]
  /** 目次から消えたページ(ページのファイルを消す) */
  removedPageIds: string[]
}

/** 削除したページ。ファイルは削除済み。利用者がやめたときは null を返す */
export interface DeletedPage {
  pageId: string
  /** 元PDFも削除したときは、その id */
  removedSourceId: string | null
}

/** 開いているプロジェクトに追加したページ。目次とページのファイルは書き込み済み */
export interface AddedPages {
  source: SourceInfo
  sourceIsNew: boolean
  pages: Page[]
  /** すでに取り込み済みで飛ばしたページ番号 */
  skippedPageNumbers: number[]
}

/** 未保存の変更の扱い */
export type UnsavedChoice = 'save' | 'discard' | 'cancel'

export interface RecentProject {
  /** プロジェクトフォルダの絶対パス */
  dir: string
  /** 最後に開いた日時(ISO 8601) */
  openedAt: string
}

export type MenuCommand =
  | 'import-pdf'
  | 'add-pdf'
  | 'open-project'
  | 'save'
  | 'export'
  | 'export-review'
  | 'import-corrections'
  | 'undo'
  | 'redo'
  | 'detect-lines'
  | 'detect-text'
  | 'assign-field-codes'
  | 'confirm-selection'
  | 'confirm-all'
  | 'delete-selection'
  | 'select-all'
  | 'toggle-diff'
  | 'toggle-untagged'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-fit'
  | 'zoom-100'

export interface RasterizeRequest {
  pdfPath: string
  pageNumber: number
  dpi: number
  outPngPath: string
}

export interface RasterizeResult {
  pageCount: number
  /** ページの表示領域 [x0, y0, x1, y1](pt) */
  mediaBox: [number, number, number, number]
  pixelWidth: number
  pixelHeight: number
  encryptFilter: string | null
  permissions: number[] | null
}


/** 候補抽出の対象にする画像(背景ラスター) */
export type DetectTarget = Pick<ImageObject, 'asset' | 'transform' | 'pixelWidth' | 'pixelHeight'>

export interface VectorizeRequest {
  vectorizerId: string
  pngPath: string
  pixelWidth: number
  pixelHeight: number
  /** 画像オブジェクトの変換行列(単位正方形 → PDF座標) */
  imageTransform: Matrix
}

export type WorkerReply<T> = { ok: true; result: T } | { ok: false; error: string }

export interface OcrRequest {
  engineId: OcrEngineId
  pngPath: string
  pixelWidth: number
  pixelHeight: number
  imageTransform: Matrix
  /** 配置の推定に使うフォント */
  fontFile: string
  fontFamily: string
  fontWeight: number
  visionBinary: string
  tesseractLangPath: string
}

export interface ExportRequest {
  projectDir: string
  /** 出力先(プロジェクトの exports/<ページID>/) */
  outDir: string
  /** 出力するページだけを pages に入れたドキュメント */
  document: DocumentModel
  /** フォントを探すフォルダ(先のものを優先) */
  fontDirs: string[]
}
