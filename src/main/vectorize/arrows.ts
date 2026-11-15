// 矢印の検出(design.md §3-55)。吹き出しから伸びる「細い線 + 先端の塗りつぶした三角」を見つける。
// 1. 細い線を消す(オープニング)と、塗りつぶした形だけが残る。その中から三角形を選ぶ
// 2. 三角形の底辺から、細い線(軸)を曲がり角も含めてたどる。軸のない三角形は矢印としない
import type { GrayRaster } from '../../shared/vectorizer.ts'

export interface ArrowPoint {
  x: number
  y: number
}

export interface Arrow {
  /** 先端の三角形(画素): 底辺の2点と、とがった先 */
  head: [ArrowPoint, ArrowPoint, ArrowPoint]
  /** 軸の折れ線(画素)。底辺の側から順に */
  shaft: ArrowPoint[]
  /** 軸の太さ(画素) */
  shaftWidth: number
}

// 細い線を消すときの半径(画素)。これより細い線(幅 2r+1 未満)は消える
const OPEN_RADIUS = 3
const MIN_HEAD_PX = 10
const MAX_HEAD_PX = 90
// 軸をたどるときに、1本の線として追う長さの上限
const MAX_RUN_PX = 600
const MIN_TURN_PX = 6

type Direction = 'up' | 'down' | 'left' | 'right'
const VECTORS: Record<Direction, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }

/** 正方形(一辺 2r+1)での収縮(all = true)または膨張(all = false) */
function morph(mask: Uint8Array, width: number, height: number, r: number, all: boolean): Uint8Array {
  const need = all ? 2 * r + 1 : 1
  const pass = (source: Uint8Array, length: number, lines: number, index: (line: number, i: number) => number): Uint8Array => {
    const out = new Uint8Array(source.length)
    const sums = new Int32Array(length + 1)
    for (let line = 0; line < lines; line++) {
      for (let i = 0; i < length; i++) sums[i + 1] = sums[i] + source[index(line, i)]
      for (let i = 0; i < length; i++) {
        const lo = Math.max(0, i - r)
        const hi = Math.min(length, i + r + 1)
        // 収縮では、端からはみ出す分はインクなしとして扱う
        if (sums[hi] - sums[lo] >= need) out[index(line, i)] = 1
      }
    }
    return out
  }
  const horizontal = pass(mask, width, height, (y, x) => y * width + x)
  return pass(horizontal, height, width, (x, y) => y * width + x)
}

interface Blob {
  x0: number
  y0: number
  x1: number
  y1: number
  area: number
  /** 行ごとの左端・右端、列ごとの上端・下端(どれも画素の番号。右端・下端はその画素を含む) */
  left: Int32Array
  right: Int32Array
  top: Int32Array
  bottom: Int32Array
}

function blobs(mask: Uint8Array, width: number, height: number): Blob[] {
  const seen = new Uint8Array(mask.length)
  const found: Blob[] = []
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const pixels: number[] = []
    let [x0, y0, x1, y1] = [width, height, -1, -1]
    seen[start] = 1
    stack.push(start)
    while (stack.length > 0) {
      const p = stack.pop()!
      pixels.push(p)
      const x = p % width
      const y = (p - x) / width
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const q = ny * width + nx
          if (mask[q] && !seen[q]) {
            seen[q] = 1
            stack.push(q)
          }
        }
      }
    }
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    if (w < MIN_HEAD_PX || h < MIN_HEAD_PX || w > MAX_HEAD_PX || h > MAX_HEAD_PX) continue
    const blob: Blob = {
      x0,
      y0,
      x1,
      y1,
      area: pixels.length,
      left: new Int32Array(h).fill(width),
      right: new Int32Array(h).fill(-1),
      top: new Int32Array(w).fill(height),
      bottom: new Int32Array(w).fill(-1)
    }
    for (const p of pixels) {
      const x = p % width
      const y = (p - x) / width
      if (x < blob.left[y - y0]) blob.left[y - y0] = x
      if (x > blob.right[y - y0]) blob.right[y - y0] = x
      if (y < blob.top[x - x0]) blob.top[x - x0] = y
      if (y > blob.bottom[x - x0]) blob.bottom[x - x0] = y
    }
    found.push(blob)
  }
  return found
}

