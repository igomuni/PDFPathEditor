import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DocObject, Layer, Page, PathObject } from './model.ts'
import { braceNodes, circleNodes, collectShapes, createShape, roundRectNodes, shapeOf } from './shapes.ts'

const path = (id: string, x: number, y: number, meta: Record<string, unknown>): PathObject => ({
  id,
  type: 'path',
  role: 'frame',
  fieldCode: null,
  transform: [1, 0, 0, 1, 0, 0],
  z: 0,
  tags: [],
  meta,
  nodes: [
    { x, y },
    { x: x + 10, y }
  ],
  closed: false,
  fill: null,
  stroke: '#000000',
  strokeWidth: 0.5,
  dash: null,
  lineCap: 'butt'
})
const page = (objects: DocObject[], locked: DocObject[] = []): Page =>
  ({
    id: 'page-1',
    sourceId: 'src-1',
    sourcePageNumber: 1,
    mediaBox: [0, 0, 595, 842],
    layers: [
      { id: 'c', kind: 'candidates', name: '', locked: false, visible: true, opacity: 1, objects } as Layer,
      { id: 'b', kind: 'background', name: '', locked: true, visible: true, opacity: 1, objects: locked } as Layer
    ]
  }) as Page
const boundsOf = (object: DocObject): [number, number, number, number] => {
  const n = (object as PathObject).nodes ?? [{ x: object.transform[4], y: object.transform[5] }]
  return [Math.min(...n.map((p) => p.x)), Math.min(...n.map((p) => p.y)), Math.max(...n.map((p) => p.x)), Math.max(...n.map((p) => p.y))]
}
const ids = (): (() => string) => {
  let n = 0
  return () => `id-${++n}`
}

test('shapeOf: 正しい印だけを読む', () => {
  assert.deepEqual(shapeOf({ meta: { shape: { kind: 'arrow', group: 'a1' } } }), { kind: 'arrow', group: 'a1' })
  assert.equal(shapeOf({ meta: {} }), null)
  assert.equal(shapeOf({ meta: { shape: { kind: 'triangle', group: 'x' } } }), null)
  assert.equal(shapeOf({ meta: { shape: { kind: 'arrow' } } }), null)
  assert.equal(shapeOf({ meta: { shape: 'arrow' } }), null)
})

test('collectShapes: グループごとにまとめ、種類の順・上からの順に並べる', () => {
  const shapes = collectShapes(
    page(
      [
        path('line', 0, 0, {}),
        path('a-shaft', 100, 500, { shape: { kind: 'arrow', group: 'a1' } }),
        path('a-head', 110, 500, { shape: { kind: 'arrow', group: 'a1' } }),
        path('b-shaft', 100, 700, { shape: { kind: 'arrow', group: 'a2' } }),
        path('corner', 50, 800, { shape: { kind: 'roundRect', group: 'r1' } }),
        { ...createShape('star', { cx: 300, cy: 300, size: 5, newId: ids(), fontFamily: 'Noto Sans JP', fontWeight: 400 })[0], id: 'star' }
      ],
      [path('locked', 0, 0, { shape: { kind: 'arrow', group: 'a9' } })]
    ),
    boundsOf
  )
  assert.deepEqual(
    shapes.map((shape) => [shape.kind, shape.ids, shape.detail]),
    [
      ['roundRect', ['corner'], ''],
      ['arrow', ['b-shaft'], ''],
      ['arrow', ['a-shaft', 'a-head'], ''],
      ['star', ['star'], '★']
    ]
  )
})

test('図形の頂点: 角丸の四角は8頂点、円は4頂点、波括弧は中央がとがる', () => {
  const rect = roundRectNodes(0, 0, 100, 40, 10)
  assert.equal(rect.length, 8)
  assert.deepEqual([rect[0].x, rect[0].y, rect[1].x, rect[1].y], [10, 40, 90, 40])
  assert.deepEqual(rect[1].out, [95.523, 40])
  assert.deepEqual([rect[2].x, rect[2].y], [100, 30])
  // 半径は、短い辺の半分まで
  assert.equal(roundRectNodes(0, 0, 100, 10, 30)[0].x, 5)
  const circle = circleNodes(50, 50, 10)
  assert.deepEqual(circle.map((n) => [n.x, n.y]), [[60, 50], [50, 60], [40, 50], [50, 40]])
  const brace = braceNodes(100, 200, 100, -6)
  assert.deepEqual([brace[0].x, brace[0].y, brace[2].x, brace[2].y, brace[4].x, brace[4].y], [103, 200, 97, 150, 103, 100])
})

test('createShape: 図形ごとに新しいグループの印を付ける。矢印は軸と三角形、星は Text', () => {
  const options = { cx: 100, cy: 100, size: 8, newId: ids(), fontFamily: 'Noto Sans JP', fontWeight: 400 }
  const arrow = createShape('arrow', options)
  assert.equal(arrow.length, 2)
  assert.deepEqual(shapeOf(arrow[0]), shapeOf(arrow[1]))
  assert.deepEqual([(arrow[1] as PathObject).closed, (arrow[1] as PathObject).fill], [true, '#000000'])
  const star = createShape('star', options)[0]
  assert.deepEqual([star.type, star.type === 'text' && star.text, shapeOf(star)?.kind], ['text', '★', 'star'])
  assert.notEqual(shapeOf(star)!.group, shapeOf(arrow[0])!.group)
  for (const kind of ['roundRect', 'brace', 'circle'] as const) {
    const [shape] = createShape(kind, options)
    assert.equal(shape.type, 'path')
    assert.equal(shapeOf(shape)?.kind, kind)
  }
})
