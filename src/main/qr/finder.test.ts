import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GrayRaster } from '../../shared/vectorizer.ts'
import { findFinderPatterns, findQrCodes } from './finder.ts'

function blank(width: number, height: number): GrayRaster {
  return { width, height, data: new Uint8Array(width * height).fill(255) }
}

function fill(raster: GrayRaster, x0: number, y0: number, w: number, h: number, value = 0): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) raster.data[y * raster.width + x] = value
}

/** 切り出しシンボル(7×7モジュール)を、左上 (x, y) に描く */
function finder(raster: GrayRaster, x: number, y: number, m: number): void {
  fill(raster, x, y, 7 * m, 7 * m)
  fill(raster, x + m, y + m, 5 * m, 5 * m, 255)
  fill(raster, x + 2 * m, y + 2 * m, 3 * m, 3 * m)
}

/** n×n モジュールの QR 風の絵を、左上 (x, y) に描く。中身は決まった並びの市松もどき */
function qr(raster: GrayRaster, x: number, y: number, m: number, n: number, missing: 'br' | 'tl' = 'br'): void {
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if ((r * 7 + c * 13 + ((r * c) % 5)) % 3 === 0) fill(raster, x + c * m, y + r * m, m, m)
  const far = (n - 7) * m
  const corners: [number, number][] = missing === 'br' ? [[0, 0], [far, 0], [0, far]] : [[far, 0], [0, far], [far, far]]
  for (const [dx, dy] of corners) {
    // シンボルのまわり1モジュールは白
    fill(raster, Math.max(x, x + dx - m), Math.max(y, y + dy - m), 9 * m - (dx === 0 ? m : 0), 9 * m - (dy === 0 ? m : 0), 255)
    finder(raster, x + dx, y + dy, m)
  }
}

test('findFinderPatterns: 切り出しシンボルの中心と大きさを返す。枠だけの四角や線は拾わない', () => {
  const raster = blank(200, 120)
  finder(raster, 20, 30, 4)
  // 中が空の枠、塗りつぶし、横線
  fill(raster, 100, 30, 28, 28)
  fill(raster, 104, 34, 20, 20, 255)
  fill(raster, 150, 30, 28, 28)
  fill(raster, 10, 100, 180, 2)
  const found = findFinderPatterns(raster)
  assert.equal(found.length, 1)
  assert.ok(Math.abs(found[0].x - 34) <= 1 && Math.abs(found[0].y - 44) <= 1, JSON.stringify(found[0]))
  assert.ok(Math.abs(found[0].module - 4) < 0.5)
})

test('findQrCodes: 3隅のシンボルから範囲を決める。向きが違っても見つける', () => {
  const raster = blank(400, 300)
  qr(raster, 40, 50, 4, 25)
  qr(raster, 240, 120, 3, 29, 'tl')
  // 罫線と、関係のない切り出しシンボル1つ
  fill(raster, 0, 20, 400, 2)
  finder(raster, 180, 250, 4)
  const found = findQrCodes(raster)
  assert.equal(found.length, 2)
  const near = (value: number, expected: number): boolean => Math.abs(value - expected) <= 2
  assert.ok(near(found[0].x0, 40) && near(found[0].y0, 50) && near(found[0].x1, 140) && near(found[0].y1, 150), JSON.stringify(found[0]))
  assert.ok(near(found[1].x0, 240) && near(found[1].y0, 120) && near(found[1].x1, 327) && near(found[1].y1, 207), JSON.stringify(found[1]))
})

test('findQrCodes: シンボルが2つだけ、または正方形の隅にないときは見つけない', () => {
  const two = blank(300, 200)
  finder(two, 20, 20, 4)
  finder(two, 120, 20, 4)
  assert.deepEqual(findQrCodes(two), [])
  const line = blank(400, 200)
  finder(line, 20, 20, 4)
  finder(line, 120, 20, 4)
  finder(line, 220, 20, 4)
  assert.deepEqual(findQrCodes(line), [])
})
