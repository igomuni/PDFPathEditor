import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Rect, TextObject } from '../../shared/model.ts'
import { verticalLocalBox } from '../../shared/vertical.ts'
import { charCuts, mergeTexts, splitText, type AdvanceOf } from './textEdit.ts'

function label(id: string, text: string, x: number, y: number, patch: Partial<TextObject> = {}): TextObject {
  return {
    id,
    type: 'text',
    role: 'label',
    fieldCode: null,
    transform: [1, 0, 0, 1, x, y],
    z: 0,
    tags: [],
    meta: {},
    text,
    fontFamily: 'Noto Sans JP',
    fontWeight: 400,
    fontSize: 10,
    letterSpacing: 0,
    fill: '#000000',
    align: 'left',
    outline: false,
    ...patch
  }
}

// どの字も全角(1em)として測る
const advanceOf: AdvanceOf = (text, base) => {
  const count = [...text].length
  return count * base.fontSize + Math.max(0, count - 1) * base.letterSpacing
}
const boundsOf = (object: TextObject): Rect => {
  const [, , , , e, f] = object.transform
  if (object.writingMode === 'vertical') {
    const [x0, y0, x1, y1] = verticalLocalBox(object)
    return [e + x0, f + y0, e + x1, f + y1]
  }
  const width = advanceOf(object.text, object)
  const x0 = object.align === 'left' ? e : object.align === 'center' ? e - width / 2 : e - width
  return [x0, f - 0.12 * object.fontSize, x0 + width, f + 0.88 * object.fontSize]
}
const ids = (): (() => string) => {
  let n = 0
  return () => `new-${++n}`
}

test('charCuts: 1字ごとの切れ目。サロゲートペアは1字として扱う', () => {
  assert.deepEqual(charCuts('給与所得'), [1, 2, 3])
  assert.deepEqual(charCuts('𠮷野'), [2])
  assert.deepEqual(charCuts('あ'), [])
})

test('splitText: 範囲で3つに分け、字の位置は変わらない。1つ目が元のIDを引き継ぐ', () => {
  const source = label('t', '収入金額等', 100, 200, { letterSpacing: 2, fieldCode: 'G01' })
  const parts = splitText(source, [2, 4], advanceOf, ids())
  assert.deepEqual(parts.map((part) => [part.id, part.text, part.transform[4], part.transform[5]]), [
    ['t', '収入', 100, 200],
    ['new-1', '金額', 124, 200],
    ['new-2', '等', 148, 200]
  ])
  assert.ok(parts.every((part) => part.letterSpacing === 2 && part.fieldCode === 'G01'))
  // カーソルの位置で2つに分ける
  assert.deepEqual(splitText(source, [3], advanceOf, ids()).map((part) => part.text), ['収入金', '額等'])
  // 端では分けられない
  assert.deepEqual(splitText(source, [0], advanceOf), [])
  assert.deepEqual(splitText(source, [5], advanceOf), [])
})

test('splitText: 中央揃え・右揃えは行の始まりから測り、分けた後は左揃えにする。空白は位置に繰り入れる', () => {
  const centered = splitText(label('t', 'あいうえ', 100, 50, { align: 'center' }), [2], advanceOf, ids())
  assert.deepEqual(centered.map((part) => [part.text, part.align, part.transform[4]]), [['あい', 'left', 80], ['うえ', 'left', 100]])
  const right = splitText(label('t', 'あいうえ', 100, 50, { align: 'right' }), [1], advanceOf, ids())
  assert.deepEqual(right.map((part) => part.transform[4]), [60, 70])
  const spaced = splitText(label('t', '氏名 住所', 0, 0), [2], advanceOf, ids())
  assert.deepEqual(spaced.map((part) => [part.text, part.transform[4]]), [['氏名', 0], ['住所', 30]])
})

test('splitText: 縦書きは下へ送る', () => {
  const parts = splitText(label('t', '令和八年', 300, 700, { writingMode: 'vertical', letterSpacing: 1 }), charCuts('令和八年'), advanceOf, ids())
  assert.deepEqual(parts.map((part) => [part.text, part.transform[4], part.transform[5]]), [
    ['令', 300, 700],
    ['和', 300, 689],
    ['八', 300, 678],
    ['年', 300, 667]
  ])
  assert.ok(parts.every((part) => part.writingMode === 'vertical'))
})

test('mergeTexts: 同じ行は左から並べ、全体の幅が変わらないよう字間を決める', () => {
  const merged = mergeTexts([label('b', '金額', 130, 200), label('a', '収入', 100, 200, { role: 'other', fieldCode: 'G01' })], boundsOf, advanceOf)!
  assert.equal(merged.id, 'a')
  assert.equal(merged.text, '収入金額')
  assert.equal(merged.role, 'other')
  assert.equal(merged.fieldCode, 'G01')
  assert.deepEqual(merged.transform, [1, 0, 0, 1, 100, 200])
  // 幅 50 に 4字(40)を入れるので、字間は 10 / 3
  assert.equal(merged.letterSpacing, 3.333)
  // 分けたものを結合すると元に戻る
  const source = label('t', '収入金額等', 100, 200, { letterSpacing: 2 })
  const back = mergeTexts(splitText(source, [2, 4], advanceOf, ids()), boundsOf, advanceOf)!
  assert.deepEqual([back.text, back.letterSpacing, back.transform], [source.text, 2, source.transform])
})

test('mergeTexts: 複数の行は上から、縦書きは右の列から上から並べる。1つだけなら null', () => {
  const lines = mergeTexts([label('c', '下', 100, 180), label('a', '上左', 100, 200), label('b', '上右', 125, 201)], boundsOf, advanceOf)!
  assert.equal(lines.text, '上左上右下')
  assert.equal(lines.id, 'a')
  assert.equal(lines.letterSpacing, 0)
  const v = { writingMode: 'vertical' as const }
  const column = mergeTexts([label('b', '八年', 300, 678, v), label('a', '令和', 300, 700, v)], boundsOf, advanceOf)!
  assert.deepEqual([column.id, column.text, column.letterSpacing, column.transform], ['a', '令和八年', 0.667, [1, 0, 0, 1, 300, 700]])
  assert.equal(mergeTexts([label('a', '左列', 280, 700, v), label('b', '右列', 300, 700, v)], boundsOf, advanceOf)!.text, '右列左列')
  assert.equal(mergeTexts([label('a', '一', 0, 0)], boundsOf, advanceOf), null)
})
