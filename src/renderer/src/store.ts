import { useSyncExternalStore } from 'react'
import type { AddedPages, DeletedPage, OpenedProject } from '../../shared/ipc'
import type { DocumentModel, Page } from '../../shared/model'
import { History, type Command } from './history.ts'
import { withoutPage } from './pageTree.ts'

export interface Selection {
  /** 選択中のオブジェクトID */
  ids: readonly string[]
  /** 選択中の頂点(1つまで)。なければ null */
  node: { objectId: string; index: number } | null
}

const EMPTY_SELECTION: Selection = { ids: [], node: null }

export interface StoreState {
  projectDir: string | null
  document: DocumentModel | null
  /** 最後に保存した時点のドキュメント。document と参照が違えば未保存。旧形式から読み替えた直後は null */
  savedDocument: DocumentModel | null
  /** 表示・編集しているページ */
  currentPageId: string | null
  canUndo: boolean
  canRedo: boolean
  /** 選択と表示モードは画面の状態で、ドキュメントには保存しない(Undo の対象外) */
  selection: Selection
  diffMode: boolean
  /** 項目コードが付いていないテキスト・記入欄を強調する */
  untaggedMode: boolean
}

class DocumentStore {
  private state: StoreState = {
    projectDir: null,
    document: null,
    savedDocument: null,
    currentPageId: null,
    canUndo: false,
    canRedo: false,
    selection: EMPTY_SELECTION,
    diffMode: false,
    untaggedMode: false
  }
  private history = new History()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): StoreState => this.state

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }

  private setDocument(document: DocumentModel): void {
    // Undo などで消えたオブジェクトは選択から外す
    const existing = new Set<string>()
    for (const page of document.pages) {
      for (const layer of page.layers) for (const object of layer.objects) existing.add(object.id)
    }
    const { selection } = this.state
    const ids = selection.ids.filter((id) => existing.has(id))
    const node = selection.node && existing.has(selection.node.objectId) ? selection.node : null
    // 今のページがなくなっていたら、先頭のページにする
    const currentPageId = document.pages.some((page) => page.id === this.state.currentPageId)
      ? this.state.currentPageId
      : (document.pages[0]?.id ?? null)
    this.state = {
      ...this.state,
      currentPageId,
      selection: ids.length === selection.ids.length && node === selection.node ? selection : { ids, node },
      document,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo
    }
    this.emit()
  }

  open(project: OpenedProject): void {
    this.history = new History()
    this.state = {
      ...this.state,
      projectDir: project.projectDir,
      // 旧形式から読み替えたものは、新しい構成でまだ保存していないので未保存として扱う
      savedDocument: project.migrated ? null : project.document,
      currentPageId: project.document.pages[0]?.id ?? null,
      selection: EMPTY_SELECTION
    }
    this.setDocument(project.document)
  }

  /** コマンドを実行して履歴に積む。null(変更なし)は無視する */
  execute(command: Command | null): void {
    if (command && this.state.document) this.setDocument(this.history.execute(this.state.document, command))
  }

  select(ids: readonly string[], node: Selection['node'] = null): void {
    this.state = { ...this.state, selection: { ids, node } }
    this.emit()
  }

  setDiffMode(diffMode: boolean): void {
    this.state = { ...this.state, diffMode }
    this.emit()
  }

  setUntaggedMode(untaggedMode: boolean): void {
    this.state = { ...this.state, untaggedMode }
    this.emit()
  }

  sealHistory(): void {
    this.history.seal()
  }

  /** 今のページ */
  currentPage(): Page | null {
    const { document, currentPageId } = this.state
    return document?.pages.find((page) => page.id === currentPageId) ?? document?.pages[0] ?? null
  }

  setCurrentPage(pageId: string): void {
    if (pageId === this.state.currentPageId || !this.state.document?.pages.some((page) => page.id === pageId)) return
    this.history.seal()
    this.state = { ...this.state, currentPageId: pageId, selection: EMPTY_SELECTION }
    this.emit()
  }

  /**
   * 取り込みで増えたページを足す。ファイルは main が書き込み済みなので、保存済みの状態にも同じものを足す
   * (履歴には積まない)。追加した最初のページへ切り替える。
   */
  appendPages(added: AddedPages): void {
    const merge = (document: DocumentModel): DocumentModel => ({
      ...document,
      sources: added.sourceIsNew
        ? [...document.sources, added.source]
        : document.sources.map((source) => (source.id === added.source.id ? added.source : source)),
      pages: [...document.pages, ...added.pages]
    })
    const { document, savedDocument } = this.state
    if (!document) return
    const next = merge(document)
    this.state = {
      ...this.state,
      savedDocument: savedDocument === document ? next : savedDocument && merge(savedDocument),
      currentPageId: added.pages[0]?.id ?? this.state.currentPageId,
      selection: EMPTY_SELECTION
    }
    this.setDocument(next)
  }

  /**
   * 削除したページを外す。ファイルは main が削除済みなので、保存済みの状態からも外す。
   * 削除は元に戻せないので、履歴は捨てる(消えたページへの操作を Undo しても意味がないため)。
   */
  removePage(deleted: DeletedPage): void {
    const { document, savedDocument } = this.state
    if (!document) return
    const next = withoutPage(document, deleted.pageId, deleted.removedSourceId)
    this.history = new History()
    this.state = {
      ...this.state,
      savedDocument: savedDocument === document ? next : savedDocument && withoutPage(savedDocument, deleted.pageId, deleted.removedSourceId),
      selection: EMPTY_SELECTION
    }
    this.setDocument(next)
  }

  /** Undo / Redo で別のページだけが変わったら、そのページへ切り替える(変化が見えるように) */
  private followChange(before: DocumentModel, after: DocumentModel): void {
    const previous = new Map(before.pages.map((page) => [page.id, page]))
    const changed = after.pages.filter((page) => previous.get(page.id) !== page)
    if (changed.length > 0 && !changed.some((page) => page.id === this.state.currentPageId)) {
      this.state = { ...this.state, currentPageId: changed[0].id, selection: EMPTY_SELECTION }
    }
  }

  undo(): void {
    const before = this.state.document
    if (!before) return
    const after = this.history.undo(before)
    this.followChange(before, after)
    this.setDocument(after)
  }

  redo(): void {
    const before = this.state.document
    if (!before) return
    const after = this.history.redo(before)
    this.followChange(before, after)
    this.setDocument(after)
  }

  markSaved(document: DocumentModel): void {
    this.state = { ...this.state, savedDocument: document }
    this.emit()
  }
}

export const store = new DocumentStore()

export function useStore(): StoreState {
  return useSyncExternalStore(store.subscribe, store.getState)
}
