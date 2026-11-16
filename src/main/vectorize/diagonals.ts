// 水平・垂直でない罫線の検出(design.md §3-59): セルの斜線と、角丸の枠の角(4分の1の円弧)。
// 水平・垂直の罫線を消した残りのインクから、細いまとまりを取り出して、直線か円弧かを当てはめる。
import type { GrayRaster } from '../../shared/vectorizer.ts'
import type { DetectedLine } from './line-detector.ts'

export interface DiagonalLine {
  x0: number
  y0: number
  x1: number
  y1: number
  /** 太さ(画素) */
  thickness: number
}

export interface CornerArc {
  /** 円の中心と半径(画素) */
  cx: number
  cy: number
  r: number
  /** 水平の罫線につながる端と、垂直の罫線につながる端 */
  hEnd: { x: number; y: number }
  vEnd: { x: number; y: number }
  thickness: number
}

export interface SlantedShapes {
  diagonals: DiagonalLine[]
  arcs: CornerArc[]
}

// 細い線は縁がぼけて薄く写るので、罫線の検出より緩いしきい値でインクとする
const INK_THRESHOLD = 170
// 罫線を消すときに、太さの外側へ広げる幅(画素)
const ERASE_MARGIN_PX = 2
const MIN_DIAGONAL_PX = 45
const MAX_THICKNESS_PX = 6
// 水平・垂直からこれ以上傾いているものを斜線とする(長さに対する比。0.1 で約 6 度)
const MIN_SLOPE = 0.1
// 同じ直線上の断片をつなぐときの、端どうしの隙間の上限(罫線をまたいだところで切れる)
const MAX_JOIN_GAP_PX = 30
const MIN_ARC_RADIUS_PX = 8
const MAX_ARC_RADIUS_PX = 140
// 円弧の端が罫線の端に届いているとみなす距離
const ARC_JOIN_PX = 5
// 円弧のまとまりの近くにある罫線を探す範囲と、円に乗っているとみなす外れの上限
const ARC_NEAR_PX = 14
const ARC_TOLERANCE_PX = 2.2
// 斜線の端を、元のインクに沿って伸ばす長さの上限
const MAX_EXTEND_PX = 12

interface Component {
  xs: number[]
  ys: number[]
}

function components(mask: Uint8Array, width: number, height: number): Component[] {
  const seen = new Uint8Array(mask.length)
  const found: Component[] = []
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const xs: number[] = []
    const ys: number[] = []
    seen[start] = 1
    stack.push(start)
    while (stack.length > 0) {
      const p = stack.pop()!
      const x = p % width
      const y = (p - x) / width
      xs.push(x)
      ys.push(y)
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
    found.push({ xs, ys })
  }
  return found
}

interface Segment extends DiagonalLine {
  /** 向き(単位ベクトル)と、インクの画素数 */
  ux: number
  uy: number
  ink: number
}

/** まとまりが細い直線なら、その両端を返す */
function fitSegment({ xs, ys }: Component): Segment | null {
  const n = xs.length
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += xs[i]
    my += ys[i]
  }
  mx /= n
  my /= n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  // 主軸の向き
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  let lo = Infinity
  let hi = -Infinity
  let worst = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    const along = dx * ux + dy * uy
    if (along < lo) lo = along
    if (along > hi) hi = along
    worst = Math.max(worst, Math.abs(dx * uy - dy * ux))
  }
  const length = hi - lo + 1
  if (length < 8) return null
  const thickness = n / length
  if (thickness > MAX_THICKNESS_PX || worst > thickness / 2 + 2 || n < length * 0.7) return null
  if (Math.abs(uy) < MIN_SLOPE || Math.abs(ux) < MIN_SLOPE) return null
  return { x0: mx + lo * ux + 0.5, y0: my + lo * uy + 0.5, x1: mx + hi * ux + 0.5, y1: my + hi * uy + 0.5, thickness, ux, uy, ink: n }
}

const segmentLength = (s: DiagonalLine): number => Math.hypot(s.x1 - s.x0, s.y1 - s.y0)

