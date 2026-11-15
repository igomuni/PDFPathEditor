// 確定オブジェクトを SVG にする。座標は pt で、ページの左上が原点。
import type { ImageObject, Page, PathNode, PathObject, TextObject } from '../../shared/model.ts'
import { isVertical, verticalChars } from '../../shared/vertical.ts'
import { exportedObjects, isDrawn, round3, type LayoutText } from './layout.ts'

// document.json は手で編集されたり他所から持ち込まれたりするので、属性に入れる値はすべてここを通す
const escapeXml = (value: unknown): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/** 数値の属性。数値でなければ 0 にする */
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const matrix = (values: readonly number[]): string => `matrix(${values.map((value) => round3(num(value))).join(' ')})`

function pathData(nodes: PathNode[], closed: boolean): string {
  if (nodes.length === 0) return ''
  const segment = (from: PathNode, to: PathNode): string => {
    if (!from.out && !to.in) return `L${num(to.x)} ${num(to.y)}`
    const c1 = from.out ?? [from.x, from.y]
    const c2 = to.in ?? [to.x, to.y]
    return `C${num(c1[0])} ${num(c1[1])} ${num(c2[0])} ${num(c2[1])} ${num(to.x)} ${num(to.y)}`
  }
  let d = `M${num(nodes[0].x)} ${num(nodes[0].y)}`
  for (let i = 1; i < nodes.length; i++) d += segment(nodes[i - 1], nodes[i])
  if (closed) d += `${segment(nodes.at(-1)!, nodes[0])}Z`
  return d
}

/** 二次利用のため、ID・役割・項目コードを属性として残す */
function commonAttributes(object: { id: string; role: string; fieldCode: string | null }): string {
  const code = object.fieldCode === null ? '' : ` data-field-code="${escapeXml(object.fieldCode)}"`
  return `id="${escapeXml(object.id)}" data-role="${escapeXml(object.role)}"${code}`
}

function pathElement(object: PathObject): string {
  const attributes = [
    commonAttributes(object),
    `transform="${matrix(object.transform)}"`,
    `d="${pathData(object.nodes, object.closed)}"`,
    `fill="${escapeXml(object.fill ?? 'none')}"`,
    `stroke="${escapeXml(object.stroke ?? 'none')}"`
  ]
  if (object.stroke !== null) {
    attributes.push(`stroke-width="${num(object.strokeWidth)}"`, `stroke-linecap="${escapeXml(object.lineCap)}"`)
    if (object.dash) attributes.push(`stroke-dasharray="${object.dash.map(num).join(' ')}"`)
  }
  return `<path ${attributes.join(' ')}/>`
}

function textElement(object: TextObject, layout: LayoutText): string {
  if (object.outline) {
    // 文字をグリフの輪郭で描く(フォントがなくても同じ見た目になる。文字としては選択できない)
    const { glyphs: laidOut, scale } = layout(object)
    const glyphs = laidOut
      .filter((glyph) => glyph.d !== '')
      .map(
        (glyph) =>
          `<path transform="translate(${round3(glyph.x)} ${round3(glyph.y)}) scale(${Number(scale.toFixed(6))})" d="${escapeXml(glyph.d)}"/>`
      )
    return `<g ${commonAttributes(object)} transform="${matrix(object.transform)}" fill="${escapeXml(object.fill)}" aria-label="${escapeXml(object.text)}">${glyphs.join('')}</g>`
  }
  if (isVertical(object)) {
    // 縦書き: 1字ずつ中央揃えで下へ積み、縦書き用の字形(vert)を使う
    const spans = verticalChars(object)
      .map((item) => `<tspan x="0" y="${round3(num(item.baseline))}">${escapeXml(item.char)}</tspan>`)
      .join('')
    const attributes = [
      commonAttributes(object),
      'data-writing-mode="vertical"',
      `transform="${matrix(object.transform)} scale(1 -1)"`,
      `font-family="${escapeXml(object.fontFamily)}"`,
      `font-weight="${num(object.fontWeight)}"`,
      `font-size="${num(object.fontSize)}"`,
      'text-anchor="middle"',
      `fill="${escapeXml(object.fill)}"`,
      `style="font-feature-settings: 'vert'"`,
      'xml:space="preserve"'
    ]
    return `<text ${attributes.join(' ')}>${spans}</text>`
  }
  const anchor = object.align === 'left' ? 'start' : object.align === 'center' ? 'middle' : 'end'
  const attributes = [
    commonAttributes(object),
    // ローカル座標は y 上向きなので、文字が裏返らないよう上下を戻す
    `transform="${matrix(object.transform)} scale(1 -1)"`,
    `font-family="${escapeXml(object.fontFamily)}"`,
    `font-weight="${num(object.fontWeight)}"`,
    `font-size="${num(object.fontSize)}"`,
    `letter-spacing="${num(object.letterSpacing)}"`,
    `text-anchor="${anchor}"`,
    `fill="${escapeXml(object.fill)}"`,
    'xml:space="preserve"'
  ]
  return `<text ${attributes.join(' ')}>${escapeXml(object.text)}</text>`
}

/** asset のパス → PNG の中身 */
export type ImageBytes = ReadonlyMap<string, Uint8Array>

/** 画像は PNG を埋め込む。単位正方形(y上向き)に、上下を戻して置く */
function imageElement(object: ImageObject, images: ImageBytes): string {
  const bytes = images.get(object.asset)
  if (!bytes) return ''
  const attributes = [
    commonAttributes(object),
    `transform="${matrix(object.transform)} matrix(1 0 0 -1 0 1)"`,
    'x="0" y="0" width="1" height="1"',
    'preserveAspectRatio="none"',
    `href="data:image/png;base64,${Buffer.from(bytes).toString('base64')}"`
  ]
  return `<image ${attributes.join(' ')}/>`
}

export function pageToSvg(page: Page, layout: LayoutText, images: ImageBytes = new Map()): string {
  const [x0, y0, x1, y1] = page.mediaBox
  const width = round3(x1 - x0)
  const height = round3(y1 - y0)
  const elements = exportedObjects(page)
    .filter(isDrawn)
    .map((object) =>
      object.type === 'path' ? pathElement(object) : object.type === 'text' ? textElement(object, layout) : imageElement(object, images)
    )
    .filter((element) => element !== '')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}pt" height="${height}pt" viewBox="0 0 ${width} ${height}">`,
    // ここから内側はPDF座標(pt、左下原点)
    `<g transform="${matrix([1, 0, 0, -1, -x0, y1])}">`,
    ...elements,
    '</g>',
    '</svg>',
    ''
  ].join('\n')
}
