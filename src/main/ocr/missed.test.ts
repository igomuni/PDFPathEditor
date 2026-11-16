import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isOversizedMisfit, isStarShape, MISSED_ALLOWED, normalizeMissedText } from './missed.ts'

test('拾い直した字: 1〜2字のかな・漢字・数字・記号だけを受け付け、記号を印字に近い字にそろえる', () => {
  assert.equal(normalizeMissedText('当'), '当')
  assert.equal(normalizeMissedText(' の '), 'の')
  assert.equal(normalizeMissedText('ー'), 'ー')
  assert.equal(normalizeMissedText('~'), '〜')
  assert.equal(normalizeMissedText('x'), '×')
  assert.equal(normalizeMissedText('('), '（')
  assert.equal(normalizeMissedText('{'), '（')
  assert.equal(normalizeMissedText('｝'), '）')
  assert.equal(normalizeMissedText('.'), '・')
  assert.equal(normalizeMissedText('+'), '+')
  assert.equal(normalizeMissedText('17'), '17')
  assert.equal(normalizeMissedText('★'), '★')
  // 罫線や図形のかけらを読んだものは受け付けない
  for (const junk of ['', '|', 'I', 'i', 'B', '■', "'", '？', '-', "'彑", 'あいう', '123']) assert.equal(normalizeMissedText(junk), null, junk)
  assert.equal(MISSED_ALLOWED.test('江納'), true)
})

test('星の形: ほぼ正方形で、3割ほどが塗られたまとまりだけを候補にする', () => {
  // 65×62 画素の星(塗り 33%)
  assert.equal(isStarShape(65, 62, Math.round(65 * 62 * 0.33), 20, 160), true)
  // 塗りつぶした四角、枠だけの四角、横長、小さすぎ、大きすぎ
  assert.equal(isStarShape(60, 60, 3600, 20, 160), false)
  assert.equal(isStarShape(60, 60, 400, 20, 160), false)
  assert.equal(isStarShape(120, 60, Math.round(120 * 60 * 0.33), 20, 160), false)
  assert.equal(isStarShape(12, 12, 48, 20, 160), false)
  assert.equal(isStarShape(300, 300, 30000, 20, 160), false)
})

test('大きすぎる候補: ふつうの文字の2倍を超え、背景と合っていないものだけを捨てる', () => {
  // 複数の行を1行として読んだもの
  assert.equal(isOversizedMisfit(52.6, 7.5, () => 0.8), true)
  // 表題(大きいが背景と合う)
  assert.equal(isOversizedMisfit(26.7, 10.3, () => 0.1), false)
  // ふつうの大きさの候補は、合っていなくても対象にしない(枠の読み直しで扱う)。合い具合も計算しない
  assert.equal(isOversizedMisfit(9, 7.5, () => assert.fail('計算しない')), false)
  assert.equal(isOversizedMisfit(30, 0, () => 1), false)
})
