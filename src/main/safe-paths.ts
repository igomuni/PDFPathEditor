// utility process 用: ドキュメントの値からファイルパスを作るときの検証
import { resolve, sep } from 'node:path'
import type { Page } from '../shared/model'

// document は画面や document.json から来るので、パスに使う値はここで確かめる
export function pageLabel(page: Page): string {
  const number: unknown = page.sourcePageNumber
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    throw new Error(`ページ番号が正しくありません: ${String(number)}`)
  }
  return `page-${String(number).padStart(4, '0')}`
}

/** 背景ラスターはプロジェクトの assets/ の中だけから読む */
export function assetPath(projectDir: string, asset: unknown): string {
  const root = resolve(projectDir, 'assets')
  const path = typeof asset === 'string' ? resolve(projectDir, asset) : ''
  if (!path.startsWith(root + sep)) throw new Error(`assets 外のパスは読めません: ${String(asset)}`)
  return path
}
