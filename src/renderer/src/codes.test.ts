import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DocObject, Layer, Page } from '../../shared/model.ts'
import { collectCodes, isComplete, untaggedObjects } from './codes.ts'

const base = { fieldCode: null, transform: [1, 0, 0, 1, 0, 0], z: 0, tags: [], meta: {} } as const
const text = (id: string, patch: Partial<DocObject> = {}): DocObject =>
  ({ ...base, id, type: 'text', role: 'label', text: id, fontFamily: 'Noto Sans JP', fontWeight: 400, fontSize: 9, letterSpacing: 0, fill: '#000000', align: 'left', outline: false, ...patch }) as DocObject
const path = (id: string, patch: Partial<DocObject> = {}): DocObject =>
  ({ ...base, id, type: 'path', role: 'frame', nodes: [], closed: false, fill: null, stroke: '#000000', strokeWidth: 1, dash: null, lineCap: 'butt', ...patch }) as DocObject
const layer = (kind: Layer['kind'], objects: DocObject[], patch: Partial<Layer> = {}): Layer => ({ id: `layer-${kind}`, kind, name: kind, locked: false, visible: true, opacity: 1, objects, ...patch })
const page = (layers: Layer[]): Page => ({ id: 'page-1', sourceId: 'src-1', sourcePageNumber: 1, mediaBox: [0, 0, 595, 842], layers }) as Page

test('collectCodes: コードごとにまとめ、番号の順に並べ、印字と記入欄の有無を出す', () => {
  const entries = collectCodes(
    page([
      layer('candidates', [
        text('g10', { fieldCode: 'G10', role: 'fieldCode' }),
        text('g2', { fieldCode: 'G2', role: 'fieldCode' }),
        path('g2-cell', { fieldCode: 'G2', role: 'inputCell' }),
        text('free')
      ]),
      layer('confirmed', [text('g2-label', { fieldCode: 'G2' })]),
      layer('background', [text('locked', { fieldCode: 'G99' })], { locked: true })
    ])
  )
  assert.deepEqual(entries.map((entry) => [entry.code, entry.ids, isComplete(entry)]), [
    ['G2', ['g2', 'g2-cell', 'g2-label'], true],
    ['G10', ['g10'], false]
  ])
})

test('untaggedObjects: 項目コードのない Text と記入欄だけ。罫線、非表示、ロックされたレイヤーは数えない', () => {
  const found = untaggedObjects(
    page([
      layer('candidates', [text('a'), text('b', { fieldCode: 'G1' }), path('rule'), path('cell', { role: 'inputCell' }), text('hidden', { visible: false })]),
      layer('confirmed', [text('off')], { visible: false }),
      layer('background', [text('locked')], { locked: true })
    ])
  )
  assert.deepEqual(found.map((object) => object.id), ['a', 'cell'])
})
