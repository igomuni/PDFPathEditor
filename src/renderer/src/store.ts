import { useSyncExternalStore } from 'react'
import type { OpenedProject } from '../../shared/ipc'
import type { DocumentModel } from '../../shared/model'
import { History, type Command } from './history.ts'

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
  /** 最後に保存した時点のドキュメント。document と参照が違えば未保存 */
  savedDocument: DocumentModel | null
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
    this.state = {
      ...this.state,
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
      savedDocument: project.document,
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

  undo(): void {
    if (this.state.document) this.setDocument(this.history.undo(this.state.document))
  }

  redo(): void {
    if (this.state.document) this.setDocument(this.history.redo(this.state.document))
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