/** 最小二乗の直線 value = a + b·t と、いちばん大きい外れ */
function fitLine(ts: number[], values: number[]): { a: number; b: number; worst: number } {
  const n = ts.length
  const mt = ts.reduce((s, t) => s + t, 0) / n
  const mv = values.reduce((s, v) => s + v, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (ts[i] - mt) * (values[i] - mv)
    den += (ts[i] - mt) ** 2
  }
  const b = den === 0 ? 0 : num / den
  const a = mv - b * mt
  return { a, b, worst: Math.max(...ts.map((t, i) => Math.abs(a + b * t - values[i]))) }
}

interface Head {
  direction: Direction
  points: [ArrowPoint, ArrowPoint, ArrowPoint]
  /** 底辺の幅と、底辺から先までの長さ(画素) */
  base: number
  length: number
}

/** 塗りつぶした形が、direction の向きにとがった三角形か。底辺から先へ向けて、幅がまっすぐ細くなることで判定する */
function headIn(blob: Blob, direction: Direction): (Head & { error: number }) | null {
  const vertical = direction === 'up' || direction === 'down'
  const n = vertical ? blob.y1 - blob.y0 + 1 : blob.x1 - blob.x0 + 1
  const across = vertical ? blob.x1 - blob.x0 + 1 : blob.y1 - blob.y0 + 1
  const forward = direction === 'down' || direction === 'right'
  // 底辺の側から i 番目の、幅方向の範囲 [lo, hi)
  const lo = (i: number): number => (vertical ? blob.left : blob.top)[forward ? i : n - 1 - i]
  const hi = (i: number): number => (vertical ? blob.right : blob.bottom)[forward ? i : n - 1 - i] + 1
  let widest = 0
  for (let i = 0; i < Math.ceil(n * 0.25); i++) widest = Math.max(widest, hi(i) - lo(i))
  if (widest < across * 0.85 || hi(n - 1) - lo(n - 1) > across * 0.65) return null
  const ts: number[] = []
  const los: number[] = []
  const his: number[] = []
  // 底辺の角は、細い線を消すときに 2r の範囲で欠けるので使わない。先のほうも丸まるので使わない
  for (let i = Math.max(Math.floor(n * 0.15), OPEN_RADIUS * 2); i < Math.ceil(n * 0.9); i++) {
    ts.push(i + 0.5)
    los.push(lo(i))
    his.push(hi(i))
  }
  if (ts.length < 4) return null
  const a = fitLine(ts, los)
  const b = fitLine(ts, his)
  const tolerance = Math.max(1.5, across * 0.08)
  if (a.worst > tolerance || b.worst > tolerance || b.b - a.b >= 0) return null
  // 2本の辺が交わるところが、とがった先
  const length = (a.a - b.a) / (b.b - a.b)
  if (length < n * 0.7 || length > n * 3 || length < across * 0.4 || length > across * 2.5) return null
  const origin = vertical ? (forward ? blob.y0 : blob.y1 + 1) : forward ? blob.x0 : blob.x1 + 1
  const sign = forward ? 1 : -1
  const at = (perp: number, t: number): ArrowPoint => (vertical ? { x: perp, y: origin + sign * t } : { x: origin + sign * t, y: perp })
  return {
    direction,
    points: [at(a.a, 0), at(b.a, 0), at(a.a + a.b * length, length)],
    base: b.a - a.a,
    length,
    error: a.worst + b.worst
  }
}

