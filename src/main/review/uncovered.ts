// 候補に対応しない背景のインク(取れていない文字など)を、近いもの同士でまとめる。

export interface InkGroup {
  /** 画素の外接矩形(両端を含む) */
  x0: number
  y0: number
  x1: number
  y1: number
  /** インクの画素数 */
  ink: number
}

/** マスクを上下左右に radius 画素ずつ広げる */
export function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask
  const horizontal = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue
      const to = Math.min(width - 1, x + radius)
      for (let i = Math.max(0, x - radius); i <= to; i++) horizontal[row + i] = 1
    }
  }
  const result = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    const to = Math.min(height - 1, y + radius)
    for (let x = 0; x < width; x++) {
      if (!horizontal[y * width + x]) continue
      for (let i = Math.max(0, y - radius); i <= to; i++) result[i * width + x] = 1
    }
  }
  return result
}

/**
 * mask の画素を、mergeRadius 画素以内のもの同士でまとめる。minInk 未満の小さなまとまりは捨てる。
 * 上から下、左から右の順(行は rowTolerance 画素の幅で同じ行とみなす)に並べて返す。
 */
export function groupInk(
  mask: Uint8Array,
  width: number,
  height: number,
  options: { mergeRadius: number; minInk: number; rowTolerance: number }
): InkGroup[] {
  const merged = dilateMask(mask, width, height, options.mergeRadius)
  const seen = new Uint8Array(mask.length)
  const groups: InkGroup[] = []
  const stack: number[] = []
  for (let start = 0; start < merged.length; start++) {
    if (!merged[start] || seen[start]) continue
    const group: InkGroup = { x0: width, y0: height, x1: -1, y1: -1, ink: 0 }
    seen[start] = 1
    stack.push(start)
    while (stack.length > 0) {
      const i = stack.pop()!
      const x = i % width
      const y = (i - x) / width
      if (mask[i]) {
        group.ink++
        group.x0 = Math.min(group.x0, x)
        group.x1 = Math.max(group.x1, x)
        group.y0 = Math.min(group.y0, y)
        group.y1 = Math.max(group.y1, y)
      }
      if (x > 0 && merged[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), stack.push(i - 1)
      if (x < width - 1 && merged[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), stack.push(i + 1)
      if (y > 0 && merged[i - width] && !seen[i - width]) (seen[i - width] = 1), stack.push(i - width)
      if (y < height - 1 && merged[i + width] && !seen[i + width]) (seen[i + width] = 1), stack.push(i + width)
    }
    if (group.ink >= options.minInk) groups.push(group)
  }
  return groups.sort((a, b) => (Math.abs(a.y0 - b.y0) > options.rowTolerance ? a.y0 - b.y0 : a.x0 - b.x0))
}
