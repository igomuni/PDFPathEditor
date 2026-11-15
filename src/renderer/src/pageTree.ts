// ページ一覧(左サイドバー上段)の中身。「PDF → ページ」のツリーにする。
import type { DocumentModel, Page, SourceInfo } from '../../shared/model.ts'

export interface PageEntry {
  page: Page
  candidates: number
  confirmed: number
  /** 最後の保存から変わっている */
  dirty: boolean
}

export interface SourceEntry {
  source: SourceInfo
  /** ページ番号の順 */
  pages: PageEntry[]
}

const countOf = (page: Page, kind: 'candidates' | 'confirmed'): number =>
  page.layers.filter((layer) => layer.kind === kind).reduce((sum, layer) => sum + layer.objects.length, 0)

/** 取り込んだ順のPDFごとに、ページをページ番号の順に並べる。ページのないPDFも出す */
export function buildPageTree(document: DocumentModel, saved: DocumentModel | null): SourceEntry[] {
  const savedPages = new Map((saved?.pages ?? []).map((page) => [page.id, page]))
  return document.sources.map((source) => ({
    source,
    pages: document.pages
      .filter((page) => page.sourceId === source.id)
      .sort((a, b) => a.sourcePageNumber - b.sourcePageNumber)
      .map((page) => ({
        page,
        candidates: countOf(page, 'candidates'),
        confirmed: countOf(page, 'confirmed'),
        dirty: savedPages.get(page.id) !== page
      }))
  }))
}

/** ページを消したあとのドキュメント。removeSource が true なら、どのページも使っていない元PDFも一覧から外す */
export function withoutPage(document: DocumentModel, pageId: string, removedSourceId: string | null): DocumentModel {
  const pages = document.pages.filter((page) => page.id !== pageId)
  return {
    ...document,
    pages,
    sources: document.sources.filter((source) => source.id !== removedSourceId || pages.some((page) => page.sourceId === source.id))
  }
}
