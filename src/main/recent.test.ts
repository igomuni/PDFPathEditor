import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { addRecent, RecentProjects } from './recent.ts'

test('addRecent: 先頭に入れ、重複を除き、上限で切る', () => {
  let list = addRecent([], '/a', 't1')
  list = addRecent(list, '/b', 't2')
  list = addRecent(list, '/a', 't3')
  assert.deepEqual(list, [
    { dir: '/a', openedAt: 't3' },
    { dir: '/b', openedAt: 't2' }
  ])
  assert.deepEqual(
    addRecent(list, '/c', 't4', 2).map((entry) => entry.dir),
    ['/c', '/a']
  )
})

test('RecentProjects: 保存して読み直せる。なくなったプロジェクトは出さず、壊れたファイルは空として扱う', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdfpe-recent-'))
  try {
    const file = join(root, 'settings', 'recent-projects.json')
    const recent = new RecentProjects(file)
    assert.deepEqual(await recent.list(), [])

    const alive = join(root, 'alive')
    await mkdir(alive)
    await writeFile(join(alive, 'document.json'), '{}')
    await recent.add(join(root, 'gone'))
    await recent.add(alive)
    assert.deepEqual(
      (await new RecentProjects(file).list()).map((entry) => entry.dir),
      [alive]
    )

    await recent.clear()
    assert.deepEqual(await recent.list(), [])
    await writeFile(file, 'not json')
    assert.deepEqual(await recent.list(), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
