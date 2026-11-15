import { useMemo, useState } from 'react'
import type { DocumentModel } from '../../shared/model'
import { buildPageTree } from './pageTree'
import { store } from './store'

interface Props {
  document: DocumentModel
  savedDocument: DocumentModel | null
  currentPageId: string | null
  busy: boolean
  /** 取り込み済みのPDFから、ページ指定(「1-3,5」)でページを追加する */
  onAddPages(sourceId: string, pages: string): void
  onDeletePage(pageId: string, label: string): void
}

/** 「PDF → ページ」の一覧。ページの切り替え・追加・削除を行う */
export function PageTree({ document, savedDocument, currentPageId, busy, onAddPages, onDeletePage }: Props) {
  const tree = useMemo(() => buildPageTree(document, savedDocument), [document, savedDocument])
  // ページ指定を入力中のPDF
  const [adding, setAdding] = useState<{ sourceId: string; pages: string } | null>(null)

  const submit = (): void => {
    if (!adding || adding.pages.trim() === '') return
    onAddPages(adding.sourceId, adding.pages)
    setAdding(null)
  }

  return (
    <section className="page-tree">
      <h2>ページ</h2>
      <div className="tree">
        {tree.map(({ source, pages }) => (
          <div key={source.id} className="source" data-source-id={source.id}>
            <div className="source-row">
              <span className="content" title={`${source.originalFileName}\nsha256 ${source.sha256}`}>
                {source.originalFileName}
              </span>
              <span className="count">全 {source.pageCount} ページ</span>
              <button
                onClick={(e) => {
                  setAdding(adding?.sourceId === source.id ? null : { sourceId: source.id, pages: '' })
                  e.currentTarget.blur()
                }}
                disabled={busy}
                title="この PDF からページを追加する"
              >
                +
              </button>
            </div>
            {adding?.sourceId === source.id && (
              <div className="add-row">
                <input
                  type="text"
                  autoFocus
                  value={adding.pages}
                  placeholder="例: 3、1-3,5"
                  onChange={(e) => setAdding({ sourceId: source.id, pages: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit()
                    if (e.key === 'Escape') setAdding(null)
                  }}
                  spellCheck={false}
                />
                <button onClick={submit} disabled={busy || adding.pages.trim() === ''}>
                  追加
                </button>
              </div>
            )}
            {pages.map(({ page, candidates, confirmed, dirty }) => {
              const label = `${source.originalFileName} p.${page.sourcePageNumber}`
              return (
                <div
                  key={page.id}
                  className={page.id === currentPageId ? 'page-row current' : 'page-row'}
                  data-page-id={page.id}
                  onMouseDown={(e) => {
                    if (!(e.target as Element).closest('button')) store.setCurrentPage(page.id)
                  }}
                  title={`候補 ${candidates} 件 / 確定 ${confirmed} 件${dirty ? '(未保存)' : ''}`}
                >
                  <span className="dirty">{dirty ? '●' : ''}</span>
                  <span className="content">p.{page.sourcePageNumber}</span>
                  <span className="count">
                    候補 {candidates} / 確定 {confirmed}
                  </span>
                  <button onClick={() => onDeletePage(page.id, label)} disabled={busy || document.pages.length <= 1} title="このページを削除する">
                    ×
                  </button>
                </div>
              )
            })}
            {pages.length === 0 && <p className="hint">ページがありません。「+」で追加できます。</p>}
          </div>
        ))}
      </div>
    </section>
  )
}
