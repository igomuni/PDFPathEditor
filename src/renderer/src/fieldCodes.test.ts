import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DocObject, DocumentModel, Layer, LayerKind, PathObject, Rect, TextObject } from '../../shared/model.ts'
import { assignFieldCodes, updateObjects } from './commands.ts'
import { normalizeFieldCode, planFieldCodes } from './fieldCodes.ts'
import { History } from './history.ts'

function line(id: string, x0: number, y0: number, x1: number, y1: number, dash: number[] | null = null): PathObject {
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
    dash,
    lineCap: 'butt'
  }
}

function text(id: string, value: string, x: number, y: number): TextObject {
  return {
    id,
    type: 'text',
    role: 'label',
    fieldCode: null,
    transform: [1, 0, 0, 1, x, y],
    z: 0,
    tags: [],
    meta: {},
    text: value,
    fontFamily: 'Noto Sans JP',
    fontWeight: 400,
    fontSize: 8,
    letterSpacing: 0,
    fill: '#000000',
    align: 'left',
    outline: false
  }
}

/** テスト用の外形。文字は1字あたり 0.6em の幅とする */
function boundsOf(object: DocObject): Rect {
  if (object.type === 'path') {
    const xs = object.nodes.map((node) => node.x)
    const ys = object.nodes.map((node) => node.y)
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  }
  const [, , , , x, y] = object.transform
  const width = object.type === 'text' ? object.text.length * object.fontSize * 0.6 : 1
  const height = object.type === 'text' ? object.fontSize : 1
  return [x, y, x + width, y + height]
}

function layer(kind: LayerKind, objects: DocObject[]): Layer {
  return { id: `layer-${kind}`, kind, name: kind, locked: false, visible: true, opacity: 1, objects }
}

function makeDocument(candidates: DocObject[], confirmed: DocObject[] = []): DocumentModel {
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
        layers: [layer('background', []), layer('candidates', candidates), layer('confirmed', confirmed)]
      }
    ]
  }
}

/**
 * 1行の様式: | 給与(0-60) | コード(60-84) | 記入欄(84-184) |、高さ 100〜116。
 * 縦線は x = 0, 60, 84, 184。
 */
function row(code: string, extra: DocObject[] = []): DocObject[] {
  return [
    line('top', 0, 116, 184, 116),
    line('bottom', 0, 100, 184, 100),
    line('v0', 0, 100, 0, 116),
    line('v1', 60, 100, 60, 116),
    line('v2', 84, 100, 84, 116),
    line('v3', 184, 100, 184, 116),
    text('label', '給与', 10, 104),
    text('code', code, 65, 104),
    ...extra
  ]
}

const objectsOf = (document: DocumentModel, kind: LayerKind): DocObject[] =>
  document.pages[0].layers.find((candidate) => candidate.kind === kind)!.objects
const find = (document: DocumentModel, id: string): DocObject =>
  document.pages[0].layers.flatMap((candidate) => candidate.objects).find((object) => object.id === id)!

let counter = 0
const newId = (): string => `new-${++counter}`

test('normalizeFieldCode: 項目コードの形だけを通し、OCR の読み違いを直す', () => {
  assert.equal(normalizeFieldCode('G01'), 'G01')
  assert.equal(normalizeFieldCode(' G101 '), 'G101')
  assert.equal(normalizeFieldCode('GO6'), 'G06')
  assert.equal(normalizeFieldCode('GI7'), 'G17')
  assert.equal(normalizeFieldCode('z01'), 'Z01')
  assert.equal(normalizeFieldCode('G21|'), 'G21')
  assert.equal(normalizeFieldCode('給与'), null)
  assert.equal(normalizeFieldCode('12'), null)
  assert.equal(normalizeFieldCode('000'), null)
  assert.equal(normalizeFieldCode('G1'), null)
  assert.equal(normalizeFieldCode('G12345'), null)
})

test('印字コードに fieldCode と role を付け、右隣の枠に記入欄を作る', () => {
  const document = makeDocument(row('G44'))
  const { command, summary } = assignFieldCodes(document, boundsOf, newId)
  assert.deepEqual(summary, { codes: 1, tagged: 1, cells: 1 })
  const next = command!.apply(document)

  const code = find(next, 'code')
  assert.equal(code.fieldCode, 'G44')
  assert.equal(code.role, 'fieldCode')
  // 項目名は自動では付けない
  assert.equal(find(next, 'label').fieldCode, null)
  assert.equal(find(next, 'top').fieldCode, null)

  const cell = objectsOf(next, 'candidates').find((object) => object.role === 'inputCell') as PathObject
  assert.equal(cell.fieldCode, 'G44')
  assert.equal(cell.closed, true)
  assert.equal(cell.stroke, null)
  assert.equal(cell.fill, null)
  // 罫線(線幅1)の内側
  assert.deepEqual(
    cell.nodes.map((node) => [node.x, node.y]),
    [
      [84.5, 100.5],
      [183.5, 100.5],
      [183.5, 115.5],
      [84.5, 115.5]
    ]
  )
  // 手前に積む
  assert.ok(cell.z > code.z)
})

