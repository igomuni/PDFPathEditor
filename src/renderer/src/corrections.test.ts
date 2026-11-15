import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DocObject, DocumentModel, Layer, LayerKind, PathObject, TextObject } from '../../shared/model.ts'
import { applyCorrections } from './commands.ts'
import { planCorrections, type FitText } from './corrections.ts'
import { History } from './history.ts'

function text(id: string, value: string, x: number, y: number): TextObject {
  return {
    id,
    type: 'text',
    role: 'label',
    fieldCode: null,
    transform: [1, 0, 0, 1, x, y],
    z: 0,
    tags: [],
    meta: { ocr: 'vision' },
    text: value,
    fontFamily: 'Noto Sans JP',
    fontWeight: 400,
    fontSize: 10,
    letterSpacing: 0,
    fill: '#000000',
    align: 'left',
    outline: false
  }
}

function line(id: string): PathObject {
  return {
    id,
    type: 'path',
    role: 'frame',
    fieldCode: null,
    transform: [1, 0, 0, 1, 0, 0],
    z: 0,
    tags: [],
    meta: {},
    nodes: [
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ],
    closed: false,
    fill: null,
    stroke: '#000000',
    strokeWidth: 1,
    dash: null,
    lineCap: 'butt'
  }
}

function layer(kind: LayerKind, objects: DocObject[], locked = false): Layer {
  return { id: `layer-${kind}`, kind, name: kind, locked, visible: true, opacity: 1, objects }
}

function makeDocument(candidates: DocObject[], confirmed: DocObject[] = [], background: DocObject[] = []): DocumentModel {
  return {
    version: 2,
    createdAt: '',
    sources: [{ id: 'src-1', file: '', originalFileName: '', sha256: '', byteLength: 0, pageCount: 1, encrypted: false, encryptFilter: null, permissions: null }],
    pages: [
      {
        id: 'page-1',
        sourceId: 'src-1',
        sourcePageNumber: 2,
        mediaBox: [0, 0, 595, 842],
        layers: [layer('background', background, true), layer('candidates', candidates), layer('confirmed', confirmed)]
      }
    ]
  }
}

/** テスト用: 枠の高さをそのままサイズにし、左下に置く。字間は幅の余りを均等に配る */
const fit: FitText = (value, _family, _weight, box) => {
  const fontSize = box[3] - box[1]
  const count = [...value].length
  return { fontSize, letterSpacing: count > 1 ? (box[2] - box[0] - fontSize * count) / (count - 1) : 0, x: box[0], y: box[1] }
}
let counter = 0
const newId = (): string => `new-${++counter}`
const file = (operations: unknown[], extra: object = {}): unknown => ({ version: 1, operations, ...extra })
const objectsOf = (document: DocumentModel, kind: LayerKind): DocObject[] =>
  document.pages[0].layers.find((candidate) => candidate.kind === kind)!.objects

test('置換・追加・削除を計画し、1回の操作で適用して Undo で戻せる', () => {
  const document = makeDocument([text('a', '62', 100, 200), text('b', 'ゴミ', 0, 0), line('rule')], [text('c', 'G0l', 50, 50)])
  const plan = planCorrections(
    document.pages,
    file([
      { op: 'replace', id: 'a', set: { text: '㊿', fontSize: 6.5, x: 101, y: 201.5 }, reason: '丸数字' },
      { op: 'replace', id: 'c', set: { text: 'G01', fieldCode: 'G01', role: 'fieldCode' } },
      { op: 'delete', id: 'b' },
      { op: 'delete', id: 'rule' },
      { op: 'add', text: { text: '㋔', x: 300, y: 400, fontSize: 7 } },
      { op: 'add', text: { text: '青色', fitBox: [10, 20, 40, 30] } }
    ]),
    fit,
    newId
  )
  assert.deepEqual(plan.rejected, [])
  assert.equal(plan.replacements.size, 2)
  assert.equal(plan.additions.length, 2)
  assert.deepEqual([...plan.deletions], ['b', 'rule'])

  const history = new History()
  const next = history.execute(document, applyCorrections(document, plan)!)
  const candidates = objectsOf(next, 'candidates')
  assert.deepEqual(
    candidates.map((object) => object.id),
    ['a', 'new-1', 'new-2']
  )
  const a = candidates[0] as TextObject
  assert.equal(a.text, '㊿')
  assert.equal(a.fontSize, 6.5)
  assert.deepEqual(a.transform, [1, 0, 0, 1, 101, 201.5])
  // 元の meta は残し、直した印を付ける
  assert.deepEqual(a.meta, { ocr: 'vision', corrected: true })

  const added = candidates[1] as TextObject
  assert.equal(added.text, '㋔')
  assert.equal(added.fontFamily, 'Noto Sans JP')
  assert.deepEqual(added.transform, [1, 0, 0, 1, 300, 400])
  assert.ok(added.z > a.z)
  // fitBox: 枠からサイズ・位置・字間を決める
  const fitted = candidates[2] as TextObject
  assert.equal(fitted.fontSize, 10)
  assert.equal(fitted.letterSpacing, 10)
  assert.deepEqual(fitted.transform, [1, 0, 0, 1, 10, 20])

  // 確定レイヤーのオブジェクトも置換できる
  const c = objectsOf(next, 'confirmed')[0] as TextObject
  assert.equal(c.text, 'G01')
  assert.equal(c.fieldCode, 'G01')
  assert.equal(c.role, 'fieldCode')

  assert.deepEqual(history.undo(next), document)
})

