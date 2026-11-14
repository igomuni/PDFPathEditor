// Undo/Redo(コマンドパターン)。ドキュメントは不変データとして扱い、コマンドは新しいドキュメントを返す。
import type { DocumentModel } from '../../shared/model'

export interface Command {
  label: string
  /**
   * 同じ mergeKey のコマンドが続いたら1つの履歴にまとめる(スライダーのドラッグ等)。
   * 同じ対象へ値を絶対指定するコマンドにだけ付けること。
   */
  mergeKey?: string
  apply(document: DocumentModel): DocumentModel
  revert(document: DocumentModel): DocumentModel
}

export class History {
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  private sealed = true

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  execute(document: DocumentModel, command: Command): DocumentModel {
    const next = command.apply(document)
    const top = this.undoStack.at(-1)
    if (!this.sealed && top && command.mergeKey !== undefined && top.mergeKey === command.mergeKey) {
      this.undoStack[this.undoStack.length - 1] = { ...command, revert: top.revert }
    } else {
      this.undoStack.push(command)
    }
    this.redoStack = []
    this.sealed = false
    return next
  }

  /** 以降のコマンドを直前の履歴にまとめないようにする(ドラッグ終了時など) */
  seal(): void {
    this.sealed = true
  }

  undo(document: DocumentModel): DocumentModel {
    const command = this.undoStack.pop()
    if (!command) return document
    this.redoStack.push(command)
    this.sealed = true
    return command.revert(document)
  }

  redo(document: DocumentModel): DocumentModel {
    const command = this.redoStack.pop()
    if (!command) return document
    this.undoStack.push(command)
    this.sealed = true
    return command.apply(document)
  }
}
