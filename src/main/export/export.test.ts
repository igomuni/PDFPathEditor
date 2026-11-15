import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DocObject, DocumentModel, Layer, LayerKind, PathObject, TextObject } from '../../shared/model.ts'
import type { GrayRaster } from '../../shared/vectorizer.ts'
import { buildExportJson } from './json.ts'
import { exportBounds, exportedObjects, type LayoutText } from './layout.ts'
import { pageToSvg } from './svg.ts'
import { compareRasters, DIFF_EXTRA, DIFF_MATCH, DIFF_MISSING } from './verify.ts'

const base = { fieldCode: null, transform: [1, 0, 0, 1, 0, 0] as PathObject['transform'], z: 0, tags: [], meta: {} }

function line(id: string, x0: number, y0: number, x1: number, y1: number, patch: Partial<PathObject> = {}): PathObject {
  return {
    ...base,
    id,
    type: 'path',
    role: 'frame',
    nodes: [
      { x: x0, y: y0 },
      { x: x1, y: y1 }
    ],
    closed: false,
    fill: null,
    stroke: '#000000',
    strokeWidth: 1,
    dash: null,
    lineCap: 'butt',
    ...patch
  }
}

function cell(id: string, fieldCode: string, x0: number, y0: number, x1: number, y1: number): PathObject {
  return {
    ...line(id, 0, 0, 0, 0),
    role: 'inputCell',
    fieldCode,
    nodes: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 }
    ],
    closed: true,
    stroke: null,
    strokeWidth: 0
  }
}

