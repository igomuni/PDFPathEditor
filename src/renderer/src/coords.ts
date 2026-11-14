// PDF座標(pt、左下原点、y上向き)と SVG座標(pt、ページ左上原点、y下向き)の変換層。
// モデルは常にPDF座標で持ち、表示のときだけここを通す。
import type { Matrix, Rect } from '../../shared/model'

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
