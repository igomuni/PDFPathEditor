// 出力に共通の部品。フォントに依存する部分は LayoutText として外から受け取る(テストしやすくするため)。
import type { DocObject, Matrix, Page, Rect, TextObject } from '../../shared/model.ts'

/** 1行の Text を組んだ結果。座標は Text のローカル座標(原点=ベースライン上の基準点、y上向き、pt) */
export interface TextLayout {
  /** 行の左端の x(align による) */
  x0: number
  /** 送り幅の合計(末尾の字間は含めない) */
  width: number
  /** フォントの単位 → pt の倍率 */
  scale: number
  /** グリフの輪郭(フォントの単位、y上向きの SVG path データ)と、その原点の位置(pt) */
  glyphs: { d: string; x: number; y: number }[]
  /** 縦書きのときの外形 [x0, y0, x1, y1]。横書きでは省略(x0・width と字面から求める) */
  box?: Rect
}

export type LayoutText = (text: TextObject) => TextLayout

/** 出力対象は確定レイヤーのオブジェクト。奥から手前の順に返す */
export function exportedObjects(page: Page): DocObject[] {
  return page.layers
    .filter((layer) => layer.kind === 'confirmed')
    .flatMap((layer) => [...layer.objects].sort((a, b) => a.z - b.z))
}

/** 線も塗りもない Path(記入欄の範囲など)は描かない */
export function isDrawn(object: DocObject): boolean {
  return object.type !== 'path' || object.fill !== null || (object.stroke !== null && object.strokeWidth > 0)
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** 小数3桁(1/1000 pt)に丸める */
export const round3 = (value: number): number => Math.round(value * 1000) / 1000

/** ページ上の外接矩形(PDF座標)。Path は線幅の半分を含める。Text は画面と同じ字面(上 0.88em、下 0.12em) */
export function exportBounds(object: DocObject, layout: LayoutText): Rect {
  let corners: [number, number][]
  let pad = 0
  if (object.type === 'path') {
    corners = object.nodes.map((node) => [node.x, node.y])
    pad = object.stroke === null ? 0 : object.strokeWidth / 2
  } else {
    let box: Rect = [0, 0, 1, 1]
    if (object.type === 'text') {
      const laidOut = layout(object)
      box = laidOut.box ?? [laidOut.x0, -0.12 * object.fontSize, laidOut.x0 + laidOut.width, 0.88 * object.fontSize]
    }
    corners = [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[0], box[3]],
      [box[2], box[3]]
    ]
  }
  const points = corners.map(([x, y]) => apply(object.transform, x, y))
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return [
    round3(Math.min(...xs) - pad),
    round3(Math.min(...ys) - pad),
    round3(Math.max(...xs) + pad),
    round3(Math.max(...ys) + pad)
  ]
}
