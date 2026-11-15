import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TextDraft } from '../../shared/ocr.ts'
import { mergeVerticalRuns } from './vertical.ts'

/** 仮想ボディの左上が (left, top) になる1字の候補(横書き、サイズ 10) */
function char(text: string, left: number, top: number, size = 10, confidence = 0.9): TextDraft {
  return {
    type: 'text',
    role: 'label',
    fieldCode: null,
    transform: [1, 0, 0, 1, left, top - 0.88 * size],
    tags: [],
    meta: { ocr: 'vision', confidence },
    text,
    fontFamily: 'Noto Sans JP',
    fontWeight: 400,
    fontSize: size,
    letterSpacing: 0,
    fill: '#000000',
    align: 'left',
    outline: false
  }
}
const never = (): boolean => false

test('縦に等間隔で並ぶ1字の Text を、1つの縦書きの Text にまとめる', () => {
  // 「収入金」が送り 30 で縦に並ぶ。読まれた順は上からとは限らない
  const drafts = [char('金', 100, 440), char('横', 300, 500), char('収', 100.5, 500), char('入', 99.5, 470)]
  const result = mergeVerticalRuns(drafts, never)
  assert.equal(result.length, 2)
  // まとめたものは1字目(収)のあった位置に入り、他の順番は変わらない
  assert.equal(result[0].text, '横')
  const merged = result[1]
  assert.equal(merged.text, '収入金')
  assert.equal(merged.writingMode, 'vertical')
  assert.equal(merged.fontSize, 10)
  assert.equal(merged.letterSpacing, 20)
  // 原点は1字目の上辺の中央
  assert.deepEqual(merged.transform, [1, 0, 0, 1, 105, 500])
  assert.equal(merged.meta.mergedVertical, 3)
})

test('確信度は最も低いものにし、サイズは中央値にそろえる', () => {
  const result = mergeVerticalRuns([char('青', 100, 500, 10, 0.9), char('色', 99.5, 489, 11, 0.4)], never)
  assert.equal(result.length, 1)
  assert.equal(result[0].text, '青色')
  assert.equal(result[0].meta.confidence, 0.4)
  assert.equal(result[0].fontSize, 10.5)
})

test('罫線をまたぐもの、左右にずれたもの、大きさが違うもの、離れすぎたものはまとめない', () => {
  const pair = [char('配', 100, 500), char('給', 100, 470)]
  // y = 480 に横の罫線がある
  const ruled = mergeVerticalRuns(pair, (_x, bottom, top) => bottom < 480 && 480 < top)
  assert.deepEqual(
    ruled.map((draft) => draft.text),
    ['配', '給']
  )
  assert.equal(mergeVerticalRuns([char('配', 100, 500), char('給', 105, 470)], never).length, 2)
  assert.equal(mergeVerticalRuns([char('配', 100, 500), char('給', 100, 470, 16)], never).length, 2)
  assert.equal(mergeVerticalRuns([char('配', 100, 500), char('給', 100, 400)], never).length, 2)
})

test('送りがそろっているところまでをまとめる(1つの Text にすると位置がずれる字は入れない)', () => {
  const drafts = [char('事', 100, 500), char('業', 100, 485), char('等', 100, 440)]
  assert.deepEqual(
    mergeVerticalRuns(drafts, never).map((draft) => draft.text),
    ['事業', '等']
  )
  // 3字の送りがばらばらなら、先頭の2字だけになる
  const uneven = [char('あ', 100, 500), char('い', 100, 480), char('う', 100, 440), char('え', 100, 425)]
  assert.deepEqual(
    mergeVerticalRuns(uneven, never).map((draft) => draft.text),
    ['あい', 'うえ']
  )
})

test('数字・記号・2字以上の Text・すでに縦書きのものは対象にしない', () => {
  const vertical = { ...char('雑', 100, 440), writingMode: 'vertical' as const }
  const drafts = [char('1', 100, 500), char('2', 100, 470), char('給与', 200, 500), char('年金', 200, 470), char('ー', 300, 500), char('ー', 300, 470), vertical]
  assert.deepEqual(mergeVerticalRuns(drafts, never), drafts)
})

test('括弧も含めてまとめる', () => {
  const drafts = [char('（', 100, 500), char('単', 100, 488), char('位', 100, 476), char('）', 100, 464)]
  const result = mergeVerticalRuns(drafts, never)
  assert.equal(result.length, 1)
  assert.equal(result[0].text, '（単位）')
  assert.equal(result[0].letterSpacing, 2)
})
