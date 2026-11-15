import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Layer, Page, Rect, TextObject } from '../../shared/model.ts'
import { findFormIdTexts } from './formId.ts'

const text = (id: string, value: string, x: number, y: number): TextObject => ({
  id,
  type: 'text',
  role: 'label',
  fieldCode: null,
  transform: [1, 0, 0, 1, x, y],
  z: 0,
  tags: [],
  meta: {},
  text: value,
  fontFamily: 'Noto Sans JP',
  fontWeight: 400,
  fontSize: 6,
  letterSpacing: 0,
  fill: '#000000',
  align: 'left',
  outline: false
})
const boundsOf = (object: TextObject): Rect => [object.transform[4], object.transform[5] - 1, object.transform[4] + [...object.text].length * 6, object.transform[5] + 5]
const page = (objects: TextObject[], locked: TextObject[] = []): Page =>
  ({
    id: 'page-1',
    sourceId: 'src-1',
    sourcePageNumber: 1,
    mediaBox: [0, 0, 595, 842],
    layers: [
      { id: 'c', kind: 'candidates', name: '', locked: false, visible: true, opacity: 1, objects } as Layer,
      { id: 'b', kind: 'background', name: '', locked: true, visible: true, opacity: 1, objects: locked } as Layer
    ]
  }) as Page

test('様式ID: 見出しの右隣の英数字を様式ID とする', () => {
  const found = findFormIdTexts(
    page([text('label', '様式ID', 400, 800), text('value', 'NTA1KOA020010230', 440, 800), text('other', '申告書', 440, 780), text('far', 'ABCD1234', 400, 700)]),
    boundsOf
  )
  assert.deepEqual(found, ['value'])
})

test('様式ID: 全角・空白入りの見出し、見出しと値が1つの Text になっているものも見つける', () => {
  assert.deepEqual(findFormIdTexts(page([text('label', '様式 ＩＤ', 400, 800), text('value', 'NTA 1KOA 0200', 445, 801)]), boundsOf), ['value'])
  assert.deepEqual(findFormIdTexts(page([text('both', '様式ID NTA1KOA020010230', 400, 800)]), boundsOf), ['both'])
})

test('様式ID: 右隣が英数字でない、行が違う、離れすぎ、ロックされたレイヤーは対象にしない', () => {
  assert.deepEqual(findFormIdTexts(page([text('label', '様式ID', 400, 800), text('value', '申告書', 440, 800)]), boundsOf), [])
  assert.deepEqual(findFormIdTexts(page([text('label', '様式ID', 400, 800), text('value', 'NTA1KOA0200', 440, 780)]), boundsOf), [])
  assert.deepEqual(findFormIdTexts(page([text('label', '様式ID', 100, 800), text('value', 'NTA1KOA0200', 500, 800)]), boundsOf), [])
  assert.deepEqual(findFormIdTexts(page([], [text('label', '様式ID', 400, 800), text('value', 'NTA1KOA0200', 440, 800)]), boundsOf), [])
})
