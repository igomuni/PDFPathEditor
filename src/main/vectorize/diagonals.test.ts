import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GrayRaster } from '../../shared/vectorizer.ts'
import { findSlantedShapes } from './diagonals.ts'
import { detectLines } from './line-detector.ts'
import type { PathDraft } from '../../shared/vectorizer.ts'
import { slantedToDrafts, tagRoundRects } from './slanted-paths.ts'

function blank(width: number, height: number): GrayRaster {
  return { width, height, data: new Uint8Array(width * height).fill(255) }
}
function fill(raster: GrayRaster, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) raster.data[y * raster.width + x] = 0
}
/** 太さ 2 の線 */
function line(raster: GrayRaster, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2)
  for (let i = 0; i <= steps; i++) fill(raster, Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), 2, 2)
}
/** 中心 (cx, cy)、半径 r の円弧(a0〜a1 度。画像の座標で、y は下向き) */
function arc(raster: GrayRaster, cx: number, cy: number, r: number, a0: number, a1: number): void {
  for (let a = a0; a <= a1; a += 0.25) fill(raster, Math.round(cx + r * Math.cos((a * Math.PI) / 180)), Math.round(cy + r * Math.sin((a * Math.PI) / 180)), 2, 2)
}
const near = (value: number, expected: number, tolerance = 3): boolean => Math.abs(value - expected) <= tolerance

test('斜線: 枠の角から角への線を見つける。途中の罫線で切れていても1本にする', () => {
  const raster = blank(500, 300)
  // 枠(100,50)-(400,250) と、途中の縦線
  fill(raster, 100, 50, 301, 3)
  fill(raster, 100, 250, 301, 3)
  fill(raster, 100, 50, 3, 203)
  fill(raster, 398, 50, 3, 203)
  fill(raster, 250, 50, 3, 203)
  line(raster, 102, 250, 398, 52)
  const { diagonals, arcs } = findSlantedShapes(raster, detectLines(raster))
  assert.equal(arcs.length, 0)
  assert.equal(diagonals.length, 1, JSON.stringify(diagonals))
  const [d] = diagonals
  const [left, right] = d.x0 < d.x1 ? [{ x: d.x0, y: d.y0 }, { x: d.x1, y: d.y1 }] : [{ x: d.x1, y: d.y1 }, { x: d.x0, y: d.y0 }]
  assert.ok(near(left.x, 103, 6) && near(left.y, 250, 6) && near(right.x, 398, 6) && near(right.y, 53, 6), JSON.stringify(d))
  assert.ok(d.thickness > 1 && d.thickness < 4, String(d.thickness))
})

test('斜線: 短い斜めの線(文字の画)、水平・垂直の細い線は拾わない', () => {
  const raster = blank(400, 200)
  line(raster, 50, 50, 70, 80)
  line(raster, 100, 100, 300, 101)
  line(raster, 350, 20, 351, 180)
  assert.deepEqual(findSlantedShapes(raster, detectLines(raster)).diagonals, [])
})

test('角丸: 罫線の端につながる4分の1の円弧を見つけ、ベジェ曲線の Path にする', () => {
  const raster = blank(400, 300)
  // 角丸の枠の左上: 上の線は x=90 から、左の線は y=80 から。角の半径 40
  fill(raster, 90, 40, 250, 3)
  fill(raster, 50, 80, 3, 180)
  arc(raster, 91, 81, 40, 180, 270)
  // 罫線につながらない円弧(括弧のようなもの)
  arc(raster, 300, 200, 40, 150, 210)
  const shapes = findSlantedShapes(raster, detectLines(raster))
  assert.equal(shapes.arcs.length, 1, JSON.stringify(shapes))
  const [found] = shapes.arcs
  assert.ok(near(found.cx, 92) && near(found.cy, 82) && near(found.r, 40), JSON.stringify(found))
  assert.ok(near(found.hEnd.y, 41.5, 1) && near(found.vEnd.x, 51.5, 1), JSON.stringify(found))
  const [draft] = slantedToDrafts(shapes, [0.24, 0, 0, -0.24, 0, 842])
  assert.equal(draft.role, 'frame')
  assert.equal(draft.nodes.length, 2)
  assert.ok(draft.nodes[0].out && draft.nodes[1].in)
  // 水平の罫線の側の制御点は、同じ高さで角のほうへ出る
  assert.equal(draft.nodes[0].out![1], draft.nodes[0].y)
  assert.ok(draft.nodes[0].out![0] < draft.nodes[0].x)
  assert.equal(draft.nodes[1].in![0], draft.nodes[1].x)
})

test('角丸の枠: 角の円弧と、つながる罫線を同じグループにする。関係のない罫線には印を付けない', () => {
  const rule = (x0: number, y0: number, x1: number, y1: number): PathDraft => ({
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
    strokeWidth: 0.7,
    dash: null,
    lineCap: 'butt'
  })
  const corner = (hx: number, hy: number, vx: number, vy: number): PathDraft => ({ ...rule(hx, hy, vx, vy), meta: { source: 'corner-detect' } })
  // 枠 (100,100)-(300,200)、角の半径 10。上の辺と左右の辺、左上と右上の角
  const lines = [rule(110, 200, 290, 200), rule(100, 100, 100, 190), rule(300, 100, 300, 190), rule(100, 150, 300, 150), rule(400, 100, 400, 190)]
  const slanted = [corner(110, 200, 100, 190), corner(290, 200, 300, 190), { ...rule(100, 100, 300, 150), meta: { source: 'diagonal-detect' } }]
  const tagged = tagRoundRects(lines, slanted)
  const group = (draft: PathDraft): string | undefined => (draft.meta.shape as { group: string } | undefined)?.group
  // 2つの角は上の辺を共有するので、同じ枠
  assert.ok(group(tagged.slanted[0]) !== undefined && group(tagged.slanted[0]) === group(tagged.slanted[1]))
  assert.deepEqual(tagged.lines.map((line) => group(line) === group(tagged.slanted[0])), [true, true, true, false, false])
  assert.equal(group(tagged.slanted[2]), undefined)
  assert.deepEqual((tagged.slanted[0].meta.shape as { kind: string }).kind, 'roundRect')
})
