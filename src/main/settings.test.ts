import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Settings } from './settings.ts'

test('Settings: 種類ごとに前回のフォルダを覚え、読み直せる。なくなったフォルダや壊れたファイルは fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdfpe-settings-'))
  try {
    const file = join(root, 'conf', 'settings.json')
    const settings = new Settings(file)
    assert.equal(await settings.lastDir('pdf', '/fallback'), '/fallback')

    const pdfs = join(root, 'pdfs')
    await mkdir(pdfs)
    await settings.rememberDir('pdf', pdfs)
    await settings.rememberDir('projectParent', join(root, 'gone'))
    const reloaded = new Settings(file)
    assert.equal(await reloaded.lastDir('pdf', '/fallback'), pdfs)
    assert.equal(await reloaded.lastDir('projectParent', '/fallback'), '/fallback')
    assert.equal(await reloaded.lastDir('corrections', '/fallback'), '/fallback')

    await writeFile(file, '{ broken')
    assert.equal(await new Settings(file).lastDir('pdf', '/fallback'), '/fallback')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
