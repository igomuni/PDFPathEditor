// 実アプリの自動確認用。Electron の main に `-r` で読み込ませ、ファイルダイアログと確認ダイアログを
// 環境変数の値で置き換える(本番のコードには入らない)。使い方は scripts/e2e/README.md。
//   E2E_PROJECT   「プロジェクトを開く」で返すフォルダ
//   E2E_PDF       「PDFを取り込む」で返す PDF
//   E2E_DEST      プロジェクトの作成先
//   E2E_JSON      「修正を取り込む」で返す JSON
//   E2E_MESSAGE   確認ダイアログで押すボタンの番号(既定 2 = キャンセル)
//   E2E_LOG       ダイアログの呼び出し(種類・タイトル・開始フォルダ)を追記するファイル
//   E2E_CLOSE     このファイルができたら、閉じるボタンと同じ経路でウィンドウを閉じる
const { dialog, BrowserWindow } = require('electron')
const fs = require('node:fs')

const log = (kind, options) => {
  if (!process.env.E2E_LOG) return
  fs.appendFileSync(process.env.E2E_LOG, `${kind}\t${options?.title ?? options?.message ?? ''}\t${options?.defaultPath ?? ''}\n`)
}
const wants = (options, extension) => (options?.filters ?? []).some((filter) => filter.extensions.includes(extension))

dialog.showOpenDialog = async (_win, options) => {
  log('open', options)
  const path = wants(options, 'json') ? process.env.E2E_JSON : wants(options, 'pdf') ? process.env.E2E_PDF : process.env.E2E_PROJECT
  return path ? { canceled: false, filePaths: [path] } : { canceled: true, filePaths: [] }
}
dialog.showSaveDialog = async (_win, options) => {
  log('save', options)
  return process.env.E2E_DEST ? { canceled: false, filePath: process.env.E2E_DEST } : { canceled: true }
}
dialog.showMessageBox = async (_win, options) => {
  log('message', options)
  return { response: Number(process.env.E2E_MESSAGE ?? 2) }
}

if (process.env.E2E_CLOSE) {
  setInterval(() => {
    if (!fs.existsSync(process.env.E2E_CLOSE)) return
    fs.rmSync(process.env.E2E_CLOSE)
    BrowserWindow.getAllWindows()[0]?.close()
  }, 300)
}
