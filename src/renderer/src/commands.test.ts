import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DocObject, DocumentModel, Layer, LayerKind, PathObject, TextObject } from '../../shared/model.ts'
import {
  addObjects,
  confirmCandidates,
  duplicateObjects,
  deleteObjects,
  moveNode,
  moveObjects,
  replaceObjectsOfType,
  replaceObjectsWhere,
  updateTexts
} from './commands.ts'
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

function label(id: string, text: string, x: number, y: number): TextObject {
  return {
    id,
    type: 'text',
    role: 'label',
    fieldCode: null,
    transform: [1, 0, 0, 1, x, y],
    z: 0,
    tags: [],
    meta: {},
    text,
    fontFamily: 'Noto Sans JP',
    fontWeight: 400,
    fontSize: 9,
    letterSpacing: 0,
    fill: '#000000',
    align: 'left',
    outline: false
  }
}

function layer(kind: LayerKind, objects: DocObject[], locked = false): Layer {
  return { id: `layer-${kind}`, kind, name: kind, locked, visible: true, opacity: 1, objects }
}

function makeDocument(candidates: DocObject[], confirmed: DocObject[] = []): DocumentModel {
  return {
    version: 2,
    createdAt: '',
    sources: [
      {
        id: 'src-1',
        file: '',
        originalFileName: '',
        sha256: '',
        byteLength: 0,
        pageCount: 1,
        encrypted: false,
        encryptFilter: null,
        permissions: null
      }
    ],
    pages: [
      {
        id: 'page-1',
        sourceId: 'src-1',
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

test('テキストの移動は変換行列の平行移動成分を動かす', () => {
  const document = makeDocument([label('t', '氏名', 100, 200)])
  const moved = moveObjects(document, ['t'], 0.24, 2.4)!.apply(document)
  assert.deepEqual(moved.pages[0].layers[1].objects[0].transform, [1, 0, 0, 1, 100.24, 202.4])
})

test('テキストの属性変更は Text だけに効き、同じ属性の連続変更は1履歴になる', () => {
  const history = new History()
  let document = makeDocument([label('t', '氏名', 0, 0), line('a', 0, 10, 5, 10)])
  const original = document
  for (const fontSize of [9.5, 10, 10.5]) {
    document = history.execute(document, updateTexts(document, ['t', 'a'], { fontSize })!)
  }
  document = history.execute(document, updateTexts(document, ['t'], { fontFamily: 'Noto Serif JP' })!)
  const text = document.pages[0].layers[1].objects[0] as TextObject
  assert.equal(text.fontSize, 10.5)
  assert.equal(text.fontFamily, 'Noto Serif JP')
  assert.equal(document.pages[0].layers[1].objects[1], original.pages[0].layers[1].objects[1])
  document = history.undo(document)
  assert.equal((document.pages[0].layers[1].objects[0] as TextObject).fontSize, 10.5)
  document = history.undo(document)
  assert.deepEqual(document, original)
})

test('種類を指定した入れ替えは、ほかの種類の候補を残す', () => {
  const document = makeDocument([line('a', 0, 10, 5, 10), label('t', '旧', 0, 0)])
  const layerId = document.pages[0].layers[1].id
  const result = replaceObjectsOfType(document, layerId, 'text', [label('n1', '新1', 0, 0), label('n2', '新2', 0, 0)], '文字を検出')!.apply(document)
  assert.deepEqual(result.pages[0].layers[1].objects.map((o) => [o.id, o.z]), [
    ['a', 0],
    ['n1', 1],
    ['n2', 2]
  ])
})

test('条件での入れ替え: 罫線だけ、または Text と丸数字の丸だけを入れ替える', () => {
  const circle: PathObject = { ...line('circle', 0, 0, 1, 1), role: 'label', meta: { source: 'ocr-circle' } }
  const cell: PathObject = { ...line('cell', 0, 0, 1, 1), role: 'inputCell' }
  const document = makeDocument([line('rule', 0, 0, 10, 0), circle, cell, label('text', '62', 0, 0)])
  const ids = (doc: DocumentModel): string[] => doc.pages[0].layers.find((l) => l.kind === 'candidates')!.objects.map((o) => o.id)

  // 罫線の再検出: 記入欄と丸は残る
  const isRule = (object: DocObject): boolean => object.type === 'path' && object.role === 'frame' && object.meta.source !== 'ocr-circle'
  const lines = replaceObjectsWhere(document, 'layer-candidates', isRule, [line('rule2', 0, 5, 10, 5)], '罫線を検出')!.apply(document)
  assert.deepEqual(ids(lines), ['circle', 'cell', 'text', 'rule2'])

  // 文字の再検出: Text と丸が入れ替わり、罫線と記入欄は残る
  const isDetected = (object: DocObject): boolean => object.type === 'text' || object.meta.source === 'ocr-circle'
  const newCircle: PathObject = { ...circle, id: 'circle2' }
  const texts = replaceObjectsWhere(document, 'layer-candidates', isDetected, [label('text2', '62', 0, 0), newCircle], '文字を検出')!.apply(document)
  assert.deepEqual(ids(texts), ['rule', 'cell', 'text2', 'circle2'])
  // 追加したものは手前に積む
  const objects = texts.pages[0].layers.find((l) => l.kind === 'candidates')!.objects
  assert.ok(objects[2].z > objects[1].z && objects[3].z > objects[2].z)
  // 入れ替えるものがなければ null
  assert.equal(replaceObjectsWhere(document, 'layer-candidates', () => false, [], '何もしない'), null)
})

test('追加と複製: 手前に積み、複製は元と同じレイヤーにずらして置く。Undo で戻る', () => {
  const document = makeDocument([line('rule', 0, 0, 10, 0), label('text', '給与', 5, 6)], [label('done', '確定', 1, 1)])
  const objectsOf = (doc: DocumentModel, kind: 'candidates' | 'confirmed'): DocObject[] => doc.pages[0].layers.find((l) => l.kind === kind)!.objects

  const added = addObjects(document, 'layer-candidates', [label('new', 'テキスト', 100, 200)], 'テキストを追加')!.apply(document)
  assert.deepEqual(objectsOf(added, 'candidates').map((o) => o.id), ['rule', 'text', 'new'])
  assert.ok(objectsOf(added, 'candidates')[2].z > objectsOf(added, 'candidates')[1].z)
  assert.equal(addObjects(document, 'layer-candidates', [], '何もしない'), null)

  let counter = 0
  const history = new History()
  const { command, ids } = duplicateObjects(document, ['text', 'rule', 'done'], 3, -3, () => `copy-${++counter}`)
  const copied = history.execute(document, command!)
  assert.deepEqual(ids, ['copy-1', 'copy-2', 'copy-3'])
  assert.deepEqual(objectsOf(copied, 'candidates').map((o) => o.id), ['rule', 'text', 'copy-1', 'copy-2'])
  assert.deepEqual(objectsOf(copied, 'confirmed').map((o) => o.id), ['done', 'copy-3'])
  // 罫線は頂点を、Text は基準点をずらす。内容は元のまま
  const ruleCopy = objectsOf(copied, 'candidates')[2] as PathObject
  assert.deepEqual(ruleCopy.nodes.map((n) => [n.x, n.y]), [[3, -3], [13, -3]])
  const textCopy = objectsOf(copied, 'candidates')[3] as TextObject
  assert.equal(textCopy.text, '給与')
  assert.deepEqual(textCopy.transform, [1, 0, 0, 1, 8, 3])
  assert.deepEqual(history.undo(copied), document)
  // 対象がなければ null
  assert.equal(duplicateObjects(document, ['missing'], 1, 1).command, null)
})
