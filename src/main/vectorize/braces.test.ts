import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GrayRaster } from '../../shared/vectorizer.ts'
import { findBraces } from './braces.ts'
import { bracesToDrafts } from './slanted-paths.ts'

function blank(width: number, height: number): GrayRaster {
  return { width, height, data: new Uint8Array(width * height).fill(255) }
}
function fill(raster: GrayRaster, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) raster.data[y * raster.width + x] = 0
}
/** 「｝」: 縦の線 x、上下のかぎは左へ、突起は右へ */
function closing(raster: GrayRaster, x: number, top: number, bottom: number): void {
  fill(raster, x, top, 3, bottom - top)
  fill(raster, x - 9, top, 9, 3)
  fill(raster, x - 9, bottom - 3, 9, 3)
  fill(raster, x + 3, Math.round((top + bottom) / 2) - 1, 8, 3)
}

test('波括弧: 縦の線、上下のかぎ、中央の突起を見つける。向きも分かる', () => {
  const raster = blank(400, 400)
  closing(raster, 100, 50, 290)
  // 「｛」: 左右を逆にしたもの
  fill(raster, 300, 100, 3, 100)
  fill(raster, 303, 100, 9, 3)
  fill(raster, 303, 197, 9, 3)
  fill(raster, 292, 149, 8, 3)
  const braces = findBraces(raster)
  assert.equal(braces.length, 2, JSON.stringify(braces))
  const [right, left] = braces
  assert.deepEqual([right.x, right.top, right.bottom, right.hookX, right.tipX, right.thickness], [101.5, 51.5, 288.5, 91, 111, 3])
  assert.ok(Math.abs(right.tipY - 170.5) <= 1, String(right.tipY))
  assert.ok(left.hookX > left.x && left.tipX < left.x)
  const [draft] = bracesToDrafts([right], [0.24, 0, 0, -0.24, 0, 595])
  assert.equal(draft.nodes.length, 7)
  assert.deepEqual((draft.meta.shape as { kind: string }).kind, 'brace')
  assert.deepEqual([draft.nodes[0].x, draft.nodes[1].x, draft.nodes[3].x], [21.84, 24.36, 26.64])
})

test('波括弧: 縦の線だけ、かぎだけ(コの字)、突起が中央にないもの、表の罫線は拾わない', () => {
  const raster = blank(600, 400)
  fill(raster, 50, 50, 3, 200)
  // コの字(突起なし)
  fill(raster, 150, 50, 3, 200)
  fill(raster, 141, 50, 9, 3)
  fill(raster, 141, 247, 9, 3)
  // 突起が上に寄っている
  fill(raster, 250, 50, 3, 200)
  fill(raster, 241, 50, 9, 3)
  fill(raster, 241, 247, 9, 3)
  fill(raster, 253, 80, 8, 3)
  // 表(格子)
  fill(raster, 350, 50, 200, 3)
  fill(raster, 350, 247, 200, 3)
  fill(raster, 350, 50, 3, 200)
  fill(raster, 547, 50, 3, 200)
  fill(raster, 450, 50, 3, 200)
  assert.deepEqual(findBraces(raster), [])
})
