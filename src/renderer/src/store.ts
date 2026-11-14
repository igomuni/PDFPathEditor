import { useSyncExternalStore } from 'react'
import type { OpenedProject } from '../../shared/ipc'
import type { DocumentModel } from '../../shared/model'
import { History, type Command } from './history'

export interface StoreState {
  projectDir: string | null
  document: DocumentModel | null
  /** 最後に保存した時点のドキュメント。document と参照が違えば未保存 */
  savedDocument: DocumentModel | null
  canUndo: boolean
  canRedo: boolean
}

class DocumentStore {
  private state: StoreState = {
    projectDir: null,
    document: null,
    savedDocument: null,
    canUndo: false,
    canRedo: false
  }
  private history = new History()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): StoreState => this.state

  private setDocument(document: DocumentModel): void {
    this.state = {
      ...this.state,
      document,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo
    }
    this.listeners.forEach((listener) => listener())
  }

  open(project: OpenedProject): void {
    this.history = new History()
    this.state = { ...this.state, projectDir: project.projectDir, savedDocument: project.document }
    this.setDocument(project.document)
  }

  execute(command: Command): void {
    if (this.state.document) this.setDocument(this.history.execute(this.state.document, command))
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
    this.listeners.forEach((listener) => listener())
  }
}

export const store = new DocumentStore()

export function useStore(): StoreState {
  return useSyncExternalStore(store.subscribe, store.getState)
}
