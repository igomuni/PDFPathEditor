import { basename, dirname, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { IPC, type DetectTarget, type ImportOptions, type MenuCommand, type OpenedProject, type RecentProject, type UnsavedChoice } from '../shared/ipc'
import type { PickedCorrections } from '../shared/corrections'
import type { DocumentModel } from '../shared/model'
import {
  exportDocument,
  exportReview,
  readCorrections,
  detectCandidates,
  detectText,
  importPdf,
  listFonts,
  listOcrEngines,
  loadDocument,
  readAsset,
  readFont,
  saveDocument,
  type ResourcePaths
} from './project'
import type { OcrEngineId } from '../shared/ocr'
import { RecentProjects } from './recent'
import { Settings } from './settings'
import { DEFAULT_VECTORIZER_ID } from '../shared/vectorizer'

let mainWindow: BrowserWindow | null = null
// 開いているプロジェクト。renderer から任意パスを受け取らないよう main 側で保持する
let currentProjectDir: string | null = null
// メニューに出している、最近使ったプロジェクト
let recentList: RecentProject[] = []
const recentProjects = new RecentProjects(join(app.getPath('userData'), 'recent-projects.json'))
const settings = new Settings(join(app.getPath('userData'), 'settings.json'))
// 画面のドキュメントに未保存の変更があるか(renderer から知らされる)
let documentDirty = false
// 確認が済んで、次の close をそのまま通すか
let closeConfirmed = false

/** 未保存の変更をどうするか尋ねる */
async function askUnsaved(win: BrowserWindow): Promise<UnsavedChoice> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: '保存していない変更があります',
    detail: '保存しないと、最後に保存したあとの変更は失われます。',
    buttons: ['保存', '保存しない', 'キャンセル'],
    defaultId: 0,
    cancelId: 2
  })
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
}

/** 一覧を読み直して、メニューと画面に反映する */
async function refreshRecent(): Promise<void> {
  recentList = await recentProjects.list()
  buildMenu()
  mainWindow?.webContents.send(IPC.recentProjectsChanged, recentList)
}

/** 開いたプロジェクトとして覚える */
async function rememberProject(projectDir: string): Promise<void> {
  currentProjectDir = projectDir
  // 一覧の保存に失敗しても、プロジェクトを開くこと自体は止めない
  await recentProjects.add(projectDir).catch(() => {})
  await refreshRecent()
}

