import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type DetectTarget, type ImportOptions, type MenuCommand, type OpenedProject } from '../shared/ipc'
import type { DocumentModel, PathObject } from '../shared/model'

const api = {
  importPdf: (options: ImportOptions): Promise<OpenedProject | null> =>
    ipcRenderer.invoke(IPC.importPdf, options),
  openProject: (): Promise<OpenedProject | null> => ipcRenderer.invoke(IPC.openProject),
  saveDocument: (document: DocumentModel): Promise<void> =>
    ipcRenderer.invoke(IPC.saveDocument, document),
  readAsset: (assetRel: string): Promise<Uint8Array> => ipcRenderer.invoke(IPC.readAsset, assetRel),
  detectCandidates: (target: DetectTarget): Promise<PathObject[]> =>
    ipcRenderer.invoke(IPC.detectCandidates, target),
  onMenuCommand: (listener: (command: MenuCommand) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, command: MenuCommand): void => listener(command)
    ipcRenderer.on(IPC.menuCommand, handler)
    return () => ipcRenderer.removeListener(IPC.menuCommand, handler)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
