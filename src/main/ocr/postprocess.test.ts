import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OcrLine } from '../../shared/ocr.ts'
import type { DetectedLine } from '../vectorize/line-detector.ts'
import { cleanText, fitText, splitAtRules, tightInkBox } from './postprocess.ts'

const rule = (orientation: 'h' | 'v', center: number, start: number, end: number, thickness = 4): DetectedLine => ({
  orientation,
  center,
  start,
  end,
  thickness,
  dash: null,
  gray: 0
})

test('和文どうしの間の空白だけを取る', () => {
  assert.equal(cleanText(' 社 会 保 険 料 '), '社会保険料')
  assert.equal(cleanText('第 三 表 の 94'), '第三表の 94')
  assert.equal(cleanText('1.確定  2.修正'), '1.確定 2.修正')
  assert.equal(cleanText('NTA 123'), 'NTA 123')
})

test('縦の罫線をまたぐ行を、罫線の位置で分ける', () => {
  const line: OcrLine = {
    text: '区分 K05',
    confidence: 0.5,
    box: { x: 100, y: 50, width: 200, height: 30 },
    chars: [
      { x: 100, y: 50, width: 30, height: 30 },
      { x: 130, y: 50, width: 30, height: 30 },
      null,
      { x: 220, y: 52, width: 25, height: 26 },
      { x: 245, y: 52, width: 25, height: 26 },
      { x: 270, y: 52, width: 30, height: 26 }
    ]
  }
  const parts = splitAtRules([line], [rule('v', 190, 0, 200), rule('v', 500, 0, 200), rule('h', 60, 0, 400)])
  assert.deepEqual(parts.map((p) => p.text), ['区分', 'K05'])
  assert.deepEqual(parts[0].box, { x: 100, y: 50, width: 60, height: 30 })
  assert.deepEqual(parts[1].box, { x: 220, y: 52, width: 80, height: 26 })
})

test('行に少ししか掛からない罫線では分けない', () => {
  const line: OcrLine = {
    text: 'AB',
    confidence: 1,
    box: { x: 0, y: 100, width: 100, height: 40 },
    chars: [
      { x: 0, y: 100, width: 40, height: 40 },
      { x: 60, y: 100, width: 40, height: 40 }
    ]
  }
  assert.equal(splitAtRules([line], [rule('v', 50, 0, 110)]).length, 1)
})

test('インクの外接矩形は罫線の画素を数えない', () => {
  const width = 100
  const height = 60
  const data = new Uint8Array(width * height).fill(255)
  const fill = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * width + x] = 0
  }
  fill(0, 10, 100, 14) // 横罫線
  fill(30, 22, 70, 40) // 文字
  const raster = { width, height, data }
  const box = { x: 20, y: 8, width: 60, height: 40 }
  assert.deepEqual(tightInkBox(raster, box, [rule('h', 12, 0, 100)], 128), { x0: 30, y0: 22, x1: 70, y1: 40 })
  assert.deepEqual(tightInkBox(raster, box, [], 128), { x0: 20, y0: 10, x1: 80, y1: 40 })
  assert.equal(tightInkBox(raster, { x: 0, y: 45, width: 100, height: 10 }, [], 128), null)
})

test('インクの高さからサイズを、幅の余りから字間を決める', () => {
  // サイズ1で、インクが原点の右 0.05〜2.95、上 0.8、下 0.1 の3文字
  const metrics = { left: -0.05, right: 2.95, ascent: 0.8, descent: 0.1 }
  // 高さ 18px → サイズ 20px。自然な幅は 58px、実際は 98px → 字間 20px
  const fit = fitText({ x0: 101, y0: 50, x1: 199, y1: 68 }, 3, metrics)!
  assert.ok(Math.abs(fit.fontSize - 20) < 1e-9)
  assert.ok(Math.abs(fit.letterSpacing - 20) < 1e-9)
  assert.ok(Math.abs(fit.originX - 100) < 1e-9)
  assert.ok(Math.abs(fit.baselineY - 66) < 1e-9)
})

test('1文字のときは字間を付けず、詰めすぎの推定は抑える', () => {
  const metrics = { left: 0, right: 1, ascent: 0.8, descent: 0.2 }
  assert.equal(fitText({ x0: 0, y0: 0, x1: 50, y1: 10 }, 1, metrics)!.letterSpacing, 0)
  const tight = fitText({ x0: 0, y0: 0, x1: 2, y1: 10 }, 3, { ...metrics, right: 3 })!
  assert.equal(tight.letterSpacing, -1)
})