function text(id: string, value: string, x: number, y: number, patch: Partial<TextObject> = {}): TextObject {
  return {
    ...base,
    id,
    type: 'text',
    role: 'label',
    transform: [1, 0, 0, 1, x, y],
    text: value,
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

/** テスト用の組版: 1字の送りは 0.5em、グリフは三角形 */
const layout: LayoutText = (object) => {
  const count = [...object.text].length
  const advance = object.fontSize * 0.5 + object.letterSpacing
  const width = count === 0 ? 0 : advance * count - object.letterSpacing
  const x0 = object.align === 'left' ? 0 : object.align === 'center' ? -width / 2 : -width
  return {
    x0,
    width,
    scale: object.fontSize / 1000,
    glyphs: [...object.text].map((_, i) => ({ d: 'M0 0L500 0L250 700Z', x: x0 + advance * i, y: 0 }))
  }
}

function layer(kind: LayerKind, objects: DocObject[]): Layer {
  return { id: `layer-${kind}`, kind, name: kind, locked: false, visible: true, opacity: 1, objects }
}

function makeDocument(candidates: DocObject[], confirmed: DocObject[]): DocumentModel {
  return {
    version: 2,
    createdAt: '',
    sources: [
      {
        id: 'src-1',
        file: 'source/form.pdf',
        originalFileName: 'form.pdf',
        sha256: 'abc',
        byteLength: 0,
        pageCount: 3,
        encrypted: false,
        encryptFilter: null,
        permissions: null
      }
    ],
    pages: [
      {
        id: 'page-1',
        sourceId: 'src-1',
        sourcePageNumber: 2,
        mediaBox: [0, 0, 595, 842],
        layers: [layer('background', []), layer('candidates', candidates), layer('confirmed', confirmed)]
      }
    ]
  }
}

test('出力対象は確定レイヤーだけで、Z順に並ぶ', () => {
  const document = makeDocument(
    [line('candidate', 0, 0, 10, 0)],
    [
      { ...line('front', 0, 0, 10, 0), z: 5 },
      { ...line('back', 0, 0, 10, 0), z: 1 }
    ]
  )
  assert.deepEqual(
    exportedObjects(document.pages[0]).map((object) => object.id),
    ['back', 'front']
  )
})

test('SVG: ページ左上原点の pt で、Path と Text を属性付きで出す', () => {
  const document = makeDocument(
    [],
    [
      line('rule', 10, 100, 110, 100, { strokeWidth: 0.72, dash: [0.5, 1] }),
      text('label', '給与 <A&B>', 20, 50, { fieldCode: 'G44', letterSpacing: 1.5, align: 'center' }),
      cell('cell', 'G44', 0, 0, 10, 10)
    ]
  )
  const svg = pageToSvg(document.pages[0], layout)
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="595pt" height="842pt" viewBox="0 0 595 842">/)
  assert.match(svg, /<g transform="matrix\(1 0 0 -1 0 842\)">/)
  assert.match(
    svg,
    /<path id="rule" data-role="frame" transform="matrix\(1 0 0 1 0 0\)" d="M10 100L110 100" fill="none" stroke="#000000" stroke-width="0\.72" stroke-linecap="butt" stroke-dasharray="0\.5 1"\/>/
  )
  assert.match(
    svg,
    /<text id="label" data-role="label" data-field-code="G44" transform="matrix\(1 0 0 1 20 50\) scale\(1 -1\)" font-family="Noto Sans JP" font-weight="400" font-size="10" letter-spacing="1\.5" text-anchor="middle" fill="#000000" xml:space="preserve">給与 &lt;A&amp;B&gt;<\/text>/
  )
  // 線も塗りもない記入欄は描かない
  assert.doesNotMatch(svg, /id="cell"/)
})

test('SVG: 輪郭Pathの Text はグリフの輪郭で出し、<text> は使わない', () => {
  const document = makeDocument([], [text('t', 'AB', 20, 50, { outline: true, fill: '#112233' })])
  const svg = pageToSvg(document.pages[0], layout)
  assert.doesNotMatch(svg, /<text/)
  assert.match(svg, /<g id="t" data-role="label" transform="matrix\(1 0 0 1 20 50\)" fill="#112233" aria-label="AB">/)
  assert.match(svg, /<path transform="translate\(0 0\) scale\(0\.01\)" d="M0 0L500 0L250 700Z"\/>/)
  assert.match(svg, /<path transform="translate\(5 0\) scale\(0\.01\)" d="M0 0L500 0L250 700Z"\/>/)
})

test('SVG: 属性に入る値はすべてエスケープし、数値でないものは 0 にする', () => {
  const hostile = '"><script>alert(1)</script>'
  const document = makeDocument(
    [],
    [
      line('a"b', 0, 0, 10, 0, { stroke: hostile, lineCap: hostile as 'butt', role: hostile as 'frame' }),
      text('t', "x'y", 0, 0, { fill: hostile, fontFamily: hostile, fontSize: hostile as unknown as number })
    ]
  )
  const svg = pageToSvg(document.pages[0], layout)
  assert.doesNotMatch(svg, /<script/)
  assert.doesNotMatch(svg, /"">/)
  assert.match(svg, /id="a&quot;b"/)
  assert.match(svg, /stroke-linecap="&quot;&gt;&lt;script&gt;/)
  assert.match(svg, /font-size="0"/)
  assert.match(svg, />x&apos;y<\/text>/)
})

test('外接矩形: Path は線幅の半分、Text は組んだ幅と字面を含む', () => {
  assert.deepEqual(exportBounds(line('l', 10, 100, 110, 100), layout), [9.5, 99.5, 110.5, 100.5])
  assert.deepEqual(exportBounds(text('t', 'ABCD', 20, 50), layout), [20, 48.8, 40, 58.8])
  assert.deepEqual(exportBounds(text('t', 'ABCD', 20, 50, { align: 'right' }), layout), [0, 48.8, 20, 58.8])
  assert.deepEqual(exportBounds(cell('c', 'G01', 1, 2, 3, 4), layout), [1, 2, 3, 4])
})

test('JSON: 確定オブジェクトの一覧と、項目コードごとの索引を出す', () => {
  const document = makeDocument(
    [text('candidate', 'G99', 0, 0, { fieldCode: 'G99' })],
    [
      line('rule', 10, 100, 110, 100),
      text('code', 'GO6', 20, 50, { role: 'fieldCode', fieldCode: 'G06', meta: { ocr: 'vision' } }),
      cell('cell', 'G06', 40, 48, 140, 62),
      text('zeros', '00', 120, 50, { fieldCode: 'G06' }),
      text('code2', 'G101', 20, 20, { role: 'fieldCode', fieldCode: 'G101' })
    ]
  )
  const json = buildExportJson(document, layout)
  assert.deepEqual(json.coordinateSystem, { unit: 'pt', origin: 'bottom-left', yAxis: 'up' })
  assert.deepEqual(json.sources, [{ id: 'src-1', fileName: 'form.pdf', sha256: 'abc' }])
  assert.equal(json.pages[0].sourceId, 'src-1')
  const [page] = json.pages
  assert.equal(page.pageNumber, 2)
  assert.deepEqual(
    page.objects.map((object) => object.id),
    ['rule', 'code', 'cell', 'zeros', 'code2']
  )
  const code = page.objects[1]
  assert.deepEqual(code.bounds, [20, 48.8, 35, 58.8])
  assert.equal('meta' in code, false)
  assert.equal('z' in code, false)
  // 数字として並べる(G06 → G101)
  assert.deepEqual(Object.keys(page.fields), ['G06', 'G101'])
  assert.deepEqual(page.fields.G06, {
    inputCells: [{ id: 'cell', bounds: [40, 48, 140, 62] }],
    printedCodes: [{ id: 'code', text: 'GO6', bounds: [20, 48.8, 35, 58.8] }],
    objectIds: ['code', 'cell', 'zeros']
  })
  assert.deepEqual(page.fields.G101.inputCells, [])
})

/** 白地に、指定した画素だけ黒いラスター */
function raster(width: number, height: number, ink: [number, number][]): GrayRaster {
  const data = new Uint8Array(width * height).fill(255)
  for (const [x, y] of ink) data[y * width + x] = 0
  return { width, height, data }
}
const row = (y: number, from: number, to: number): [number, number][] =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, y] as [number, number])