test('記入欄の中のオブジェクトに同じ fieldCode を付ける。点線は枠の区切りにしない', () => {
  const document = makeDocument(row('GO6', [text('zeros', '00', 160, 104), line('dots', 150, 100, 150, 116, [0.5, 1])]))
  const { command, summary } = assignFieldCodes(document, boundsOf, newId)
  assert.deepEqual(summary, { codes: 1, tagged: 3, cells: 1 })
  const next = command!.apply(document)
  // 読み違いは正規形で付ける(文字列は変えない)
  assert.equal(find(next, 'code').fieldCode, 'G06')
  assert.equal((find(next, 'code') as TextObject).text, 'GO6')
  assert.equal(find(next, 'zeros').fieldCode, 'G06')
  assert.equal(find(next, 'zeros').role, 'label')
  assert.equal(find(next, 'dots').fieldCode, 'G06')
  const cell = objectsOf(next, 'candidates').find((object) => object.role === 'inputCell') as PathObject
  assert.equal(cell.nodes[1].x, 183.5)
})

test('枠の中に他の文字があるコード、枠で囲まれていないコードは対象にしない', () => {
  const withNeighbour = makeDocument(row('A12', [text('other', 'B', 76, 104)]))
  assert.equal(assignFieldCodes(withNeighbour, boundsOf, newId).command, null)

  const noFrame = makeDocument([text('code', 'G01', 300, 300)])
  const result = assignFieldCodes(noFrame, boundsOf, newId)
  assert.equal(result.command, null)
  assert.deepEqual(result.summary, { codes: 0, tagged: 0, cells: 0 })
})

test('右隣も印字コードの枠なら記入欄を作らない', () => {
  const document = makeDocument([
    line('top', 0, 116, 48, 116),
    line('bottom', 0, 100, 48, 100),
    line('v0', 0, 100, 0, 116),
    line('v1', 24, 100, 24, 116),
    line('v2', 48, 100, 48, 116),
    text('a', 'G01', 5, 104),
    text('b', 'G02', 29, 104)
  ])
  const { command, summary } = assignFieldCodes(document, boundsOf, newId)
  assert.deepEqual(summary, { codes: 2, tagged: 2, cells: 0 })
  const next = command!.apply(document)
  assert.equal(find(next, 'a').fieldCode, 'G01')
  assert.equal(find(next, 'b').fieldCode, 'G02')
  assert.equal(objectsOf(next, 'candidates').length, 7)
})

test('やり直しても重複せず、人が付けた項目コードは上書きしない', () => {
  const history = new History()
  const first = makeDocument(row('G44', [text('zeros', '00', 160, 104)]))
  let document = history.execute(first, assignFieldCodes(first, boundsOf, newId).command!)
  // 2回目は変更なし
  assert.equal(assignFieldCodes(document, boundsOf, newId).command, null)

  // 人がコードを直して記入欄を消し、もう一度割り当てる
  const cellId = objectsOf(document, 'candidates').find((object) => object.role === 'inputCell')!.id
  document = history.execute(document, updateObjects(document, ['code'], { fieldCode: 'G45' })!)
  document = {
    ...document,
    pages: document.pages.map((page) => ({
      ...page,
      layers: page.layers.map((candidate) => ({
        ...candidate,
        objects: candidate.objects.filter((object) => object.id !== cellId)
      }))
    }))
  }
  const again = assignFieldCodes(document, boundsOf, newId)
  assert.deepEqual(again.summary, { codes: 1, tagged: 0, cells: 1 })
  const next = again.command!.apply(document)
  assert.equal(find(next, 'code').fieldCode, 'G45')
  // 中の文字は前回のまま、作り直した記入欄は直したコードになる
  assert.equal(find(next, 'zeros').fieldCode, 'G44')
  assert.equal(objectsOf(next, 'candidates').find((object) => object.role === 'inputCell')!.fieldCode, 'G45')
})

test('割り当ては1回の Undo で元に戻る', () => {
  const history = new History()
  const document = makeDocument(row('G44'))
  const next = history.execute(document, assignFieldCodes(document, boundsOf, newId).command!)
  assert.equal(objectsOf(next, 'candidates').length, 9)
  assert.deepEqual(history.undo(next), document)
})

test('確定レイヤーのコードには、確定レイヤーに記入欄を作る', () => {
  const [top, bottom, v0, v1, v2, v3, label, code] = row('G44')
  const document = makeDocument([top, bottom, v0, v1, v2, v3, label], [code])
  const plan = planFieldCodes(document.pages[0], boundsOf, newId)
  assert.deepEqual([...plan.additions.keys()], ['layer-confirmed'])
})

test('updateObjects: 項目コードと役割を変え、解除もできる', () => {
  const document = makeDocument(row('G44'))
  const tagged = updateObjects(document, ['label', 'top'], { fieldCode: 'G44' })!.apply(document)
  assert.equal(find(tagged, 'label').fieldCode, 'G44')
  assert.equal(find(tagged, 'top').fieldCode, 'G44')
  assert.equal(find(tagged, 'code').fieldCode, null)
  // 変わらないなら null
  assert.equal(updateObjects(tagged, ['label'], { fieldCode: 'G44' }), null)

  const cleared = updateObjects(tagged, ['label'], { fieldCode: null })!.apply(tagged)
  assert.equal(find(cleared, 'label').fieldCode, null)
  const role = updateObjects(cleared, ['label'], { role: 'formId' })!.apply(cleared)
  assert.equal(find(role, 'label').role, 'formId')
})
