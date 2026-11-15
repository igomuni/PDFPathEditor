import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DocumentModel, Layer, LayerKind, PathObject } from '../../shared/model.ts'
import { confirmCandidates, deleteObjects, moveNode, moveObjects } from './commands.ts'
import { History } from './history.ts'

function line(id: string, x0: number, y0: number, x1: number, y1: number): PathObject {
  return {
    id,
    type: 'path',
    role: 'frame',
    fieldCode: null,
    transform: [1, 0, 0, 1, 0, 0],
    z: 0,
    tags: [],
    meta: {},
    nodes: [
      { x: x0, y: y0 },
      { x: x1, y: y1 }
    ],
    closed: false,
    fill: null,
    stroke: '#000000',
    strokeWidth: 1,
    dash: null,
    lineCap: 'butt'
  }
}

function layer(kind: LayerKind, objects: PathObject[], locked = false): Layer {
  return { id: `layer-${kind}`, kind, name: kind, locked, visible: true, opacity: 1, objects }
}

function makeDocument(candidates: PathObject[], confirmed: PathObject[] = []): DocumentModel {
  return {
    version: 1,
    createdAt: '',
    source: {
      file: '',
      originalFileName: '',
      sha256: '',
      byteLength: 0,
      pageCount: 1,
      encrypted: false,
      encryptFilter: null,
      permissions: null
    },
    pages: [
      {
        id: 'page-1',
        sourcePageNumber: 1,
        mediaBox: [0, 0, 595, 842],
        layers: [layer('background', [], true), layer('candidates', candidates), layer('confirmed', confirmed)]
      }
    ]
  }
}

const nodesOf = (document: DocumentModel, kind: LayerKind, index = 0): number[][] =>
  (document.pages[0].layers.find((l) => l.kind === kind)!.objects[index] as PathObject).nodes.map((n) => [n.x, n.y])

test('オブジェクトの移動は全頂点を動かし、元に戻せる', () => {
  const document = makeDocument([line('a', 10, 100, 200, 100)])
  const command = moveObjects(document, ['a'], 0.24, -0.48)!
  const moved = command.apply(document)
  assert.deepEqual(nodesOf(moved, 'candidates'), [
    [10.24, 99.52],
    [200.24, 99.52]
  ])
  assert.deepEqual(command.revert(moved), document)
})

test('水平線の端点: 線に沿う移動は端点だけ、直交する移動は線全体が動く', () => {
  const document = makeDocument([line('a', 10, 100, 200, 100)])
  const along = moveNode(document, 'a', 1, 5, 0)!.apply(document)
  assert.deepEqual(nodesOf(along, 'candidates'), [
    [10, 100],
    [205, 100]
  ])
  const across = moveNode(document, 'a', 1, 0, 2)!.apply(document)
  assert.deepEqual(nodesOf(across, 'candidates'), [
    [10, 102],
    [200, 102]
  ])
})

test('垂直線の端点も垂直を保つ', () => {
  const document = makeDocument([line('a', 50, 100, 50, 300)])
  const moved = moveNode(document, 'a', 0, 3, -4)!.apply(document)
  assert.deepEqual(nodesOf(moved, 'candidates'), [
    [53, 96],
    [53, 300]
  ])
})

test('斜めの線の頂点は自由に動く', () => {
  const document = makeDocument([line('a', 10, 100, 200, 150)])
  const moved = moveNode(document, 'a', 0, 1, 2)!.apply(document)
  assert.deepEqual(nodesOf(moved, 'candidates'), [
    [11, 102],
    [200, 150]
  ])
})

test('選択した候補だけを確定レイヤーへ移し、手前に積む', () => {
  const existing = { ...line('c', 0, 0, 1, 0), z: 4 }
  const document = makeDocument([line('a', 0, 10, 5, 10), line('b', 0, 20, 5, 20)], [existing])
  const command = confirmCandidates(document, ['b'])!
  const result = command.apply(document)
  const [, candidates, confirmed] = result.pages[0].layers
  assert.deepEqual(candidates.objects.map((o) => o.id), ['a'])
  assert.deepEqual(confirmed.objects.map((o) => [o.id, o.z]), [
    ['c', 4],
    ['b', 5]
  ])
  assert.deepEqual(command.revert(result), document)
})

test('ids を省略すると候補を全件確定する。候補がなければ何もしない', () => {
  const document = makeDocument([line('a', 0, 10, 5, 10), line('b', 0, 20, 5, 20)])
  const result = confirmCandidates(document)!.apply(document)
  assert.equal(result.pages[0].layers[1].objects.length, 0)
  assert.deepEqual(result.pages[0].layers[2].objects.map((o) => o.id), ['a', 'b'])
  assert.equal(confirmCandidates(result), null)
})

test('削除は対象だけを消し、該当がなければ null', () => {
  const document = makeDocument([line('a', 0, 10, 5, 10), line('b', 0, 20, 5, 20)])
  const result = deleteObjects(document, ['a'])!.apply(document)
  assert.deepEqual(result.pages[0].layers[1].objects.map((o) => o.id), ['b'])
  assert.equal(deleteObjects(document, ['zzz']), null)
})

test('連続した移動は1つの履歴にまとまり、区切ると別の履歴になる', () => {
  const history = new History()
  let document = makeDocument([line('a', 10, 100, 200, 100)])
  const original = document
  for (let i = 0; i < 3; i++) document = history.execute(document, moveObjects(document, ['a'], 1, 0)!)
  history.seal()
  document = history.execute(document, moveObjects(document, ['a'], 1, 0)!)
  assert.deepEqual(nodesOf(document, 'candidates')[0], [14, 100])
  document = history.undo(document)
  assert.deepEqual(nodesOf(document, 'candidates')[0], [13, 100])
  document = history.undo(document)
  assert.deepEqual(document, original)
  assert.equal(history.canUndo, false)
})
