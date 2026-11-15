import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DocObject, DocumentModel, Layer, LayerKind, Page } from '../../shared/model.ts'
import { buildPageTree, withoutPage } from './pageTree.ts'

const object = (id: string): DocObject =>
  ({ id, type: 'path', role: 'frame', fieldCode: null, transform: [1, 0, 0, 1, 0, 0], z: 0, tags: [], meta: {}, nodes: [], closed: false, fill: null, stroke: null, strokeWidth: 0, dash: null, lineCap: 'butt' })
const layer = (kind: LayerKind, count: number): Layer => ({ id: `layer-${kind}`, kind, name: kind, locked: false, visible: true, opacity: 1, objects: Array.from({ length: count }, (_, i) => object(`${kind}-${i}`)) })
const page = (id: string, sourceId: string, number: number, candidates = 0, confirmed = 0): Page => ({
  id,
  sourceId,
  sourcePageNumber: number,
  mediaBox: [0, 0, 595, 842],
  layers: [layer('background', 1), layer('candidates', candidates), layer('confirmed', confirmed)]
})
const source = (id: string) => ({ id, file: `source/${id}/x.pdf`, originalFileName: `${id}.pdf`, sha256: id, byteLength: 1, pageCount: 32, encrypted: false, encryptFilter: null, permissions: null })
const document = (pages: Page[]): DocumentModel => ({ version: 2, createdAt: '', sources: [source('src-a'), source('src-b')], pages })

test('buildPageTree: PDFごとにページ番号の順で並べ、件数と未保存を出す', () => {
  const p3 = page('p3', 'src-a', 3, 5, 2)
  const p2 = page('p2', 'src-a', 2)
  const q1 = page('q1', 'src-b', 1, 0, 9)
  const saved = document([p3, p2, q1])
  const edited = { ...p2, layers: [...p2.layers] }
  const tree = buildPageTree(document([p3, edited, q1]), saved)
  assert.deepEqual(
    tree.map((entry) => [entry.source.id, entry.pages.map((p) => `${p.page.sourcePageNumber}:${p.candidates}/${p.confirmed}${p.dirty ? '*' : ''}`)]),
    [
      ['src-a', ['2:0/0*', '3:5/2']],
      ['src-b', ['1:0/9']]
    ]
  )
  // 保存したことがなければ全部未保存
  assert.equal(buildPageTree(saved, null).every((entry) => entry.pages.every((p) => p.dirty)), true)
})

test('withoutPage: ページを外し、指定された元PDFは使われていなければ外す', () => {
  const doc = document([page('p2', 'src-a', 2), page('p3', 'src-a', 3), page('q1', 'src-b', 1)])
  const a = withoutPage(doc, 'q1', 'src-b')
  assert.deepEqual([a.pages.map((p) => p.id), a.sources.map((s) => s.id)], [['p2', 'p3'], ['src-a']])
  // 元PDFを残す指定
  assert.deepEqual(withoutPage(doc, 'q1', null).sources.map((s) => s.id), ['src-a', 'src-b'])
  // まだ使われている元PDFは外さない
  assert.deepEqual(withoutPage(doc, 'p2', 'src-a').sources.map((s) => s.id), ['src-a', 'src-b'])
})
