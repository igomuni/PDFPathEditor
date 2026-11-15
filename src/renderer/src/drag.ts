// マウスドラッグでの移動量の計算(design.md §3-50)。
interface Point {
  x: number
  y: number
}

// 1/1000 pt に丸める(モデルの座標と同じ細かさ)
const round = (value: number): number => {
  const rounded = Math.round(value * 1000) / 1000
  return rounded === 0 ? 0 : rounded
}

/**
 * ドラッグの始点と現在位置(ビューポート上の CSS px)から、ページ上の移動量(pt、y は上向き)を出す。
 * constrain のときは、動きの大きいほうの軸だけに固定する(水平または垂直)。
 */
export function dragDelta(start: Point, current: Point, scale: number, constrain: boolean): Point {
  let dx = (current.x - start.x) / scale
  let dy = -(current.y - start.y) / scale
  if (constrain) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0
    else dx = 0
  }
  return { x: round(dx), y: round(dy) }
}
