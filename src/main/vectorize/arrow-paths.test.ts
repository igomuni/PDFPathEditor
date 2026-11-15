import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Matrix } from '../../shared/model.ts'
import { ARROW_SOURCE, type PathDraft } from '../../shared/vectorizer.ts'
import { arrowsToDrafts, dropLinesOnArrows } from './arrow-paths.ts'

// 300dpi、ページの高さ 842pt
const pixelToPdf: Matrix = [0.24, 0, 0, -0.24, 0, 842]

const line = (x0: number, y0: number, x1: number, y1: number): PathDraft => ({
  type: 'path',
  role: 'frame',
  fieldCode: null,
  transform: [1, 0, 0, 1, 0, 0],
  tags: [],
  meta: {},
  nodes: [
    { x: x0, y: y0 },
    { x: x1, y: y1 }
  ],
  closed: false,
  fill: null,
  stroke: '#000000',
  strokeWidth: 0.3,
  dash: null,
  lineCap: 'butt'
})

test('arrowsToDrafts: 軸は折れ線、先端は塗りつぶした三角形の Path になる', () => {
  const drafts = arrowsToDrafts(
    [{ head: [{ x: 100, y: 500 }, { x: 130, y: 500 }, { x: 115, y: 525 }], shaft: [{ x: 115, y: 500 }, { x: 115, y: 450 }, { x: 80, y: 450 }], shaftWidth: 1 }],
    pixelToPdf
  )
  assert.equal(drafts.length, 2)
  const [shaft, head] = drafts
  assert.deepEqual([shaft.closed, shaft.fill, shaft.stroke, shaft.strokeWidth, shaft.role], [false, null, '#000000', 0.24, 'other'])
  assert.deepEqual(shaft.nodes, [{ x: 27.6, y: 722 }, { x: 27.6, y: 734 }, { x: 19.2, y: 734 }])
  assert.deepEqual([head.closed, head.fill, head.stroke], [true, '#000000', null])
  assert.deepEqual(head.nodes, [{ x: 24, y: 722 }, { x: 31.2, y: 722 }, { x: 27.6, y: 716 }])
  assert.ok(drafts.every((draft) => draft.meta.source === ARROW_SOURCE))
})

test('dropLinesOnArrows: 軸と重なる線だけを外す', () => {
  const arrows = arrowsToDrafts(
    [{ head: [{ x: 100, y: 500 }, { x: 130, y: 500 }, { x: 115, y: 525 }], shaft: [{ x: 115, y: 500 }, { x: 115, y: 450 }, { x: 80, y: 450 }], shaftWidth: 1 }],
    pixelToPdf
  )
  const kept = dropLinesOnArrows(
    [
      // 軸の縦の部分と同じ線、軸の一部だけの線
      line(27.5, 722.5, 27.7, 733.8),
      line(20, 734.2, 26, 734.1),
      // 軸に触れているが、先へ伸びている罫線
      line(19.2, 700, 19.2, 760),
      // 関係のない線
      line(100, 700, 200, 700)
    ],
    arrows
  )
  assert.deepEqual(kept.map((draft) => draft.nodes[0].x), [19.2, 100])
})
