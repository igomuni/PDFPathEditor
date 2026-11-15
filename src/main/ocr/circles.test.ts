import assert from 'node:assert/strict'
import { test } from 'node:test'
import { circledNumberChar, findRings, innerInk, parseCircled } from './circles.ts'

const WIDTH = 240
const HEIGHT = 120

function blank(): Uint8Array {
  return new Uint8Array(WIDTH * HEIGHT)
}
/** 中心 (cx, cy)、半径 r、太さ t の輪を描く。from〜to(度)だけ描くこともできる */
function drawRing(mask: Uint8Array, cx: number, cy: number, r: number, t: number, from = 0, to = 360): void {
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
      if (Math.abs(Math.hypot(dx, dy) - r) <= t / 2 && angle >= from && angle <= to) mask[y * WIDTH + x] = 1
    }
  }
}
function fillRect(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * WIDTH + x] = 1
}
/** 正方形の枠(線の太さ t) */
function drawSquare(mask: Uint8Array, x0: number, y0: number, size: number, t: number): void {
  fillRect(mask, x0, y0, x0 + size, y0 + t)
  fillRect(mask, x0, y0 + size - t, x0 + size, y0 + size)
  fillRect(mask, x0, y0, x0 + t, y0 + size)
  fillRect(mask, x0 + size - t, y0, x0 + size, y0 + size)
}

test('findRings: 中に文字のある輪を見つけ、中心・半径・太さを返す', () => {
  const mask = blank()
  drawRing(mask, 40, 40, 15, 2)
  // 輪の中の「数字」
  fillRect(mask, 34, 34, 37, 46)
  fillRect(mask, 41, 34, 46, 46)
  const rings = findRings(mask, WIDTH, HEIGHT)
  assert.equal(rings.length, 1)
  const [ring] = rings
  assert.ok(Math.abs(ring.cx - 40) <= 0.6 && Math.abs(ring.cy - 40) <= 0.6, `${ring.cx}, ${ring.cy}`)
  assert.ok(Math.abs(ring.radius - 15) <= 0.6, String(ring.radius))
  assert.ok(Math.abs(ring.thickness - 2) <= 0.7, String(ring.thickness))
  // 中のインクの範囲(輪そのものは含めない)
  const inner = innerInk(mask, WIDTH, ring)!
  assert.deepEqual([inner.x0, inner.y0, inner.x1, inner.y1], [34, 34, 46, 46])
  assert.equal(inner.count, 3 * 12 + 5 * 12)
})

test('findRings: 中が空の丸、四角い枠、欠けた円弧、楕円、大きすぎる丸は対象にしない', () => {
  const mask = blank()
  // 中が空の丸
  drawRing(mask, 30, 30, 14, 2)
  // 四角い枠の中に文字
  drawSquare(mask, 60, 15, 30, 2)
  fillRect(mask, 70, 25, 80, 35)
  // 4分の1が欠けた円弧の中に文字
  drawRing(mask, 130, 30, 14, 2, 0, 270)
  fillRect(mask, 126, 26, 134, 34)
  // 塗りつぶした円(輪ではない)
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) if (Math.hypot(x + 0.5 - 180, y + 0.5 - 30) <= 12) mask[y * WIDTH + x] = 1
  // 大きすぎる丸の中に文字
  drawRing(mask, 60, 75, 43, 2)
  fillRect(mask, 55, 70, 65, 80)
  assert.deepEqual(findRings(mask, WIDTH, HEIGHT), [])
})

test('findRings: 中の数字が輪に触れてつながっていても見つける', () => {
  const mask = blank()
  drawRing(mask, 60, 60, 16, 2)
  // 輪の内側まで届く横棒(輪と同じ連結成分になる)と、離れた字
  fillRect(mask, 46, 58, 60, 62)
  fillRect(mask, 64, 52, 68, 68)
  const rings = findRings(mask, WIDTH, HEIGHT)
  assert.equal(rings.length, 1)
  assert.ok(Math.abs(rings[0].radius - 16) <= 0.8, String(rings[0].radius))
  // 輪につながっていた部分も、中のインクとして数える
  const inner = innerInk(mask, WIDTH, rings[0])!
  assert.ok(inner.x0 <= 48 && inner.x1 === 68 && inner.y0 === 52 && inner.y1 === 68, JSON.stringify(inner))
})

test('findRings: 輪に触れていない隣の文字や罫線があっても見つける', () => {
  const mask = blank()
  drawRing(mask, 100, 60, 16, 2)
  fillRect(mask, 96, 54, 104, 66)
  // 隣の枠の文字と、離れた罫線
  fillRect(mask, 130, 50, 150, 70)
  fillRect(mask, 0, 100, WIDTH, 102)
  assert.equal(findRings(mask, WIDTH, HEIGHT).length, 1)
})

test('circledNumberChar: 1〜50 は丸数字の文字になり、それ以外は null', () => {
  assert.equal(circledNumberChar(1), '①')
  assert.equal(circledNumberChar(20), '⑳')
  assert.equal(circledNumberChar(21), '㉑')
  assert.equal(circledNumberChar(35), '㉟')
  assert.equal(circledNumberChar(36), '㊱')
  assert.equal(circledNumberChar(50), '㊿')
  assert.equal(circledNumberChar(51), null)
  assert.equal(circledNumberChar(0), null)
  assert.equal(circledNumberChar(1.5), null)
})

test('parseCircled: 50 までは1文字、51 以上は数字、カタカナは丸囲みのカタカナにする', () => {
  assert.deepEqual(parseCircled('12'), { kind: 'char', char: '⑫', number: 12 })
  assert.deepEqual(parseCircled(' 5 0 '), { kind: 'char', char: '㊿', number: 50 })
  assert.deepEqual(parseCircled('51'), { kind: 'number', digits: '51', number: 51 })
  assert.deepEqual(parseCircled('65'), { kind: 'number', digits: '65', number: 65 })
  // 読み違いの補正(全角、O → 0、l → 1)
  assert.deepEqual(parseCircled('３O'), { kind: 'char', char: '㉚', number: 30 })
  assert.deepEqual(parseCircled('l6'), { kind: 'char', char: '⑯', number: 16 })
  assert.deepEqual(parseCircled('カ'), { kind: 'char', char: '㋕', number: null })
  assert.deepEqual(parseCircled('ｻ'), { kind: 'char', char: '㋚', number: null })
  for (const bad of ['', '0', '100', 'A', '給', 'カキ', '1a']) assert.equal(parseCircled(bad), null)
})
