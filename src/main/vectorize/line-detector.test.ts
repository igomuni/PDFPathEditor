import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectLines, type DetectedLine } from './line-detector.ts'

const WIDTH = 400
const HEIGHT = 300

function blankRaster(): { width: number; height: number; data: Uint8Array } {
  return { width: WIDTH, height: HEIGHT, data: new Uint8Array(WIDTH * HEIGHT).fill(255) }
}

function fillRect(data: Uint8Array, x0: number, y0: number, x1: number, y1: number, gray = 0): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * WIDTH + x] = gray
}

const near = (actual: number, expected: number, tolerance = 0.01): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`)

const solid = (lines: DetectedLine[], orientation: 'h' | 'v'): DetectedLine[] =>
  lines.filter((line) => line.orientation === orientation && !line.dash).sort((a, b) => a.center - b.center)

test('枠の4辺を、中心線と太さで検出する', () => {
  const raster = blankRaster()
  // 太さ4pxの枠: 外形 (50,40)-(350,240)
  fillRect(raster.data, 50, 40, 350, 44)
  fillRect(raster.data, 50, 236, 350, 240)
  fillRect(raster.data, 50, 40, 54, 240)
  fillRect(raster.data, 346, 40, 350, 240)
  const lines = detectLines(raster)

  const [top, bottom] = solid(lines, 'h')
  const [left, right] = solid(lines, 'v')
  assert.equal(lines.length, 4)
  near(top.center, 42)
  near(bottom.center, 238)
  near(left.center, 52)
  near(right.center, 348)
  for (const line of [top, bottom]) {
    near(line.start, 50)
    near(line.end, 350)
    near(line.thickness, 4)
  }
  for (const line of [left, right]) {
    near(line.start, 40)
    near(line.end, 240)
    near(line.thickness, 4)
  }
})

test('アンチエイリアスの縁は太さと中心にサブピクセルで反映する', () => {
  const raster = blankRaster()
  // 芯2px + 上の縁が50%の濃さ → 太さ 2.5px、中心は上に寄る
  fillRect(raster.data, 20, 99, 380, 100, 128)
  fillRect(raster.data, 20, 100, 380, 102)
  const [line] = detectLines(raster)
  near(line.thickness, 2.5, 0.02)
  near(line.center, (0.498 * 99.5 + 100.5 + 101.5) / 2.498, 0.02)
})

test('太さが途中で変わる線は、太さごとに分ける', () => {
  const raster = blankRaster()
  fillRect(raster.data, 20, 100, 200, 108)
  fillRect(raster.data, 200, 102, 380, 106)
  const lines = solid(detectLines(raster), 'h').sort((a, b) => a.start - b.start)
  assert.equal(lines.length, 2)
  near(lines[0].thickness, 8)
  near(lines[0].end, 200)
  near(lines[1].thickness, 4)
  near(lines[1].start, 200)
})

test('罫線につながらない短い線(文字の画など)は捨て、つながる短い線は残す', () => {
  const raster = blankRaster()
  fillRect(raster.data, 20, 100, 380, 104) // 長い罫線
  fillRect(raster.data, 200, 100, 204, 160) // 罫線から下がる短い縦線
  fillRect(raster.data, 60, 200, 120, 204) // どこにもつながらない短い横線
  const lines = detectLines(raster)
  assert.equal(solid(lines, 'h').length, 1)
  assert.equal(solid(lines, 'v').length, 1)
  near(solid(lines, 'v')[0].end, 160)
})

test('等間隔の点線は、破線パターン付きの1本にまとめる', () => {
  const raster = blankRaster()
  // 4px の点と 3px の隙間を 30 個、太さ 1px
  for (let i = 0; i < 30; i++) fillRect(raster.data, 40 + i * 7, 150, 44 + i * 7, 151)
  const lines = detectLines(raster)
  assert.equal(lines.length, 1)
  const [line] = lines
  assert.equal(line.orientation, 'h')
  assert.ok(line.dash)
  near(line.dash[0], 4)
  near(line.dash[1], 3)
  near(line.start, 40)
  near(line.end, 40 + 29 * 7 + 4)
  near(line.center, 150.5)
  near(line.thickness, 1)
})

test('塗りつぶした広い領域は線として扱わない', () => {
  const raster = blankRaster()
  fillRect(raster.data, 100, 100, 300, 200)
  assert.equal(detectLines(raster).length, 0)
})