/** `pnpm fonts` / `pnpm ocr:build` の出力先(開発時はリポジトリ直下の resources/) */
function resourcePaths(): ResourcePaths {
  const root = join(app.getAppPath(), 'resources')
  return { fontsDir: join(root, 'fonts'), visionBinary: join(root, 'bin', 'vision-ocr') }
}

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
  // 未保存の変更があれば、閉じる前に確かめる
  win.on('close', (event) => {
    if (closeConfirmed || !documentDirty) return
    event.preventDefault()
    void askUnsaved(win).then((choice) => {
      if (choice === 'cancel') return
      if (choice === 'save') {
        // 保存は画面のドキュメントが要るので renderer に頼み、済んだら closeNow が来る
        win.webContents.send(IPC.saveBeforeClose)
        return
      }
      closeConfirmed = true
      win.close()
    })
  })
  win.on('closed', () => {
    closeConfirmed = false
    documentDirty = false
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
        {
          label: '最近使ったプロジェクト',
          submenu:
            recentList.length === 0
              ? [{ label: '(なし)', enabled: false }]
              : [
                  ...recentList.map(
                    (entry): MenuItemConstructorOptions => ({
                      label: `${basename(entry.dir)} — ${dirname(entry.dir)}`,
                      click: () => mainWindow?.webContents.send(IPC.recentProjectPicked, entry.dir)
                    })
                  ),
                  { type: 'separator' },
                  { label: '一覧を消去', click: () => void recentProjects.clear().then(refreshRecent) }
                ]
        },
        { type: 'separator' },
        item('保存', 'CmdOrCtrl+S', 'save'),
        item('出力(PDF / SVG / JSON)と検証', 'CmdOrCtrl+E', 'export'),
        { type: 'separator' },
        item('確認用データを書き出す', 'Shift+CmdOrCtrl+E', 'export-review'),
        item('修正を取り込む…', 'Shift+CmdOrCtrl+I', 'import-corrections'),
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: '編集',
      submenu: [
        item('元に戻す', 'CmdOrCtrl+Z', 'undo'),
        item('やり直す', 'Shift+CmdOrCtrl+Z', 'redo'),
        { type: 'separator' },
        item('すべて選択', 'CmdOrCtrl+A', 'select-all'),
        // Enter / Delete はキャンバス側のキー操作で処理する(入力欄のキーを奪わないため)
        { label: '選択した候補を確定 (Enter)', click: () => sendMenuCommand('confirm-selection') },
        item('候補を全件確定', 'Shift+CmdOrCtrl+Enter', 'confirm-all'),
        { label: '選択を削除 (Delete)', click: () => sendMenuCommand('delete-selection') }
      ]
    },
    {
      label: '抽出',
      submenu: [
        item('罫線を検出', 'CmdOrCtrl+D', 'detect-lines'),
        item('文字を検出(OCR)', 'CmdOrCtrl+T', 'detect-text'),
        { type: 'separator' },
        item('項目コードを割り当て', 'CmdOrCtrl+G', 'assign-field-codes')
      ]
    },
    {
      label: '表示',
      submenu: [
        item('拡大', 'CmdOrCtrl+=', 'zoom-in'),
        item('縮小', 'CmdOrCtrl+-', 'zoom-out'),
        item('ページ全体', 'CmdOrCtrl+0', 'zoom-fit'),
        item('100%', 'CmdOrCtrl+1', 'zoom-100'),
        { type: 'separator' },
        item('差分表示の切替', 'Shift+CmdOrCtrl+D', 'toggle-diff'),
        item('項目コード未付与の強調の切替', 'Shift+CmdOrCtrl+G', 'toggle-untagged'),
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
      // 前回 PDF を選んだフォルダから始める
      defaultPath: await settings.lastDir('pdf', app.getPath('documents')),
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    const pdfPath = picked.filePaths[0]
    await settings.rememberDir('pdf', dirname(pdfPath)).catch(() => {})

    const dest = await dialog.showSaveDialog(win, {
      title: 'プロジェクトフォルダの作成先',
      buttonLabel: '作成',
      nameFieldLabel: 'プロジェクト名:',
      // 前回プロジェクトを置いたフォルダに作る
      defaultPath: join(
        await settings.lastDir('projectParent', app.getPath('documents')),
        `${basename(pdfPath, extname(pdfPath))}-project`
      ),
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (dest.canceled || !dest.filePath) return null

    const document = await importPdf(pdfPath, dest.filePath, options)
    await settings.rememberDir('projectParent', dirname(dest.filePath)).catch(() => {})
    await rememberProject(dest.filePath)
    return { projectDir: dest.filePath, document }
  })

  ipcMain.handle(IPC.openProject, async (event): Promise<OpenedProject | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, {
      title: 'プロジェクトフォルダを選択',
      // 前回開いたプロジェクトの親フォルダから始める
      defaultPath: await settings.lastDir('projectParent', app.getPath('documents')),
      properties: ['openDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    const projectDir = picked.filePaths[0]
    const document = await loadDocument(projectDir)
    await settings.rememberDir('projectParent', dirname(projectDir)).catch(() => {})
    await rememberProject(projectDir)
    return { projectDir, document }
  })

  ipcMain.handle(IPC.openRecentProject, async (_event, dir: string): Promise<OpenedProject> => {
    // renderer から任意のパスを開かせない。一覧にあるものだけ受け付ける
    if (!(await recentProjects.list()).some((entry) => entry.dir === dir)) {
      await refreshRecent()
      throw new Error(`最近使ったプロジェクトの一覧にありません: ${dir}`)
    }
    const document = await loadDocument(dir)
    await rememberProject(dir)
    return { projectDir: dir, document }
  })
  ipcMain.on(IPC.setDirty, (event, dirty: boolean) => {
    documentDirty = dirty === true
    // macOS: 閉じるボタンに未保存の印を出す
    BrowserWindow.fromWebContents(event.sender)?.setDocumentEdited(documentDirty)
  })
  ipcMain.handle(IPC.confirmUnsaved, (event): Promise<UnsavedChoice> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? askUnsaved(win) : Promise.resolve('cancel')
  })
  ipcMain.on(IPC.closeNow, (event) => {
    closeConfirmed = true
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle(IPC.listRecentProjects, () => recentProjects.list())
  ipcMain.handle(IPC.clearRecentProjects, () => recentProjects.clear().then(refreshRecent))

  ipcMain.handle(IPC.saveDocument, (_event, document: DocumentModel) =>
    saveDocument(requireProjectDir(), document, resourcePaths())
  )

  ipcMain.handle(IPC.exportDocument, (_event, document: DocumentModel) =>
    exportDocument(requireProjectDir(), document, resourcePaths())
  )

  ipcMain.handle(IPC.exportReview, (_event, document: DocumentModel) =>
    exportReview(requireProjectDir(), document, resourcePaths())
  )

  ipcMain.handle(IPC.pickCorrections, async (event): Promise<PickedCorrections | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, {
      title: '修正ファイルを選択',
      // 前回修正ファイルを選んだフォルダ。なければプロジェクトの exports/
      defaultPath: await settings.lastDir('corrections', join(requireProjectDir(), 'exports')),
      properties: ['openFile'],
      filters: [{ name: '修正ファイル (JSON)', extensions: ['json'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    await settings.rememberDir('corrections', dirname(picked.filePaths[0])).catch(() => {})
    return readCorrections(picked.filePaths[0])
  })

  ipcMain.handle(IPC.readAsset, (_event, assetRel: string) => readAsset(requireProjectDir(), assetRel))

  ipcMain.handle(IPC.detectCandidates, (_event, target: DetectTarget) =>
    detectCandidates(requireProjectDir(), target, DEFAULT_VECTORIZER_ID)
  )

  ipcMain.handle(IPC.detectText, (_event, target: DetectTarget, engineId: OcrEngineId) =>
    detectText(requireProjectDir(), target, engineId, resourcePaths())
  )
  ipcMain.handle(IPC.listOcrEngines, () => listOcrEngines(resourcePaths()))
  ipcMain.handle(IPC.listFonts, () => listFonts(resourcePaths()))
  ipcMain.handle(IPC.readFont, (_event, file: string) => readFont(resourcePaths(), file))
}

void app.whenReady().then(() => {
  registerIpc()
  buildMenu()
  void refreshRecent()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
