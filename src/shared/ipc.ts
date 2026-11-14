import type { DocumentModel, ImageObject, Matrix } from './model'

export const IPC = {
  importPdf: 'project:import-pdf',
  openProject: 'project:open',
  saveDocument: 'project:save-document',
  readAsset: 'project:read-asset',
  detectCandidates: 'project:detect-candidates',
  menuCommand: 'menu:command'
} as const

export const DEFAULT_IMPORT_PAGE = 2
export const DEFAULT_IMPORT_DPI = 300

export interface ImportOptions {
  pageNumber: number
  dpi: number
}

export interface OpenedProject {
  projectDir: string
  document: DocumentModel
}

export type MenuCommand =
  | 'import-pdf'
  | 'open-project'
  | 'save'
  | 'undo'
  | 'redo'
  | 'detect-lines'
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
