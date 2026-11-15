import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type DetectTarget, type ImportOptions, type MenuCommand, type OpenedProject, type RecentProject } from '../shared/ipc'
import type { ExportResult } from '../shared/export'
import type { FontFace } from '../shared/fonts'
import type { DocumentModel, PathObject, TextObject } from '../shared/model'
import type { OcrEngineId, OcrEngineInfo } from '../shared/ocr'

const api = {
  importPdf: (options: ImportOptions): Promise<OpenedProject | null> =>
    ipcRenderer.invoke(IPC.importPdf, options),
  openProject: (): Promise<OpenedProject | null> => ipcRenderer.invoke(IPC.openProject),
  openRecentProject: (dir: string): Promise<OpenedProject> => ipcRenderer.invoke(IPC.openRecentProject, dir),
  listRecentProjects: (): Promise<RecentProject[]> => ipcRenderer.invoke(IPC.listRecentProjects),
  clearRecentProjects: (): Promise<void> => ipcRenderer.invoke(IPC.clearRecentProjects),
  onRecentProjectPicked: (listener: (dir: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, dir: string): void => listener(dir)
    ipcRenderer.on(IPC.recentProjectPicked, handler)
    return () => ipcRenderer.removeListener(IPC.recentProjectPicked, handler)
  },
  onRecentProjectsChanged: (listener: (projects: RecentProject[]) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, projects: RecentProject[]): void => listener(projects)
    ipcRenderer.on(IPC.recentProjectsChanged, handler)
    return () => ipcRenderer.removeListener(IPC.recentProjectsChanged, handler)
  },
  saveDocument: (document: DocumentModel): Promise<void> =>
    ipcRenderer.invoke(IPC.saveDocument, document),
  exportDocument: (document: DocumentModel): Promise<ExportResult> =>
    ipcRenderer.invoke(IPC.exportDocument, document),
  readAsset: (assetRel: string): Promise<Uint8Array> => ipcRenderer.invoke(IPC.readAsset, assetRel),
  detectCandidates: (target: DetectTarget): Promise<PathObject[]> =>
    ipcRenderer.invoke(IPC.detectCandidates, target),
  detectText: (target: DetectTarget, engineId: OcrEngineId): Promise<TextObject[]> =>
    ipcRenderer.invoke(IPC.detectText, target, engineId),
  listOcrEngines: (): Promise<OcrEngineInfo[]> => ipcRenderer.invoke(IPC.listOcrEngines),
  listFonts: (): Promise<FontFace[]> => ipcRenderer.invoke(IPC.listFonts),
  readFont: (file: string): Promise<Uint8Array> => ipcRenderer.invoke(IPC.readFont, file),
  onMenuCommand: (listener: (command: MenuCommand) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, command: MenuCommand): void => listener(command)
    ipcRenderer.on(IPC.menuCommand, handler)
    return () => ipcRenderer.removeListener(IPC.menuCommand, handler)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
