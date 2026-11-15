import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DocObject, DocumentModel, ImageObject, Layer, LayerKind, PathObject, TextObject } from '../../shared/model.ts'
import { setObjectsVisible } from './commands.ts'
import { History } from './history.ts'
import {
  buildRows,
  describeObject,
  filteredIds,
  isFiltering,
  isVisible,
  matchesFilter,
  NO_FILTER,
  revealRect,
  visibleRange,
  type ObjectFilter
} from './objectList.ts'

const base = { fieldCode: null, transform: [1, 0, 0, 1, 0, 0] as PathObject['transform'], tags: [], meta: {} }

function line(id: string, z: number, patch: Partial<PathObject> = {}): PathObject {
  return {
    ...base,
    id,
    z,
    type: 'path',
    role: 'frame',
    nodes: [
      { x: 0, y: 5 },
      { x: 10, y: 5 }
    ],
    closed: false,
    fill: null,
    stroke: '#000000',
    strokeWidth: 1,
    dash: null,
    lineCap: 'butt',
    ...patch
  }
}

function text(id: string, z: number, value: string, patch: Partial<TextObject> = {}): TextObject {
  return {
    ...base,
    id,
    z,
    type: 'text',
    role: 'label',
    text: value,
    fontFamily: 'Noto Sans JP',
    fontWeight: 400,
    fontSize: 10,
    letterSpacing: 0,
    fill: '#000000',
    align: 'left',
    outline: false,
    ...patch
  }
}

const image: ImageObject = { ...base, id: 'bg', z: 0, type: 'image', role: 'background', asset: 'assets/page-0002.png', pixelWidth: 10, pixelHeight: 10 }

function layer(kind: LayerKind, objects: DocObject[], locked = false): Layer {
  return { id: `layer-${kind}`, kind, name: kind, locked, visible: true, opacity: 1, objects }
}

function makeDocument(candidates: DocObject[], confirmed: DocObject[] = []): DocumentModel {
  return {
    version: 1,
    createdAt: '',
    source: { file: '', originalFileName: '', sha256: '', byteLength: 0, pageCount: 1, encrypted: false, encryptFilter: null, permissions: null },
    pages: [
      {
        id: 'page-1',
        sourcePageNumber: 2,
        mediaBox: [0, 0, 595, 842],
        layers: [layer('background', [image], true), layer('candidates', candidates), layer('confirmed', confirmed), layer('diff', [], true)]
      }
    ]
  }
}

const filter = (patch: Partial<ObjectFilter>): ObjectFilter => ({ ...NO_FILTER, ...patch })

test('describeObject: 種別ごとの内容', () => {
  assert.equal(describeObject(text('t', 0, '給与')), '給与')
  assert.equal(describeObject(image), 'page-0002.png')
  assert.equal(describeObject(line('h', 0)), '横線')
  assert.equal(describeObject(line('d', 0, { dash: [1, 1] })), '横線(点線)')
  assert.equal(describeObject(line('v', 0, { nodes: [{ x: 3, y: 0 }, { x: 3, y: 9 }] })), '縦線')
  assert.equal(describeObject(line('p', 0, { nodes: [{ x: 0, y: 0 }, { x: 3, y: 9 }] })), 'Path')
  assert.equal(describeObject(line('c', 0, { role: 'inputCell', closed: true, stroke: null })), '記入欄')
})

test('絞り込み: 種別・役割・項目コードの有無・文字列', () => {
  const code = text('code', 0, 'G44', { role: 'fieldCode', fieldCode: 'G44' })
  const label = text('label', 0, '給与')
  const rule = line('rule', 0)
  assert.equal(isFiltering(NO_FILTER), false)
  assert.equal(isFiltering(filter({ query: ' ' })), false)
  assert.equal(isFiltering(filter({ code: 'with' })), true)
  assert.equal(matchesFilter(rule, filter({ types: new Set(['text']) })), false)
  assert.equal(matchesFilter(label, filter({ types: new Set(['text']) })), true)
  assert.equal(matchesFilter(label, filter({ role: 'fieldCode' })), false)
  assert.equal(matchesFilter(code, filter({ role: 'fieldCode' })), true)
  assert.equal(matchesFilter(label, filter({ code: 'with' })), false)
  assert.equal(matchesFilter(label, filter({ code: 'without' })), true)
  assert.equal(matchesFilter(code, filter({ query: 'g4' })), true)
  assert.equal(matchesFilter(label, filter({ query: '与' })), true)
  // 項目コードでも探せる
  assert.equal(matchesFilter(line('cell', 0, { fieldCode: 'G44' }), filter({ query: 'G44' })), true)
  assert.equal(matchesFilter(rule, filter({ query: 'G44' })), false)
})

