import { basename, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { IPC, type DetectTarget, type ImportOptions, type MenuCommand, type OpenedProject } from '../shared/ipc'
import type { DocumentModel } from '../shared/model'
import { detectCandidates, importPdf, loadDocument, readAsset, saveDocument } from './project'
import { DEFAULT_VECTORIZER_ID } from '../shared/vectorizer'

let mainWindow: BrowserWindow | null = null
// 開いているプロジェクト。renderer から任意パスを受け取らないよう main 側で保持する
let currentProjectDir: string | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'PDFPathEditor',
    backgroundColor: '#2b2b2b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  // ピンチ操作はキャンバス側のズームで処理する
  win.webContents.on('did-finish-load', () => {
    void win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {})
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function sendMenuCommand(command: MenuCommand): void {
  mainWindow?.webContents.send(IPC.menuCommand, command)
}

function buildMenu(): void {
  const item = (label: string, accelerator: string, command: MenuCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => sendMenuCommand(command)
  })
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'ファイル',
      submenu: [
        item('PDFを取り込む…', 'CmdOrCtrl+I', 'import-pdf'),
        item('プロジェクトを開く…', 'CmdOrCtrl+O', 'open-project'),
        { type: 'separator' },
        item('保存', 'CmdOrCtrl+S', 'save'),
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: '編集',
      submenu: [
        item('元に戻す', 'CmdOrCtrl+Z', 'undo'),
        item('やり直す', 'Shift+CmdOrCtrl+Z', 'redo')
      ]
    },
    {
      label: '抽出',
      submenu: [item('罫線を検出', 'CmdOrCtrl+D', 'detect-lines')]
    },
    {
      label: '表示',
      submenu: [
        item('拡大', 'CmdOrCtrl+=', 'zoom-in'),
        item('縮小', 'CmdOrCtrl+-', 'zoom-out'),
        item('ページ全体', 'CmdOrCtrl+0', 'zoom-fit'),
        item('100%', 'CmdOrCtrl+1', 'zoom-100'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function requireProjectDir(): string {
  if (!currentProjectDir) throw new Error('プロジェクトが開かれていません')
  return currentProjectDir
}

function registerIpc(): void {
  ipcMain.handle(IPC.importPdf, async (event, options: ImportOptions): Promise<OpenedProject | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, {
      title: '取り込むPDFを選択',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    const pdfPath = picked.filePaths[0]

    const dest = await dialog.showSaveDialog(win, {
      title: 'プロジェクトフォルダの作成先',
      buttonLabel: '作成',
      nameFieldLabel: 'プロジェクト名:',
      defaultPath: join(app.getPath('documents'), `${basename(pdfPath, extname(pdfPath))}-project`),
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (dest.canceled || !dest.filePath) return null

    const document = await importPdf(pdfPath, dest.filePath, options)
    currentProjectDir = dest.filePath
    return { projectDir: dest.filePath, document }
  })

  ipcMain.handle(IPC.openProject, async (event): Promise<OpenedProject | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, {
      title: 'プロジェクトフォルダを選択',
      properties: ['openDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    const projectDir = picked.filePaths[0]
    const document = await loadDocument(projectDir)
    currentProjectDir = projectDir
    return { projectDir, document }
  })

  ipcMain.handle(IPC.saveDocument, (_event, document: DocumentModel) =>
    saveDocument(requireProjectDir(), document)
  )

  ipcMain.handle(IPC.readAsset, (_event, assetRel: string) => readAsset(requireProjectDir(), assetRel))

  ipcMain.handle(IPC.detectCandidates, (_event, target: DetectTarget) =>
    detectCandidates(requireProjectDir(), target, DEFAULT_VECTORIZER_ID)
  )
}

void app.whenReady().then(() => {
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
