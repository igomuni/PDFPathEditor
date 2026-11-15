import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type AddedPages, type DeletedPage, type DetectTarget, type SavePayload, type ImportOptions, type MenuCommand, type OpenedProject, type RecentProject, type UnsavedChoice } from '../shared/ipc'
import type { PickedCorrections, ReviewExportResult } from '../shared/corrections'
import type { ExportResult } from '../shared/export'
import type { FontFace } from '../shared/fonts'
import type { DocumentModel, PathObject, ImageObject, Rect } from '../shared/model'
import type { OcrEngineId, OcrEngineInfo, TextDetection } from '../shared/ocr'

const api = {
  importPdf: (options: ImportOptions): Promise<OpenedProject | null> =>
    ipcRenderer.invoke(IPC.importPdf, options),
  addPdf: (options: ImportOptions): Promise<AddedPages | null> => ipcRenderer.invoke(IPC.addPdf, options),
  addPages: (sourceId: string, options: ImportOptions): Promise<AddedPages> =>
    ipcRenderer.invoke(IPC.addPages, sourceId, options),
  deletePage: (pageId: string, label: string): Promise<DeletedPage | null> =>
    ipcRenderer.invoke(IPC.deletePage, pageId, label),
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
  setDirty: (dirty: boolean): void => ipcRenderer.send(IPC.setDirty, dirty),
  confirmUnsaved: (): Promise<UnsavedChoice> => ipcRenderer.invoke(IPC.confirmUnsaved),
  onSaveBeforeClose: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC.saveBeforeClose, handler)
    return () => ipcRenderer.removeListener(IPC.saveBeforeClose, handler)
  },
  closeNow: (): void => ipcRenderer.send(IPC.closeNow),
  saveDocument: (payload: SavePayload): Promise<void> => ipcRenderer.invoke(IPC.saveDocument, payload),
  exportDocument: (document: DocumentModel): Promise<ExportResult> =>
    ipcRenderer.invoke(IPC.exportDocument, document),
  exportReview: (document: DocumentModel): Promise<ReviewExportResult> =>
    ipcRenderer.invoke(IPC.exportReview, document),
  pickCorrections: (): Promise<PickedCorrections | null> => ipcRenderer.invoke(IPC.pickCorrections),
  readAsset: (assetRel: string): Promise<Uint8Array> => ipcRenderer.invoke(IPC.readAsset, assetRel),
  detectCandidates: (target: DetectTarget): Promise<PathObject[]> =>
    ipcRenderer.invoke(IPC.detectCandidates, target),
  detectText: (target: DetectTarget, engineId: OcrEngineId): Promise<TextDetection> =>
    ipcRenderer.invoke(IPC.detectText, target, engineId),
  detectQr: (target: DetectTarget): Promise<ImageObject[]> => ipcRenderer.invoke(IPC.detectQr, target),
  cropImage: (target: DetectTarget, rect: Rect): Promise<ImageObject[]> => ipcRenderer.invoke(IPC.cropImage, target, rect),
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
