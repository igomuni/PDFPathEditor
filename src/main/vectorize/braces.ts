// 波括弧の検出(design.md §3-61)。帳票の波括弧は、縦の線の上下に同じ向きの短いかぎがあり、
// 中央に反対向きの小さな突起がある、ほかの線につながっていない形。
import type { GrayRaster } from '../../shared/vectorizer.ts'
import { components } from './diagonals.ts'

export interface Brace {
  /** 縦の線の中心の x、上下のかぎの中心の y(画素) */
  x: number
  top: number
  bottom: number
  /** かぎの先の x と、突起の先の x・y。かぎが左なら「｝」、右なら「｛」 */
  hookX: number
  tipX: number
  tipY: number
  thickness: number
}

const MIN_HEIGHT_PX = 40
const MAX_WIDTH_PX = 60
const MAX_STEM_PX = 8
// かぎ・突起とみなす、縦の線からの出っ張りの最小の長さ
const MIN_REACH_PX = 3

export function findBraces(raster: GrayRaster, threshold = 128): Brace[] {
  const { width, height, data } = raster
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i] < threshold ? 1 : 0
  const found: Brace[] = []
  for (const { xs, ys } of components(mask, width, height)) {
    if (xs.length < MIN_HEIGHT_PX) continue
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < x0) x0 = xs[i]
      if (xs[i] > x1) x1 = xs[i]
      if (ys[i] < y0) y0 = ys[i]
      if (ys[i] > y1) y1 = ys[i]
    }
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    if (h < MIN_HEIGHT_PX || w < 2 * MIN_REACH_PX + 1 || w > Math.min(MAX_WIDTH_PX, Math.max(16, h * 0.3))) continue
    const columns = new Int32Array(w)
    const rowMin = new Int32Array(h).fill(w)
    const rowMax = new Int32Array(h).fill(-1)
    for (let i = 0; i < xs.length; i++) {
      const cx = xs[i] - x0
      const cy = ys[i] - y0
      columns[cx]++
      if (cx < rowMin[cy]) rowMin[cy] = cx
      if (cx > rowMax[cy]) rowMax[cy] = cx
    }
    // 縦の線: ほぼ全部の行にインクがある列のまとまり
    let s0 = -1
    let s1 = -1
    for (let cx = 0; cx < w; cx++) {
      if (columns[cx] < h * 0.85) continue
      if (s0 < 0) s0 = cx
      else if (cx !== s1 + 1) {
        s0 = -2
        break
      }
      s1 = cx
    }
    if (s0 < 0) continue
    const t = s1 - s0 + 1
    if (t > MAX_STEM_PX) continue
    const edge = t + 3
    const middle = (h - 1) / 2
    const midHalf = Math.max(edge, h * 0.08)
    // 行ごとの、縦の線からの左右への出っ張り
    const reach = (from: number, to: number, side: -1 | 1): { length: number; row: number } => {
      let best = 0
      let sum = 0
      let count = 0
      for (let r = Math.max(0, Math.floor(from)); r <= Math.min(h - 1, Math.ceil(to)); r++) {
        const value = side < 0 ? s0 - rowMin[r] : rowMax[r] - s1
        if (value > best) {
          best = value
          sum = 0
          count = 0
        }
        if (value === best && best > 0) {
          sum += r
          count++
        }
      }
      return { length: best, row: count > 0 ? sum / count : (from + to) / 2 }
    }
    let plain = 0
    let plainRows = 0
    for (let r = edge; r < h - edge; r++) {
      if (Math.abs(r - middle) <= midHalf) continue
      plainRows++
      if (s0 - rowMin[r] <= 1 && rowMax[r] - s1 <= 1) plain++
    }
    if (plainRows === 0 || plain < plainRows * 0.85) continue
    for (const side of [-1, 1] as const) {
      const other = side < 0 ? 1 : -1
      const topHook = reach(0, edge - 1, side)
      const bottomHook = reach(h - edge, h - 1, side)
      const tip = reach(middle - midHalf, middle + midHalf, other)
      if (topHook.length < MIN_REACH_PX || bottomHook.length < MIN_REACH_PX || tip.length < MIN_REACH_PX) continue
      // かぎの反対側、突起の反対側には出っ張りがない
      if (reach(0, edge - 1, other).length > 1 || reach(h - edge, h - 1, other).length > 1 || reach(middle - midHalf, middle + midHalf, side).length > 1) continue
      const x = x0 + (s0 + s1 + 1) / 2
      const hook = (topHook.length + bottomHook.length) / 2
      found.push({
        x,
        top: y0 + t / 2,
        bottom: y1 + 1 - t / 2,
        hookX: x + side * (t / 2 + hook),
        tipX: x + other * (t / 2 + tip.length),
        tipY: y0 + tip.row + 0.5,
        thickness: t
      })
      break
    }
  }
  return found.sort((p, q) => p.top - q.top || p.x - q.x)
}
