import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MISSED_ALLOWED, normalizeMissedText } from './missed.ts'

test('拾い直した字: 1〜2字のかな・漢字・数字・記号だけを受け付け、記号を印字に近い字にそろえる', () => {
  assert.equal(normalizeMissedText('当'), '当')
  assert.equal(normalizeMissedText(' の '), 'の')
  assert.equal(normalizeMissedText('ー'), 'ー')
  assert.equal(normalizeMissedText('~'), '〜')
  assert.equal(normalizeMissedText('x'), '×')
  assert.equal(normalizeMissedText('('), '（')
  assert.equal(normalizeMissedText('.'), '・')
  assert.equal(normalizeMissedText('+'), '+')
  assert.equal(normalizeMissedText('17'), '17')
  assert.equal(normalizeMissedText('★'), '★')
  // 罫線や図形のかけらを読んだものは受け付けない
  for (const junk of ['', '|', 'I', 'i', 'B', '■', "'", '？', '-', "'彑", 'あいう', '123']) assert.equal(normalizeMissedText(junk), null, junk)
  assert.equal(MISSED_ALLOWED.test('江納'), true)
})
