// プロジェクトの形式(目次 + ページごとのファイル)と、旧形式からの読み替え。ファイルI/Oは含めない。
import { DOCUMENT_VERSION, type DocumentModel, type Layer, type Page, type PageFile, type ProjectManifest, type SourceInfo } from './model.ts'

/** ファイル名に使うID。フォルダの外を指せない文字だけを許す */
export const isSafeId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(id)

/** ページのファイル(プロジェクトフォルダからの相対パス) */
export function pageFileName(pageId: string): string {
  if (!isSafeId(pageId)) throw new Error(`ページIDが正しくありません: ${String(pageId)}`)
  return `pages/${pageId}.json`
}

/** 読みやすいページID。例: page-0002-3f9a1c2e */
export const newPageId = (pageNumber: number, random: string): string => `page-${String(pageNumber).padStart(4, '0')}-${random}`
export const newSourceId = (random: string): string => `src-${random}`

export function sourceOf(document: Pick<DocumentModel, 'sources'>, page: Pick<Page, 'sourceId'>): SourceInfo | null {
  return document.sources.find((source) => source.id === page.sourceId) ?? null
}

/** version 1 の document.json(1つのPDF、ページは pages に全部入り)*/
interface DocumentV1 {
  version: 1
  createdAt: string
  source: Omit<SourceInfo, 'id'>
  pages: Omit<Page, 'sourceId'>[]
}

const MIGRATED_SOURCE_ID = 'src-1'

/**
 * version 1 を今の形に読み替える。ファイルの場所(source/…、assets/…)はデータに書いてあるパスのまま使う。
 * 使っていなかった「差分オーバーレイ」レイヤーは落とす。
 */
export function migrateV1(raw: DocumentV1): DocumentModel {
  return {
    version: DOCUMENT_VERSION,
    createdAt: raw.createdAt,
    sources: [{ id: MIGRATED_SOURCE_ID, ...raw.source }],
    pages: raw.pages.map((page) => ({
      id: page.id,
      sourceId: MIGRATED_SOURCE_ID,
      sourcePageNumber: page.sourcePageNumber,
      mediaBox: page.mediaBox,
      layers: page.layers.filter((layer: Layer) => layer.kind !== 'diff')
    }))
  }
}

export function toManifest(document: DocumentModel): ProjectManifest {
  return {
    version: DOCUMENT_VERSION,
    createdAt: document.createdAt,
    sources: document.sources,
    pages: document.pages.map((page) => ({
      id: page.id,
      sourceId: page.sourceId,
      sourcePageNumber: page.sourcePageNumber,
      mediaBox: page.mediaBox,
      file: pageFileName(page.id)
    }))
  }
}

export function toPageFile(page: Page): PageFile {
  return { version: DOCUMENT_VERSION, ...page }
}

/** ページのファイルの中身を Page にする。目次と食い違っていれば例外 */
export function fromPageFile(raw: unknown, expected: { id: string; sourceId: string }): Page {
  const file = raw as Partial<PageFile> | null
  if (!file || file.version !== DOCUMENT_VERSION || !Array.isArray(file.layers)) {
    throw new Error(`ページのファイルの形式が正しくありません: ${expected.id}`)
  }
  if (file.id !== expected.id || file.sourceId !== expected.sourceId) {
    throw new Error(`ページのファイルが目次と一致しません: ${expected.id}`)
  }
  const { version: _version, ...page } = file as PageFile
  return page
}

/**
 * 保存するページ(最後に保存した時点から変わったもの)と、消すページ。
 * ドキュメントは不変データなので、ページの参照が同じなら変わっていない。
 */
export function diffPages(saved: DocumentModel | null, current: DocumentModel): { changed: Page[]; removedIds: string[] } {
  const before = new Map((saved?.pages ?? []).map((page) => [page.id, page]))
  const currentIds = new Set(current.pages.map((page) => page.id))
  return {
    changed: current.pages.filter((page) => before.get(page.id) !== page),
    removedIds: [...before.keys()].filter((id) => !currentIds.has(id))
  }
}

const MAX_PAGES_PER_IMPORT = 200

/**
 * ページ指定「2」「1-3,5」を、昇順で重複のないページ番号の配列にする。
 * pageCount を渡すと、範囲外のページをエラーにする。
 */
export function parsePageSpec(spec: string, pageCount?: number): number[] {
  const pages = new Set<number>()
  // 「2 - 3」のように、範囲の記号の前後に空白があってもよい
  const parts = spec
    .replace(/\s*([-‐–〜~])\s*/g, '$1')
    .split(/[,、\s]+/)
    .filter((part) => part !== '')
  if (parts.length === 0) throw new Error('ページを指定してください(例: 2、1-3,5)')
  for (const part of parts) {
    const match = /^(\d+)(?:\s*[-‐–〜~]\s*(\d+))?$/.exec(part)
    if (!match) throw new Error(`ページの指定が正しくありません: ${part}`)
    const from = Number(match[1])
    const to = match[2] === undefined ? from : Number(match[2])
    if (from < 1 || to < from) throw new Error(`ページの指定が正しくありません: ${part}`)
    if (pageCount !== undefined && to > pageCount) throw new Error(`ページ ${to} は範囲外です(全 ${pageCount} ページ)`)
    if (to - from >= MAX_PAGES_PER_IMPORT) throw new Error(`一度に取り込めるのは ${MAX_PAGES_PER_IMPORT} ページまでです`)
    for (let page = from; page <= to; page++) pages.add(page)
  }
  if (pages.size > MAX_PAGES_PER_IMPORT) throw new Error(`一度に取り込めるのは ${MAX_PAGES_PER_IMPORT} ページまでです`)
  return [...pages].sort((a, b) => a - b)
}