/** 同じ直線上にあって、端どうしが近い断片をつなぐ */
function joinSegments(segments: Segment[]): Segment[] {
  const list = [...segments]
  for (let merged = true; merged; ) {
    merged = false
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        if (Math.abs(a.ux * b.ux + a.uy * b.uy) < 0.998) continue
        // b の両端が、a の直線の近くにある
        const off = (x: number, y: number): number => Math.abs((x - a.x0) * a.uy - (y - a.y0) * a.ux)
        if (off(b.x0, b.y0) > 2.5 || off(b.x1, b.y1) > 2.5) continue
        const along = (x: number, y: number): number => (x - a.x0) * a.ux + (y - a.y0) * a.uy
        const la = segmentLength(a)
        const b0 = along(b.x0, b.y0)
        const b1 = along(b.x1, b.y1)
        const gap = Math.max(Math.min(b0, b1) - la, -Math.max(b0, b1))
        if (gap > MAX_JOIN_GAP_PX) continue
        const lo = Math.min(0, b0, b1)
        const hi = Math.max(la, b0, b1)
        list[i] = {
          ...a,
          x0: a.x0 + lo * a.ux,
          y0: a.y0 + lo * a.uy,
          x1: a.x0 + hi * a.ux,
          y1: a.y0 + hi * a.uy,
          thickness: (a.thickness * a.ink + b.thickness * b.ink) / (a.ink + b.ink),
          ink: a.ink + b.ink
        }
        list.splice(j, 1)
        merged = true
        break outer
      }
    }
  }
  return list
}

/** 最小二乗の円(Kåsa)。中心と半径、いちばん大きい外れを返す */
function fitCircle({ xs, ys }: Component): { cx: number; cy: number; r: number; worst: number } | null {
  const n = xs.length
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += xs[i]
    my += ys[i]
  }
  mx /= n
  my /= n
  let suu = 0
  let suv = 0
  let svv = 0
  let suuu = 0
  let svvv = 0
  let suvv = 0
  let svuu = 0
  for (let i = 0; i < n; i++) {
    const u = xs[i] - mx
    const v = ys[i] - my
    suu += u * u
    suv += u * v
    svv += v * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-6) return null
  const p = 0.5 * (suuu + suvv)
  const q = 0.5 * (svvv + svuu)
  const uc = (p * svv - q * suv) / det
  const vc = (q * suu - p * suv) / det
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n)
  const cx = mx + uc
  const cy = my + vc
  let worst = 0
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(Math.hypot(xs[i] - cx, ys[i] - cy) - r))
  return { cx: cx + 0.5, cy: cy + 0.5, r, worst }
}

/**
 * まとまりが角丸の角(4分の1の円弧)なら返す。
 * 角の円弧は、水平の罫線と垂直の罫線の両方に接する。そこで、近くにある罫線の端の組ごとに
 * 「両方に接する円」(未知数は半径だけ)を当てはめ、まとまりの画素がその円に乗るものを選ぶ。
 * 罫線につながらない曲線(括弧や文字)は、当てはまる罫線の組がないので拾わない。
 */
function fitArc(component: Component, rules: readonly DetectedLine[]): CornerArc | null {
  const { xs, ys } = component
  if (xs.length < 10) return null
  const rough = fitCircle(component)
  if (!rough) return null
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  let mx = 0
  let my = 0
  for (let i = 0; i < xs.length; i++) {
    x0 = Math.min(x0, xs[i])
    x1 = Math.max(x1, xs[i])
    y0 = Math.min(y0, ys[i])
    y1 = Math.max(y1, ys[i])
    mx += xs[i]
    my += ys[i]
  }
  if (x1 - x0 > MAX_ARC_RADIUS_PX || y1 - y0 > MAX_ARC_RADIUS_PX) return null
  // 円弧がある象限(中心から見た向き)。短い円弧でも、中心がどちら側にあるかは安定して決まる
  const qx = Math.sign(mx / xs.length + 0.5 - rough.cx)
  const qy = Math.sign(my / ys.length + 0.5 - rough.cy)
  if (qx === 0 || qy === 0) return null
  // 円弧が左にあれば水平の罫線は右へ伸びる(円弧に近いのは start)。上にあれば垂直の罫線は下へ伸びる
  const reach = ARC_NEAR_PX
  const hs = rules.filter((rule) => {
    if (rule.orientation !== 'h' || rule.dash !== null) return false
    const end = qx < 0 ? rule.start : rule.end
    const edge = qy < 0 ? y0 : y1
    return Math.abs(rule.center - edge) <= reach && end >= x0 - reach && end <= x1 + reach
  })
  const vs = rules.filter((rule) => {
    if (rule.orientation !== 'v' || rule.dash !== null) return false
    const end = qy < 0 ? rule.start : rule.end
    const edge = qx < 0 ? x0 : x1
    return Math.abs(rule.center - edge) <= reach && end >= y0 - reach && end <= y1 + reach
  })
  let best: (CornerArc & { worst: number }) | null = null
  for (const h of hs) {
    for (const v of vs) {
      for (let r = MIN_ARC_RADIUS_PX; r <= MAX_ARC_RADIUS_PX; r += 0.5) {
        // 両方の罫線に接する円の中心
        const cx = v.center - qx * r
        const cy = h.center - qy * r
        let worst = 0
        for (let i = 0; i < xs.length && worst <= ARC_TOLERANCE_PX; i++) {
          worst = Math.max(worst, Math.abs(Math.hypot(xs[i] + 0.5 - cx, ys[i] + 0.5 - cy) - r))
        }
        if (worst > ARC_TOLERANCE_PX || (best && best.worst <= worst)) continue
        // 罫線は、接点の近くまで来ている(円弧の一部を罫線として拾っていることがあるので、半径ぶんの余裕を見る)
        const hGap = Math.abs((qx < 0 ? h.start : h.end) - cx)
        const vGap = Math.abs((qy < 0 ? v.start : v.end) - cy)
        if (hGap > ARC_JOIN_PX + r * 0.5 || vGap > ARC_JOIN_PX + r * 0.5) continue
        best = { cx, cy, r, hEnd: { x: cx, y: h.center }, vEnd: { x: v.center, y: cy }, thickness: (h.thickness + v.thickness) / 2, worst }
      }
    }
  }
  if (!best) return null
  const { worst: _worst, ...arc } = best
  return arc
}