function findHead(blob: Blob): Head | null {
  const fill = blob.area / ((blob.x1 - blob.x0 + 1) * (blob.y1 - blob.y0 + 1))
  // 三角形は外接矩形の半分。細い線を消すと先と底辺の角が欠けて台形に近くなるので、上限はゆるくする
  // (四角や丸は、幅がまっすぐ細くなるかどうかの判定で外れる)
  if (fill < 0.36 || fill > 0.9) return null
  let best: (Head & { error: number }) | null = null
  for (const direction of Object.keys(VECTORS) as Direction[]) {
    const head = headIn(blob, direction)
    if (head && (!best || head.error < best.error)) best = head
  }
  return best
}

/** 軸をたどる。ink は元のインク(細い線を含む) */
function traceShaft(ink: Uint8Array, gray: Uint8Array, width: number, height: number, head: Head): { points: ArrowPoint[]; widths: number[] } | null {
  const maxThick = Math.max(5, Math.round(head.base * 0.35))
  const inkAt = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && ink[y * width + x] === 1
  /** (x, y) の近くを通る、(px, py) 方向のインクの並び。lo・hi は、その方向の座標(hi を含む) */
  const runAt = (x: number, y: number, px: number, py: number): { lo: number; hi: number } | null => {
    let found = false
    for (const offset of [0, -1, 1, -2, 2]) {
      if (inkAt(x + px * offset, y + py * offset)) {
        x += px * offset
        y += py * offset
        found = true
        break
      }
    }
    if (!found) return null
    let lo = 0
    let hi = 0
    while (lo > -MAX_RUN_PX && inkAt(x + px * (lo - 1), y + py * (lo - 1))) lo--
    while (hi < MAX_RUN_PX && inkAt(x + px * (hi + 1), y + py * (hi + 1))) hi++
    const base = px !== 0 ? x : y
    return { lo: base + lo, hi: base + hi }
  }
  const center = (x: number, y: number): ArrowPoint => ({ x: x + 0.5, y: y + 0.5 })
  const widths: number[] = []
  // 太さは、断面の濃さの合計で測る(薄い灰色の線は、1画素より細い線)
  const coverage = (x: number, y: number, px: number, py: number, run: { lo: number; hi: number }): number => {
    let sum = 0
    for (let q = run.lo; q <= run.hi; q++) sum += 255 - gray[(py !== 0 ? q : y) * width + (px !== 0 ? q : x)]
    return sum / 255
  }

  const trace = (x: number, y: number, dx: number, dy: number, depth: number): ArrowPoint[] => {
    // 進む向きと直交する向き
    const [px, py] = dx !== 0 ? [0, 1] : [1, 0]
    const points: ArrowPoint[] = []
    for (let step = 0; step < MAX_RUN_PX; step++) {
      const nx = x + dx
      const ny = y + dy
      const run = runAt(nx, ny, px, py)
      if (!run) break
      const c = px !== 0 ? x : y
      if (run.hi - run.lo + 1 > maxThick) {
        // 直交する線にぶつかった。片側にだけ伸びていれば曲がり角、両側に伸びていれば別の線(罫線や枠)に突き当たった
        const before = c - run.lo
        const after = run.hi - c
        if ((before > 4 && after > 4) || Math.max(before, after) < MIN_TURN_PX) break
        const far = before > after ? run.lo : run.hi
        const mid = Math.round((c + far) / 2)
        const thick = px !== 0 ? runAt(mid, ny, 0, 1) : runAt(nx, mid, 1, 0)
        if (!thick || thick.hi - thick.lo + 1 > maxThick) break
        const along = (thick.lo + thick.hi) / 2
        const corner = px !== 0 ? { x: c + 0.5, y: along + 0.5 } : { x: along + 0.5, y: c + 0.5 }
        const end = px !== 0 ? { x: far + 0.5, y: along + 0.5 } : { x: along + 0.5, y: far + 0.5 }
        points.push(corner, end)
        if (depth < 2) {
          // 端で、もう一度曲がっているか
          let best: ArrowPoint[] = []
          let bestLength = 0
          for (const sign of [1, -1]) {
            // 今たどった線の太さの外から始める(線そのものを、もう一度たどらないように)
            const edge = (dx + dy) * sign > 0 ? thick.hi : thick.lo
            const next = trace(px !== 0 ? far : edge, px !== 0 ? edge : far, dx * sign, dy * sign, depth + 1)
            const length = polylineLength([end, ...next])
            if (length >= MIN_TURN_PX && length > bestLength) {
              best = next
              bestLength = length
            }
          }
          points.push(...best)
        }
        return points
      }
      x = nx
      y = ny
      if (px !== 0) x = Math.round((run.lo + run.hi) / 2)
      else y = Math.round((run.lo + run.hi) / 2)
      widths.push(coverage(nx, ny, px, py, run))
    }
    points.push(center(x, y))
    return points
  }

  // 底辺のすぐ外側で、軸の断面を探す
  const [vx, vy] = VECTORS[head.direction]
  const [b1, b2] = head.points
  const vertical = vx === 0
  const baseLine = Math.round(vertical ? b1.y : b1.x) + (vertical ? (vy > 0 ? -1 : 0) : vx > 0 ? -1 : 0)
  const from = Math.floor(Math.min(vertical ? b1.x : b1.y, vertical ? b2.x : b2.y))
  const to = Math.ceil(Math.max(vertical ? b1.x : b1.y, vertical ? b2.x : b2.y))
  const middle = (from + to) / 2
  let start: { lo: number; hi: number } | null = null
  for (let p = from; p <= to; p++) {
    if (!(vertical ? inkAt(p, baseLine) : inkAt(baseLine, p))) continue
    let q = p
    while (q + 1 <= to + maxThick && (vertical ? inkAt(q + 1, baseLine) : inkAt(baseLine, q + 1))) q++
    if (q - p + 1 <= maxThick && (!start || Math.abs((p + q) / 2 - middle) < Math.abs((start.lo + start.hi) / 2 - middle))) start = { lo: p, hi: q }
    p = q
  }
  if (!start) return null
  const c = Math.round((start.lo + start.hi) / 2)
  const sx = vertical ? c : baseLine
  const sy = vertical ? baseLine : c
  // 軸は、底辺の上から始める(三角形とつながるように)
  const first: ArrowPoint = vertical ? { x: c + 0.5, y: b1.y } : { x: b1.x, y: c + 0.5 }
  return { points: [first, ...trace(sx, sy, -vx, -vy, 0)], widths }
}