test('置換の fitBox は、置換後の文字列とフォントで合わせ直す', () => {
  const document = makeDocument([text('a', '口座番号', 100, 200)])
  const plan = planCorrections(document.pages, file([{ op: 'replace', id: 'a', set: { text: '口座', fitBox: [5, 6, 30, 14] } }]), (value, family, weight, box) => {
    assert.equal(value, '口座')
    assert.equal(family, 'Noto Sans JP')
    assert.equal(weight, 400)
    return fit(value, family, weight, box, false)
  })
  const replaced = plan.replacements.get('a')!
  assert.equal(replaced.fontSize, 8)
  assert.equal(replaced.letterSpacing, 9)
  assert.deepEqual(replaced.transform, [1, 0, 0, 1, 5, 6])
})

test('適用できない操作は理由を付けて飛ばし、残りは適用する', () => {
  const document = makeDocument([text('a', 'A', 0, 0), line('rule')], [], [text('bg', '背景', 0, 0)])
  const plan = planCorrections(
    document.pages,
    file([
      { op: 'replace', id: 'missing', set: { text: 'x' } },
      { op: 'replace', id: 'rule', set: { text: 'x' } },
      { op: 'replace', id: 'bg', set: { text: 'x' } },
      { op: 'replace', id: 'a', set: { fontSize: -1 } },
      { op: 'replace', id: 'a', set: { fill: 'red' } },
      { op: 'replace', id: 'a', set: { transform: [1, 0, 0, 1, 0, 0] } },
      { op: 'replace', id: 'a', set: {} },
      { op: 'replace', id: 'a', set: { text: 'B' } },
      { op: 'delete', id: 'a' },
      { op: 'add', text: { text: 'x' } },
      { op: 'add', text: { x: 1, y: 2, fontSize: 3 } },
      { op: 'add', text: { text: 'x\ny', x: 1, y: 2, fontSize: 3 } },
      { op: 'add', text: { text: 'x', fitBox: [10, 10, 5, 20] } },
      { op: 'move', id: 'a' },
      'not an object'
    ]),
    fit,
    newId
  )
  assert.deepEqual(
    plan.rejected.map((entry) => entry.index),
    [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]
  )
  assert.match(plan.rejected[0].reason, /対象のオブジェクトがありません/)
  assert.match(plan.rejected[1].reason, /Text だけ/)
  // ロックされた背景レイヤーは対象外
  assert.match(plan.rejected[2].reason, /対象のオブジェクトがありません/)
  assert.match(plan.rejected[7].reason, /重複/)
  assert.equal(plan.replacements.get('a')!.text, 'B')
  assert.equal(plan.additions.length, 0)
  assert.equal(plan.deletions.size, 0)
})

test('フォントを測れないときの fitBox は飛ばす', () => {
  const document = makeDocument([])
  const plan = planCorrections(document.pages, file([{ op: 'add', text: { text: 'x', fitBox: [0, 0, 5, 5], fontFamily: 'Unknown' } }]), () => null)
  assert.match(plan.rejected[0].reason, /測れない/)
})

test('ファイル全体が読めないときは例外にする。ページ番号で対象を選べる', () => {
  const document = makeDocument([text('a', 'A', 0, 0)])
  assert.throws(() => planCorrections(document.pages, [], fit), /形式が正しくありません/)
  assert.throws(() => planCorrections(document.pages, { version: 2, operations: [] }, fit), /バージョン/)
  assert.throws(() => planCorrections(document.pages, { version: 1 }, fit), /operations/)
  assert.throws(() => planCorrections(document.pages, file([], { page: 9 }), fit), /対象のページがありません/)
  assert.throws(() => planCorrections(document.pages, file(Array(5001).fill({ op: 'delete', id: 'a' })), fit), /多すぎます/)
  assert.equal(planCorrections(document.pages, file([], { page: 2 }), fit).pageId, 'page-1')
  // 変更がなければコマンドは null
  assert.equal(applyCorrections(document, planCorrections(document.pages, file([]), fit)), null)
})
