import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DetectedLine } from '../vectorize/line-detector.ts'
import { decideMode, findCellPx, inkBounds, mergeIntoGlyphs, projectBands, splitCell, type PixelRect } from './reread.ts'

const WIDTH = 200
const HEIGHT = 200

/** 指定した矩形 [x0, y0, x1, y1) を塗ったマスク */
function mask(rects: [number, number, number, number][]): Uint8Array {
  const data = new Uint8Array(WIDTH * HEIGHT)
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * WIDTH + x] = 1
  return data
}
const rule = (orientation: 'h' | 'v', center: number, start: number, end: number, dash: [number, number] | null = null): DetectedLine => ({
  orientation,
  center,
  start,
  end,
  thickness: 2,
  dash,
  gray: 0
})
const whole: PixelRect = { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT }

test('findCellPx: 上下左右の実線の内側を返す。点線は枠にしない', () => {
  const rules = [rule('h', 10, 0, 200), rule('h', 110, 0, 200), rule('v', 20, 0, 200), rule('v', 80, 0, 200), rule('v', 50, 0, 200, [1, 2])]
  assert.deepEqual(findCellPx(rules, 40, 60), { x0: 23, y0: 13, x1: 77, y1: 107 })
  // 右に罫線がない
  assert.equal(findCellPx(rules, 120, 60), null)
  // 罫線が届いていない位置
  assert.equal(findCellPx([...rules.slice(0, 3), rule('v', 80, 0, 30)], 40, 60), null)
})

test('projectBands: インクのある範囲を返し、小さな切れ目はつなぐ', () => {
  const m = mask([
    [10, 10, 20, 20],
    [21, 10, 30, 20],
    [40, 30, 50, 40]
  ])
  assert.deepEqual(projectBands(m, WIDTH, whole, 'x', 2), [
    { start: 10, end: 30 },
    { start: 40, end: 50 }
  ])
  assert.deepEqual(projectBands(m, WIDTH, whole, 'x', 1), [
    { start: 10, end: 20 },
    { start: 21, end: 30 },
    { start: 40, end: 50 }
  ])
  assert.deepEqual(projectBands(m, WIDTH, whole, 'y', 2), [
    { start: 10, end: 20 },
    { start: 30, end: 40 }
  ])
  assert.deepEqual(inkBounds(m, WIDTH, whole), { x0: 10, y0: 10, x1: 50, y1: 40 })
  assert.equal(inkBounds(m, WIDTH, { x0: 60, y0: 0, x1: 100, y1: 100 }), null)
})

test('decideMode: 1列に縦に並べば縦書き、行が少なければ横書きの複数行', () => {
  const band = (start: number, end: number) => ({ start, end })
  // 幅 20 の1列に、3字が縦に並ぶ
  assert.equal(decideMode([band(0, 20)], [band(0, 20), band(25, 45), band(50, 70)]), 'vertical')
  // 1行だけは対象外
  assert.equal(decideMode([band(0, 20), band(25, 45)], [band(0, 20)]), null)
  // 1列でも、縦に長くなければ横書きの複数行(字がつながって1列に見える2段組)
  assert.equal(decideMode([band(0, 20)], [band(0, 9), band(11, 20)]), 'horizontal')
  // 細すぎるものは対象外
  assert.equal(decideMode([band(0, 5)], [band(0, 9), band(11, 20)]), null)
  // 2行 × 3字 → 横書きの2行
  assert.equal(decideMode([band(0, 10), band(12, 22), band(24, 34)], [band(0, 10), band(14, 24)]), 'horizontal')
  // 2列 × 3字 → 縦書きの2列
  assert.equal(decideMode([band(0, 10), band(14, 24)], [band(0, 10), band(12, 22), band(24, 34)]), 'vertical')
  // 2 × 2 は、切れ目の広いほうが行(列)の区切り
  assert.equal(decideMode([band(0, 10), band(12, 22)], [band(0, 10), band(16, 26)]), 'horizontal')
  assert.equal(decideMode([band(0, 10), band(16, 26)], [band(0, 10), band(12, 22)]), 'vertical')
})

test('mergeIntoGlyphs: 字の中の切れ目はつなぎ、列の幅くらいの高さで1字にする', () => {
  // 「二」のように上下に分かれた字(0-4, 14-20)と、次の字(26-46)
  assert.deepEqual(
    mergeIntoGlyphs(
      [
        { start: 0, end: 4 },
        { start: 14, end: 20 },
        { start: 26, end: 46 }
      ],
      20
    ),
    [
      { start: 0, end: 20 },
      { start: 26, end: 46 }
    ]
  )
})

test('splitCell: 縦書きの列を1字ずつに分け、横書きの2行を行ごとに分ける', () => {
  // 幅 20 の列に3字(2字目は上下に分かれている)
  const vertical = mask([
    [40, 20, 60, 40],
    [42, 46, 58, 50],
    [40, 58, 60, 66],
    [41, 72, 59, 92]
  ])
  const columns = splitCell(vertical, WIDTH, { x0: 30, y0: 10, x1: 70, y1: 100 })
  assert.equal(columns.length, 1)
  assert.equal(columns[0].mode, 'vertical')
  assert.deepEqual(columns[0].box, { x0: 40, y0: 20, x1: 60, y1: 92 })
  assert.deepEqual(columns[0].glyphs, [
    { x0: 40, y0: 20, x1: 60, y1: 40 },
    { x0: 40, y0: 46, x1: 60, y1: 66 },
    { x0: 41, y0: 72, x1: 59, y1: 92 }
  ])

  // 2行 × 3字
  const lines = mask([
    [10, 10, 20, 20],
    [23, 10, 33, 20],
    [36, 10, 46, 20],
    [10, 26, 20, 36],
    [23, 26, 33, 36],
    [36, 26, 46, 36]
  ])
  const rows = splitCell(lines, WIDTH, { x0: 5, y0: 5, x1: 60, y1: 45 })
  assert.deepEqual(
    rows.map((item) => [item.mode, item.box]),
    [
      ['horizontal', { x0: 10, y0: 10, x1: 46, y1: 20 }],
      ['horizontal', { x0: 10, y0: 26, x1: 46, y1: 36 }]
    ]
  )
  // 1行だけの枠は、その1行を返す
  assert.deepEqual(splitCell(lines, WIDTH, { x0: 5, y0: 5, x1: 60, y1: 22 }), [{ mode: 'horizontal', box: { x0: 10, y0: 10, x1: 46, y1: 20 }, glyphs: [] }])
  // インクのない枠は空
  assert.deepEqual(splitCell(lines, WIDTH, { x0: 100, y0: 100, x1: 150, y1: 150 }), [])
})
