// PDF座標(pt、左下原点、y上向き)と SVG座標(pt、ページ左上原点、y下向き)の変換層。
// モデルは常にPDF座標で持ち、表示のときだけここを通す。
import type { DocObject, Matrix, PathNode, Rect } from '../../shared/model'
import { textLocalBox } from './textMetrics'

export interface Point {
  x: number
  y: number
}

/** CSS の基準解像度(96px/inch)での 1pt あたりの px。ズーム100%の定義に使う */
export const CSS_PX_PER_PT = 96 / 72

export function pageSize(mediaBox: Rect): { width: number; height: number } {
  return { width: mediaBox[2] - mediaBox[0], height: mediaBox[3] - mediaBox[1] }
}

/** PDF座標 → SVG座標 の行列 */
export function pdfToSvgMatrix(mediaBox: Rect): Matrix {
  return [1, 0, 0, -1, -mediaBox[0], mediaBox[3]]
}

export function pdfToSvg(mediaBox: Rect, p: Point): Point {
  return { x: p.x - mediaBox[0], y: mediaBox[3] - p.y }
}

export function svgToPdf(mediaBox: Rect, p: Point): Point {
  return { x: p.x + mediaBox[0], y: mediaBox[3] - p.y }
}

export function matrixToSvg(m: Matrix): string {
  return `matrix(${m.join(' ')})`
}

/** 表示状態。(x, y) はビューポート左上に来る SVG座標、scale は 1pt あたりの CSS px */
export interface View {
  x: number
  y: number
  scale: number
}

export const MIN_SCALE = CSS_PX_PER_PT * 0.05
export const MAX_SCALE = CSS_PX_PER_PT * 64

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** ビューポート上の点(CSS px)→ SVG座標 */
export function viewportToSvg(view: View, p: Point): Point {
  return { x: view.x + p.x / view.scale, y: view.y + p.y / view.scale }
}

/** anchor(ビューポート上のCSS px)の下にある点を動かさずに拡大率を変える */
export function zoomAt(view: View, anchor: Point, nextScale: number): View {
  const scale = clampScale(nextScale)
  const fixed = viewportToSvg(view, anchor)
  return { x: fixed.x - anchor.x / scale, y: fixed.y - anchor.y / scale, scale }
}

export function panBy(view: View, dxPx: number, dyPx: number): View {
  return { ...view, x: view.x + dxPx / view.scale, y: view.y + dyPx / view.scale }
}

/** ページ全体が収まるように中央へ配置する */
export function fitPage(mediaBox: Rect, viewport: { width: number; height: number }, marginPx = 24): View {
  const page = pageSize(mediaBox)
  const scale = clampScale(
    Math.min(
      Math.max(1, viewport.width - marginPx * 2) / page.width,
      Math.max(1, viewport.height - marginPx * 2) / page.height
    )
  )
  return centerPage(mediaBox, viewport, scale)
}

export function centerPage(mediaBox: Rect, viewport: { width: number; height: number }, scale: number): View {
  const page = pageSize(mediaBox)
  return {
    x: (page.width - viewport.width / scale) / 2,
    y: (page.height - viewport.height / scale) / 2,
    scale
  }
}

/** 頂点列を SVG の path データにする。座標はそのまま(PDF座標)で、外側の変換に任せる */
export function pathData(nodes: PathNode[], closed: boolean): string {
  if (nodes.length === 0) return ''
  const segment = (from: PathNode, to: PathNode): string => {
    if (!from.out && !to.in) return `L${to.x} ${to.y}`
    const c1 = from.out ?? [from.x, from.y]
    const c2 = to.in ?? [to.x, to.y]
    return `C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${to.x} ${to.y}`
  }
  let d = `M${nodes[0].x} ${nodes[0].y}`
  for (let i = 1; i < nodes.length; i++) d += segment(nodes[i - 1], nodes[i])
  if (closed) d += `${segment(nodes.at(-1)!, nodes[0])}Z`
  return d
}

export function applyMatrix(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
}

/** オブジェクトのページ上の外接矩形(PDF座標)。線幅の半分を含める */
export function objectBounds(object: DocObject): Rect {
  let corners: Point[]
  if (object.type === 'path') {
    corners = object.nodes
  } else {
    // 画像は単位正方形、テキストは組んだときの外形
    const [x0, y0, x1, y1] = object.type === 'image' ? [0, 0, 1, 1] : textLocalBox(object)
    corners = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x0, y: y1 },
      { x: x1, y: y1 }
    ]
  }
  const points = corners.map((p) => applyMatrix(object.transform, p))
  const pad = object.type === 'path' ? object.strokeWidth / 2 : 0
  return [
    Math.min(...points.map((p) => p.x)) - pad,
    Math.min(...points.map((p) => p.y)) - pad,
    Math.max(...points.map((p) => p.x)) + pad,
    Math.max(...points.map((p) => p.y)) + pad
  ]
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}
