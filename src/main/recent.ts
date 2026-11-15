// 最近使ったプロジェクトの一覧。アプリの設定フォルダ(userData)に JSON で持つ。
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RecentProject } from '../shared/ipc.ts'

export const MAX_RECENT_PROJECTS = 10

/** dir を先頭に入れ、重複を除いて上限までに切る */
export function addRecent(list: readonly RecentProject[], dir: string, openedAt: string, max = MAX_RECENT_PROJECTS): RecentProject[] {
  return [{ dir, openedAt }, ...list.filter((entry) => entry.dir !== dir)].slice(0, max)
}

function isRecentProject(value: unknown): value is RecentProject {
  const entry = value as RecentProject | null
  return typeof entry?.dir === 'string' && typeof entry.openedAt === 'string'
}

export class RecentProjects {
  private readonly file: string

  // Node の型除去で動くテストから読み込むので、引数プロパティは使わない
  constructor(file: string) {
    this.file = file
  }

  /** 保存してある一覧。壊れていれば空として扱う */
  private async read(): Promise<RecentProject[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(isRecentProject) : []
    } catch {
      return []
    }
  }

  private async write(list: RecentProject[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(list, null, 2) + '\n', 'utf8')
    await rename(temp, this.file)
  }

  /** 一覧を返す。フォルダや document.json がなくなったものは出さない(一覧からは消さない) */
  async list(): Promise<RecentProject[]> {
    const list = await this.read()
    const alive = await Promise.all(
      list.map((entry) =>
        access(join(entry.dir, 'document.json')).then(
          () => true,
          () => false
        )
      )
    )
    return list.filter((_, i) => alive[i])
  }

  async add(dir: string): Promise<void> {
    await this.write(addRecent(await this.read(), dir, new Date().toISOString()))
  }

  async clear(): Promise<void> {
    await this.write([])
  }
}