/** 水平・垂直の罫線(rules)を消した残りから、斜線と角丸の角を見つける */
export function findSlantedShapes(raster: GrayRaster, rules: readonly DetectedLine[]): SlantedShapes {
  const { width, height, data } = raster
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i] < INK_THRESHOLD ? 1 : 0
  const ink = mask.slice()
  for (const rule of rules) {
    if (rule.dash !== null) continue
    const half = rule.thickness / 2 + ERASE_MARGIN_PX
    const c0 = Math.max(0, Math.floor(rule.center - half))
    const c1 = Math.ceil(rule.center + half)
    const s0 = Math.max(0, Math.floor(rule.start) - ERASE_MARGIN_PX)
    const s1 = Math.ceil(rule.end) + ERASE_MARGIN_PX
    if (rule.orientation === 'h') {
      for (let y = c0; y <= Math.min(height - 1, c1); y++) mask.fill(0, y * width + s0, y * width + Math.min(width, s1 + 1))
    } else {
      for (let y = s0; y <= Math.min(height - 1, s1); y++) mask.fill(0, y * width + c0, y * width + Math.min(width, c1 + 1))
    }
  }
  const segments: Segment[] = []
  const arcs: CornerArc[] = []
  for (const component of components(mask, width, height)) {
    if (component.xs.length < 10 || component.xs.length > 60000) continue
    // 円弧を先に試す(短い円弧は直線にも当てはまるため。円弧は、接する罫線の組があるときだけ成り立つ)
    const arc = fitArc(component, rules)
    if (arc) {
      arcs.push(arc)
      continue
    }
    const segment = fitSegment(component)
    if (segment) segments.push(segment)
  }
  // 罫線を消したぶん両端が短くなっているので、元のインクが続くところまで伸ばす
  const inkNear = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = Math.floor(x) + dx
        const py = Math.floor(y) + dy
        if (px >= 0 && py >= 0 && px < width && py < height && ink[py * width + px]) return true
      }
    }
    return false
  }
  const extend = (x: number, y: number, ux: number, uy: number): { x: number; y: number } => {
    for (let step = 0; step < MAX_EXTEND_PX && inkNear(x + ux, y + uy); step++) {
      x += ux
      y += uy
    }
    return { x, y }
  }
  const diagonals = joinSegments(segments)
    .filter((segment) => segmentLength(segment) >= MIN_DIAGONAL_PX)
    .map((segment) => {
      const from = extend(segment.x0, segment.y0, -segment.ux, -segment.uy)
      const to = extend(segment.x1, segment.y1, segment.ux, segment.uy)
      return { x0: from.x, y0: from.y, x1: to.x, y1: to.y, thickness: segment.thickness }
    })
  return { diagonals, arcs }
}
