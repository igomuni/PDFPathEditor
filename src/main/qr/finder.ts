// QRコードの位置を見つける(design.md §3-54)。中身は読まず、3隅の「切り出しシンボル」から範囲だけを決める。
// 切り出しシンボルは、どの向きに横切っても 黒:白:黒:白:黒 = 1:1:3:1:1 になる。
import type { GrayRaster } from '../../shared/vectorizer.ts'

export interface PixelRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface FinderPattern {
  /** 中心(画素) */
  x: number
  y: number
  /** 1モジュール(QRの最小の正方形)の大きさ(画素) */
  module: number
}

/** 5つの並び(黒白黒白黒)が 1:1:3:1:1 に近いか。近ければ1モジュールの大きさを返す */
function finderModule(runs: readonly number[]): number | null {
  const total = runs[0] + runs[1] + runs[2] + runs[3] + runs[4]
  if (total < 7) return null
  const module = total / 7
  const slack = Math.max(1, module * 0.6)
  for (const i of [0, 1, 3, 4]) if (Math.abs(runs[i] - module) > slack) return null
  if (Math.abs(runs[2] - 3 * module) > slack * 1.5) return null
  return module
}

/** (x, y) を通る縦または横の並びを、中心の黒から外へたどる。1:1:3:1:1 なら中心と大きさを返す */
function crossCheck(dark: Uint8Array, width: number, height: number, x: number, y: number, vertical: boolean): { center: number; module: number } | null {
  const limit = vertical ? height : width
  const at = (p: number): number => (vertical ? dark[p * width + x] : dark[y * width + p])
  const origin = vertical ? y : x
  if (!at(origin)) return null
  const runs = [0, 0, 0, 0, 0]
  // 中心の黒 → 白 → 黒 を、手前側へ
  let p = origin
  while (p >= 0 && at(p)) p--
  const centerStart = p + 1
  let q = p
  while (q >= 0 && !at(q)) q--
  runs[1] = p - q
  p = q
  while (q >= 0 && at(q)) q--
  runs[0] = p - q
  // 向こう側へ
  p = origin
  while (p < limit && at(p)) p++
  const centerEnd = p
  runs[2] = centerEnd - centerStart
  q = p
  while (q < limit && !at(q)) q++
  runs[3] = q - p
  p = q
  while (q < limit && at(q)) q++
  runs[4] = q - p
  const module = finderModule(runs)
  return module === null ? null : { center: (centerStart + centerEnd) / 2, module }
}

/** 切り出しシンボルを探す。同じシンボルを何行も横切るので、近いものは1つにまとめる */
export function findFinderPatterns(raster: GrayRaster, threshold = 128): FinderPattern[] {
  const { width, height, data } = raster
  const dark = new Uint8Array(width * height)
  for (let i = 0; i < dark.length; i++) dark[i] = data[i] < threshold ? 1 : 0
  const hits: (FinderPattern & { count: number })[] = []
  for (let y = 0; y < height; y++) {
    const row = y * width
    // 行を、同じ色の並びに分ける
    const starts: number[] = []
    let x = 0
    while (x < width) {
      const start = x
      const value = dark[row + x]
      while (x < width && dark[row + x] === value) x++
      starts.push(start)
    }
    starts.push(width)
    for (let i = 0; i + 5 < starts.length; i++) {
      if (!dark[row + starts[i]]) continue
      const runs = [0, 1, 2, 3, 4].map((k) => starts[i + k + 1] - starts[i + k])
      if (finderModule(runs) === null) continue
      const cx = Math.floor((starts[i + 2] + starts[i + 3]) / 2)
      const v = crossCheck(dark, width, height, cx, y, true)
      if (!v) continue
      const cy = Math.floor(v.center)
      const h = crossCheck(dark, width, height, cx, Math.min(height - 1, cy), false)
      if (!h) continue
      const found = { x: h.center, y: v.center, module: (h.module + v.module) / 2 }
      const same = hits.find((hit) => Math.abs(hit.x - found.x) < hit.module * 2 && Math.abs(hit.y - found.y) < hit.module * 2)
      if (same) {
        same.x = (same.x * same.count + found.x) / (same.count + 1)
        same.y = (same.y * same.count + found.y) / (same.count + 1)
        same.module = (same.module * same.count + found.module) / (same.count + 1)
        same.count++
      } else hits.push({ ...found, count: 1 })
    }
  }
  // 1行しか当たらないものは、たまたま比が合っただけの線
  return hits.filter((hit) => hit.count >= 2).map(({ x, y, module }) => ({ x, y, module }))
}

/**
 * QRコードの範囲(画素)を返す。3つの切り出しシンボルが、傾いていない正方形の3隅にあるものを QR とみなす。
 * 範囲はシンボルの外側の端まで(余白は含めない)。
 */
export function findQrCodes(raster: GrayRaster, threshold = 128): PixelRect[] {
  const patterns = findFinderPatterns(raster, threshold)
  const found: PixelRect[] = []
  const used = new Set<number>()
  for (let i = 0; i < patterns.length; i++) {
    for (let j = i + 1; j < patterns.length; j++) {
      for (let k = j + 1; k < patterns.length; k++) {
        if (used.has(i) || used.has(j) || used.has(k)) continue
        const trio = [patterns[i], patterns[j], patterns[k]]
        const module = (trio[0].module + trio[1].module + trio[2].module) / 3
        if (trio.some((p) => Math.abs(p.module - module) > module * 0.3)) continue
        const xs = trio.map((p) => p.x)
        const ys = trio.map((p) => p.y)
        const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
        const side = maxX - minX
        // 中心どうしの間隔は、最小の QR(21モジュール)で 14 モジュール
        if (side < module * 12 || side > module * 175 || Math.abs(side - (maxY - minY)) > module * 2) continue
        // 3つとも、正方形の隅にある(同じ隅に2つはない)
        const corners = new Set(
          trio.map((p) => {
            const cx = Math.abs(p.x - minX) <= module * 1.5 ? 0 : Math.abs(p.x - maxX) <= module * 1.5 ? 1 : -1
            const cy = Math.abs(p.y - minY) <= module * 1.5 ? 0 : Math.abs(p.y - maxY) <= module * 1.5 ? 1 : -1
            return cx < 0 || cy < 0 ? 'x' : `${cx}${cy}`
          })
        )
        if (corners.has('x') || corners.size !== 3) continue
        used.add(i).add(j).add(k)
        const half = module * 3.5
        found.push({
          x0: Math.max(0, Math.floor(minX - half)),
          y0: Math.max(0, Math.floor(minY - half)),
          x1: Math.min(raster.width, Math.ceil(maxX + half)),
          y1: Math.min(raster.height, Math.ceil(maxY + half))
        })
      }
    }
  }
  return found.sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0)
}