test('buildRows: 手前のレイヤーとオブジェクトを上に並べ、折りたたみと絞り込みを反映する', () => {
  const document = makeDocument([text('a', 1, 'A'), line('b', 5), text('c', 3, 'C')], [text('d', 0, 'D')])
  const page = document.pages[0]
  const ids = (rows: ReturnType<typeof buildRows>): string[] => rows.map((row) => (row.kind === 'layer' ? `[${row.layer.kind} ${row.shown}/${row.total}]` : row.object.id))
  assert.deepEqual(ids(buildRows(page, NO_FILTER, new Set())), ['[confirmed 1/1]', 'd', '[candidates 3/3]', 'b', 'c', 'a', '[background 1/1]', 'bg'])
  assert.deepEqual(ids(buildRows(page, NO_FILTER, new Set(['layer-candidates']))), ['[confirmed 1/1]', 'd', '[candidates 3/3]', '[background 1/1]', 'bg'])
  assert.deepEqual(ids(buildRows(page, filter({ types: new Set(['text']) }), new Set())), ['[confirmed 1/1]', 'd', '[candidates 2/3]', 'c', 'a', '[background 0/1]'])
  // まとめて操作する対象には、ロックされたレイヤーのものを含めない
  assert.deepEqual(filteredIds(page, NO_FILTER), ['a', 'b', 'c', 'd'])
  assert.deepEqual(filteredIds(page, filter({ types: new Set(['path']) })), ['b'])
})

test('setObjectsVisible: 非表示にして保存でき、表示に戻すと visible が消える。Undo で戻る', () => {
  const document = makeDocument([text('a', 0, 'A'), line('b', 1)], [text('c', 0, 'C')])
  const history = new History()
  const hidden = history.execute(document, setObjectsVisible(document, ['a', 'c', 'bg'], false)!)
  const find = (doc: DocumentModel, id: string): DocObject => doc.pages[0].layers.flatMap((l) => l.objects).find((o) => o.id === id)!
  assert.equal(isVisible(find(hidden, 'a')), false)
  assert.equal(isVisible(find(hidden, 'c')), false)
  assert.equal(isVisible(find(hidden, 'b')), true)
  // ロックされた背景レイヤーのオブジェクトは変えない(レイヤーの表示切替を使う)
  assert.equal(isVisible(find(hidden, 'bg')), true)
  // すでに同じ状態なら何もしない
  assert.equal(setObjectsVisible(hidden, ['a'], false), null)
  assert.equal(setObjectsVisible(hidden, ['b'], true), null)

  const shown = setObjectsVisible(hidden, ['a'], true)!.apply(hidden)
  assert.equal('visible' in find(shown, 'a'), false)
  assert.deepEqual(find(shown, 'a'), find(document, 'a'))
  assert.deepEqual(history.undo(hidden), document)
})

test('revealRect: 画面の外にあるときだけ中央へ動かし、拡大率は変えない', () => {
  const view = { x: 0, y: 0, scale: 2 }
  const viewport = { width: 400, height: 200 }
  // 表示範囲は SVG座標で 200 × 100
  assert.equal(revealRect(view, viewport, [50, 30, 60, 40]), view)
  assert.deepEqual(revealRect(view, viewport, [300, 400, 320, 410]), { x: 210, y: 355, scale: 2 })
  // 端にかかっているときも動かす
  assert.deepEqual(revealRect(view, viewport, [195, 30, 205, 40]), { x: 100, y: -15, scale: 2 })
})

test('visibleRange: 表示する行の範囲', () => {
  assert.deepEqual(visibleRange(0, 220, 22, 1000, 2), [0, 12])
  assert.deepEqual(visibleRange(2200, 220, 22, 1000, 2), [98, 112])
  assert.deepEqual(visibleRange(99999, 220, 22, 30, 2), [30, 30])
  assert.deepEqual(visibleRange(0, 220, 22, 3, 2), [0, 3])
})
