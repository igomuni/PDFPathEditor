import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DocumentModel, Layer, LayerKind, Page } from './model.ts'
import { diffPages, fromPageFile, isSafeId, migrateV1, newPageId, pageFileName, parsePageSpec, sourceOf, toManifest, toPageFile } from './project.ts'

const layer = (kind: LayerKind): Layer => ({ id: `layer-${kind}`, kind, name: kind, locked: false, visible: true, opacity: 1, objects: [] })
const page = (id: string, sourceId: string, number: number): Page => ({
  id,
  sourceId,
  sourcePageNumber: number,
  mediaBox: [0, 0, 595, 842],
  layers: [layer('background'), layer('candidates'), layer('confirmed')]
})
const source = (id: string, name: string) => ({
  id,
  file: `source/${id}/${name}`,
  originalFileName: name,
  sha256: id,
  byteLength: 1,
  pageCount: 32,
  encrypted: false,
  encryptFilter: null,
  permissions: null
})
const document = (pages: Page[]): DocumentModel => ({ version: 2, createdAt: '2026-11-15T00:00:00.000Z', sources: [source('src-a', 'a.pdf'), source('src-b', 'b.pdf')], pages })

test('migrateV1: 1つのPDFの旧形式を読み替え、ファイルの場所は変えず、差分レイヤーを落とす', () => {
  const migrated = migrateV1({
    version: 1,
    createdAt: '2026-11-15T00:00:00.000Z',
    source: { file: 'source/form.pdf', originalFileName: 'form.pdf', sha256: 'abc', byteLength: 10, pageCount: 32, encrypted: true, encryptFilter: 'Standard', permissions: [4] },
    pages: [{ id: 'page-uuid', sourcePageNumber: 2, mediaBox: [0, 0, 595, 842], layers: [layer('background'), layer('candidates'), layer('confirmed'), layer('diff')] }]
  })
  assert.equal(migrated.version, 2)
  assert.deepEqual(migrated.sources, [
    { id: 'src-1', file: 'source/form.pdf', originalFileName: 'form.pdf', sha256: 'abc', byteLength: 10, pageCount: 32, encrypted: true, encryptFilter: 'Standard', permissions: [4] }
  ])
  assert.equal(migrated.pages[0].id, 'page-uuid')
  assert.equal(migrated.pages[0].sourceId, 'src-1')
  assert.deepEqual(
    migrated.pages[0].layers.map((l) => l.kind),
    ['background', 'candidates', 'confirmed']
  )
  assert.equal(sourceOf(migrated, migrated.pages[0])?.originalFileName, 'form.pdf')
})

test('目次とページのファイルに分け、元に戻せる', () => {
  const doc = document([page('page-0002-aa', 'src-a', 2), page('page-0003-bb', 'src-a', 3), page('page-0001-cc', 'src-b', 1)])
  const manifest = toManifest(doc)
  assert.deepEqual(
    manifest.pages.map((ref) => ref.file),
    ['pages/page-0002-aa.json', 'pages/page-0003-bb.json', 'pages/page-0001-cc.json']
  )
  assert.equal('layers' in manifest.pages[0], false)
  assert.equal(manifest.sources.length, 2)

  const file = toPageFile(doc.pages[0])
  assert.equal(file.version, 2)
  assert.deepEqual(fromPageFile(JSON.parse(JSON.stringify(file)), manifest.pages[0]), doc.pages[0])
  // 目次と食い違うファイル、壊れたファイルは読まない
  assert.throws(() => fromPageFile(file, { id: 'page-0003-bb', sourceId: 'src-a' }), /一致しません/)
  assert.throws(() => fromPageFile({ version: 1, layers: [] }, manifest.pages[0]), /形式/)
  assert.throws(() => fromPageFile(null, manifest.pages[0]), /形式/)
})

test('IDはファイル名として安全なものだけを通す', () => {
  assert.equal(newPageId(2, '3f9a1c2e'), 'page-0002-3f9a1c2e')
  assert.equal(isSafeId('page-0002-3f9a1c2e'), true)
  assert.equal(isSafeId('page-0b6e2c1e-7a0f-4d53-9f43-0a1b2c3d4e5f'), true)
  for (const bad of ['../x', 'a/b', '', '.hidden', 'a b', 12, null]) assert.equal(isSafeId(bad), false)
  assert.throws(() => pageFileName('../../etc/passwd'), /ページID/)
})

test('diffPages: 参照が変わったページだけを保存対象にし、消えたページを返す', () => {
  const a = page('a', 'src-a', 1)
  const b = page('b', 'src-a', 2)
  const c = page('c', 'src-a', 3)
  const saved = document([a, b, c])
  assert.deepEqual(diffPages(saved, saved), { changed: [], removedIds: [] })
  const b2 = { ...b, layers: [...b.layers] }
  const d = page('d', 'src-b', 1)
  const next = document([a, b2, d])
  assert.deepEqual(diffPages(saved, next), { changed: [b2, d], removedIds: ['c'] })
  // 保存したことがなければ全ページ
  assert.equal(diffPages(null, saved).changed.length, 3)
})

test('parsePageSpec: 単独・範囲・複数の指定を、昇順で重複なく返す', () => {
  assert.deepEqual(parsePageSpec('2'), [2])
  assert.deepEqual(parsePageSpec('1-3,5'), [1, 2, 3, 5])
  assert.deepEqual(parsePageSpec(' 5, 2 - 3 、2 '), [2, 3, 5])
  assert.deepEqual(parsePageSpec('3〜4'), [3, 4])
  assert.deepEqual(parsePageSpec('1-32', 32).length, 32)
  for (const bad of ['', '0', 'a', '3-1', '1-', '-2', '1.5', '2;3']) assert.throws(() => parsePageSpec(bad), /ページ/)
  assert.throws(() => parsePageSpec('33', 32), /範囲外/)
  assert.throws(() => parsePageSpec('1-500'), /200 ページまで/)
})