const polylineLength = (points: ArrowPoint[]): number => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0)

/**
 * 背景ラスターから矢印を見つける。
 * 軸は細くて薄い灰色のことがある(1画素に満たない線)ので、三角形より薄いインクまで拾ってたどる。
 */
export function findArrows(raster: GrayRaster, threshold = 128, shaftThreshold = 215): Arrow[] {
  const { width, height, data } = raster
  const ink = new Uint8Array(width * height)
  const faint = new Uint8Array(width * height)
  for (let i = 0; i < ink.length; i++) {
    ink[i] = data[i] < threshold ? 1 : 0
    faint[i] = data[i] < shaftThreshold ? 1 : 0
  }
  const opened = morph(morph(ink, width, height, OPEN_RADIUS, true), width, height, OPEN_RADIUS, false)
  const arrows: Arrow[] = []
  for (const blob of blobs(opened, width, height)) {
    const head = findHead(blob)
    if (!head) continue
    const shaft = traceShaft(faint, data, width, height, head)
    if (!shaft || polylineLength(shaft.points) < Math.max(MIN_TURN_PX, head.length * 0.5)) continue
    if (shaft.widths.length === 0) continue
    const sorted = [...shaft.widths].sort((p, q) => p - q)
    arrows.push({ head: head.points, shaft: shaft.points, shaftWidth: sorted[sorted.length >> 1] })
  }
  return arrows.sort((p, q) => p.head[2].y - q.head[2].y || p.head[2].x - q.head[2].x)
}
