import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GrayRaster } from '../../shared/vectorizer.ts'
import { findArrows } from './arrows.ts'

function blank(width: number, height: number): GrayRaster {
  return { width, height, data: new Uint8Array(width * height).fill(255) }
}

function fill(raster: GrayRaster, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) raster.data[y * raster.width + x] = 0
}

/** 下向きの三角形: 底辺が (cx - half, top)〜(cx + half, top)、先が (cx, top + length) */
function triangleDown(raster: GrayRaster, cx: number, top: number, half: number, length: number): void {
  for (let i = 0; i < length; i++) {
    const w = half * (1 - i / length)
    fill(raster, Math.round(cx - w), top + i, Math.max(1, Math.round(w * 2)), 1)
  }
}

/** 右向きの三角形: 底辺が x = left、先が (left + length, cy) */
function triangleRight(raster: GrayRaster, left: number, cy: number, half: number, length: number): void {
  for (let i = 0; i < length; i++) {
    const h = half * (1 - i / length)
    fill(raster, left + i, Math.round(cy - h), 1, Math.max(1, Math.round(h * 2)))
  }
}

const near = (value: number, expected: number, tolerance = 2): boolean => Math.abs(value - expected) <= tolerance

test('findArrows: 下向きの矢印。三角形の3点と、曲がり角のある軸を返す', () => {
  const raster = blank(300, 200)
  triangleDown(raster, 150, 120, 16, 30)
  // 軸: 三角形から上へ伸び、左へ曲がる
  fill(raster, 149, 60, 2, 60)
  fill(raster, 90, 60, 61, 2)
  // 矢印の先が触れている罫線
  fill(raster, 20, 150, 260, 4)
  const arrows = findArrows(raster)
  assert.equal(arrows.length, 1)
  const [b1, b2, tip] = arrows[0].head
  assert.ok(near(b1.x, 134) && near(b1.y, 120) && near(b2.x, 166) && near(b2.y, 120), JSON.stringify(arrows[0].head))
  assert.ok(near(tip.x, 150) && near(tip.y, 150, 3), JSON.stringify(tip))
  const shaft = arrows[0].shaft
  assert.equal(shaft.length, 3, JSON.stringify(shaft))
  assert.ok(near(shaft[0].x, 150) && near(shaft[0].y, 120), JSON.stringify(shaft[0]))
  assert.ok(near(shaft[1].x, 150) && near(shaft[1].y, 61), JSON.stringify(shaft[1]))
  assert.ok(near(shaft[2].x, 90) && near(shaft[2].y, 61), JSON.stringify(shaft[2]))
  assert.equal(arrows[0].shaftWidth, 2)
})

test('findArrows: 右向きの矢印。まっすぐな軸は2点。枠に突き当たったところで止まる', () => {
  const raster = blank(300, 120)
  triangleRight(raster, 200, 60, 12, 24)
  fill(raster, 100, 59, 100, 2)
  // 軸の始まりが突き当たっている枠の縦線
  fill(raster, 98, 20, 2, 80)
  const arrows = findArrows(raster)
  assert.equal(arrows.length, 1)
  assert.ok(near(arrows[0].head[2].x, 224, 3) && near(arrows[0].head[2].y, 60), JSON.stringify(arrows[0].head))
  const shaft = arrows[0].shaft
  assert.equal(shaft.length, 2, JSON.stringify(shaft))
  assert.ok(near(shaft[0].x, 200) && near(shaft[1].x, 100, 3) && near(shaft[1].y, 60), JSON.stringify(shaft))
})

test('findArrows: 軸のない三角形、四角、太い線、線だけのものは矢印にしない', () => {
  const raster = blank(400, 200)
  triangleDown(raster, 60, 40, 16, 30)
  // 四角に線が付いたもの
  fill(raster, 140, 40, 30, 30)
  fill(raster, 154, 10, 2, 30)
  // 太い線と細い線
  fill(raster, 220, 40, 150, 12)
  fill(raster, 220, 100, 150, 2)
  assert.deepEqual(findArrows(raster), [])
})

test('findArrows: 軸が薄い灰色でも、たどれる', () => {
  const raster = blank(200, 200)
  triangleDown(raster, 100, 120, 14, 24)
  for (let y = 50; y < 120; y++) raster.data[y * raster.width + 100] = 180
  for (let x = 100; x < 160; x++) raster.data[50 * raster.width + x] = 180
  const arrows = findArrows(raster)
  assert.equal(arrows.length, 1)
  assert.equal(arrows[0].shaft.length, 3, JSON.stringify(arrows[0].shaft))
  assert.ok(near(arrows[0].shaft[2].x, 160) && near(arrows[0].shaft[2].y, 50), JSON.stringify(arrows[0].shaft))
  // 濃さ 180 の1画素の線は、0.3 画素ぶんの太さ
  assert.ok(Math.abs(arrows[0].shaftWidth - 75 / 255) < 0.01, String(arrows[0].shaftWidth))
})
