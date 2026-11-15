import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitVertical, isVertical, verticalChars, verticalLength, verticalLocalBox } from './vertical.ts'

const text = (value: string, patch: object = {}) => ({ text: value, fontSize: 10, letterSpacing: 2, align: 'left' as const, ...patch })

test('縦書き: 1字ずつ上から下へ積み、送りは fontSize + letterSpacing', () => {
  assert.equal(isVertical({ writingMode: 'vertical' }), true)
  assert.equal(isVertical({}), false)
  assert.equal(verticalLength(text('収入金')), 34)
  assert.equal(verticalLength(text('')), 0)
  assert.deepEqual(verticalChars(text('収入金')), [
    { char: '収', top: 0, baseline: 8.8 },
    { char: '入', top: 12, baseline: 20.8 },
    { char: '金', top: 24, baseline: 32.8 }
  ])
  // 外形は、原点(1字目の上辺の中央)から下へ伸びる
  assert.deepEqual(verticalLocalBox(text('収入金')), [-5, -34, 5, 0])
})

test('縦書き: align で原点が行の上端・中央・下端になる', () => {
  assert.deepEqual(verticalLocalBox(text('収入金', { align: 'center' })), [-5, -17, 5, 17])
  assert.deepEqual(verticalLocalBox(text('収入金', { align: 'right' })), [-5, 0, 5, 34])
  assert.equal(verticalChars(text('収入金', { align: 'right' }))[2].top, -10)
})

test('fitVertical: 幅からサイズ、高さから字間を決め、枠の中央に置く', () => {
  // インクが仮想ボディいっぱい(幅 1em、上 0.88em、下 0.12em)の字が3つ
  const full = { left: 0, right: 1, ascent: 0.88, descent: 0.12 }
  const fit = fitVertical([full, full, full], [100, 200, 108, 240])!
  assert.equal(fit.fontSize, 8)
  // 3字で高さ 40 → 送り 16、字間 8
  assert.ok(Math.abs(fit.letterSpacing - 8) < 1e-9)
  assert.equal(fit.x, 104)
  assert.equal(fit.y, 240)

  // インクが小さい字: 上に余白があるぶん、原点はインクの上端より上になる
  const small = { left: 0.1, right: 0.9, ascent: 0.78, descent: 0.02 }
  const fitted = fitVertical([small, small], [0, 0, 8, 30])!
  assert.equal(fitted.fontSize, 8)
  assert.ok(Math.abs(fitted.y - (30 + 0.1 * 8)) < 1e-9)
  // 1字目の上端から2字目の下端までが 30 になる
  const span = fitted.fontSize + fitted.letterSpacing + (0.88 + 0.02) * 8 - 0.1 * 8
  assert.ok(Math.abs(span - 30) < 1e-9)
})

test('fitVertical: 1字で縦長の字形は高さからサイズを決める。測れないときは null', () => {
  const tall = { left: 0.2, right: 0.4, ascent: 0.8, descent: 0.1 }
  const fit = fitVertical([tall], [0, 0, 5, 18])!
  assert.equal(fit.fontSize, 20)
  assert.equal(fit.letterSpacing, 0)
  assert.equal(fitVertical([], [0, 0, 1, 1]), null)
  assert.equal(fitVertical([{ left: 0, right: 0, ascent: 0, descent: 0 }], [0, 0, 1, 1]), null)
})