test('差分: 同じ絵なら 再現率 1 / 過剰率 0 / 不一致 0', () => {
  const a = raster(20, 10, row(5, 2, 17))
  const result = compareRasters(a, a)
  assert.equal(result.recall, 1)
  assert.equal(result.excess, 0)
  assert.equal(result.mismatch, 0)
  assert.equal(result.backgroundInk, 16)
  assert.equal(result.classes[5 * 20 + 2], DIFF_MATCH)
})

test('差分: 1画素のずれは許し、2画素のずれは欠落と過剰になる', () => {
  const background = raster(20, 10, row(5, 2, 17))
  const near = compareRasters(background, raster(20, 10, row(6, 2, 17)))
  assert.equal(near.recall, 1)
  assert.equal(near.excess, 0)

  const far = compareRasters(background, raster(20, 10, row(7, 2, 17)))
  assert.equal(far.recall, 0)
  assert.equal(far.excess, 1)
  assert.equal(far.mismatch, 32 / 200)
  assert.equal(far.classes[5 * 20 + 2], DIFF_MISSING)
  assert.equal(far.classes[7 * 20 + 2], DIFF_EXTRA)

  // 許容量を 0 にすれば1画素のずれも数える
  assert.equal(compareRasters(background, raster(20, 10, row(6, 2, 17)), { tolerancePx: 0 }).recall, 0)
})

test('差分: 一部だけ出力したときの再現率と、余計な線の過剰率', () => {
  const background = raster(40, 10, [...row(2, 0, 19), ...row(7, 0, 19)])
  // 上の線だけ再現し、背景にない線を10画素足す
  const output = raster(40, 10, [...row(2, 0, 19), ...row(4, 25, 34)])
  const result = compareRasters(background, output)
  assert.equal(result.recall, 0.5)
  assert.equal(result.excess, 10 / 30)
  assert.equal(result.mismatch, 30 / 400)
})

test('差分: インクがないときは 再現率 1 / 過剰率 0、大きさが違えば共通の範囲で比べる', () => {
  const blank = raster(10, 10, [])
  const result = compareRasters(blank, raster(12, 8, []))
  assert.equal(result.recall, 1)
  assert.equal(result.excess, 0)
  assert.equal(result.width, 10)
  assert.equal(result.height, 8)
})
