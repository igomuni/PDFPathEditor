// アプリの設定(前回使ったフォルダなど)。設定フォルダ(userData)に JSON で持つ。
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** ファイルダイアログの種類ごとに、前回使ったフォルダを覚える */
export type DialogKind = 'pdf' | 'projectParent' | 'corrections'

export class Settings {
  private readonly file: string
  private lastDirs: Partial<Record<DialogKind, string>> | null = null

  // Node の型除去で動くテストから読み込むので、引数プロパティは使わない
  constructor(file: string) {
    this.file = file
  }

  private async load(): Promise<Partial<Record<DialogKind, string>>> {
    if (this.lastDirs) return this.lastDirs
    const dirs: Partial<Record<DialogKind, string>> = {}
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { lastDirs?: Record<string, unknown> } | null
      for (const kind of ['pdf', 'projectParent', 'corrections'] as const) {
        const value = parsed?.lastDirs?.[kind]
        if (typeof value === 'string') dirs[kind] = value
      }
    } catch {
      // ファイルがない・壊れているときは、何も覚えていないものとして扱う
    }
    return (this.lastDirs = dirs)
  }

  /** 前回使ったフォルダ。覚えていないか、なくなっていれば fallback */
  async lastDir(kind: DialogKind, fallback: string): Promise<string> {
    const dir = (await this.load())[kind]
    return dir && existsSync(dir) ? dir : fallback
  }

  async rememberDir(kind: DialogKind, dir: string): Promise<void> {
    const dirs = await this.load()
    if (dirs[kind] === dir) return
    dirs[kind] = dir
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify({ lastDirs: dirs }, null, 2) + '\n', 'utf8')
    await rename(temp, this.file)
  }
}
