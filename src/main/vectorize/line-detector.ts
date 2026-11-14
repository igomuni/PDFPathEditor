// 罫線検出: 二値化した画素の水平・垂直の連なり(ラン)から、軸に平行な線分を取り出す。
// 実線は「長いラン」の束、点線は「短いランが等間隔に並ぶ列」の束として検出する。
// 座標はラスターの画素座標(左上原点、x右向き、y下向き)。画素 (x, y) は [x, x+1)×[y, y+1) を占める。

import type { GrayRaster } from '../../shared/vectorizer'

export interface LineDetectorOptions {
  /** これ未満の濃度値をインク(黒)とみなす */
  threshold: number
  /** 点線の検出に使うしきい値。細い点線は縁がぼけて薄く写るので、実線より緩くする */
  dashThreshold: number
  /** 実線とみなす最小の長さ(px)。文字の横画・縦画を拾わない程度に長くする */
  minLengthPx: number
  /** これより太い束は線ではなく塗り領域とみなして捨てる(px) */
  maxThicknessPx: number
  /** 点線の1点(ダッシュ)の最大長(px) */
  maxDashPx: number
  /** 点線の隙間の最大長(px) */
  maxDashGapPx: number
  /** 点線とみなす最小の点数。同一直線上の断片をつないだ後の数で判定する */
  minDashCount: number
  /** 点線とみなす最小の全長(px)。同一直線上の断片をつないだ後の長さで判定し、文字の中の細かい縞を落とす */
  minDashedLengthPx: number
  /**
   * これより短い実線は、採用済みの線に接しているときだけ残す(px)。
   * 文字の横画・縦画やQRコードのような、罫線につながらない短い線を落とす。0 で無効
   */
  isolatedMinLengthPx: number
  /** 太さ・位置・端点をそろえるときの許容差(px) */
  snapTolerancePx: number
}

export const DEFAULT_LINE_DETECTOR_OPTIONS: LineDetectorOptions = {
  threshold: 128,
  dashThreshold: 200,
  minLengthPx: 40,
  maxThicknessPx: 24,
  maxDashPx: 16,
  maxDashGapPx: 16,
  minDashCount: 8,
  minDashedLengthPx: 60,
  isolatedMinLengthPx: 150,
  snapTolerancePx: 1.5
}

export interface DetectedLine {
  /** h: 水平(start/end は x、center は y) / v: 垂直(start/end は y、center は x) */
  orientation: 'h' | 'v'
  start: number
  end: number
  /** 線の中心(線に直交する方向の位置) */
  center: number
  thickness: number
  /** 点線の [点の長さ, 隙間の長さ](px)。実線は null。最初の点は start から始まる */
  dash: [number, number] | null
  /** 線の濃度値(0 = 黒) */
  gray: number
}

// アンチエイリアスの縁として線に含める濃さ(0〜1)の上限。これ以上濃い隣接画素は別の図形とみなす
const EDGE_DARKNESS_LIMIT = 0.6
const DASH_TOLERANCE_PX = 1.5
// 1行の中で点線の断片とみなす最小の点数。断片は後で同一直線上のものをつなぐ
const MIN_CHAIN_DASHES = 4

interface Runs {
  /** rowStart[y] 〜 rowStart[y+1] が y 行目のラン */
  rowStart: Int32Array
  x0: Int32Array
  x1: Int32Array
}

function collectRuns(raster: GrayRaster, threshold: number): Runs {
  const { width, height, data } = raster
  const rowStart = new Int32Array(height + 1)
  const x0: number[] = []
  const x1: number[] = []
  for (let y = 0; y < height; y++) {
    rowStart[y] = x0.length
    const base = y * width
    let x = 0
    while (x < width) {
      if (data[base + x] >= threshold) {
        x++
        continue
      }
      const begin = x
      while (x < width && data[base + x] < threshold) x++
      x0.push(begin)
      x1.push(x)
    }
  }
  rowStart[height] = x0.length
  return { rowStart, x0: Int32Array.from(x0), x1: Int32Array.from(x1) }
}

class UnionFind {
  private parent: Int32Array
  constructor(size: number) {
    this.parent = new Int32Array(size)
    for (let i = 0; i < size; i++) this.parent[i] = i
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]]
      i = this.parent[i]
    }
    return i
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b)
  }
}

interface Span {
  row: number
  x0: number
  x1: number
}

/** 隣り合う行で x 範囲が minOverlap 以上重なるスパンを束ねる。spans は行の昇順であること */
function groupSpans<T extends Span>(spans: T[], minOverlap: (a: T, b: T) => number): T[][] {
  const uf = new UnionFind(spans.length)
  let prevBegin = 0
  let curBegin = 0
  while (curBegin < spans.length) {
    const row = spans[curBegin].row
    let curEnd = curBegin
    while (curEnd < spans.length && spans[curEnd].row === row) curEnd++
    if (prevBegin < curBegin && spans[prevBegin].row === row - 1) {
      for (let i = curBegin; i < curEnd; i++) {
        for (let j = prevBegin; j < curBegin; j++) {
          const overlap = Math.min(spans[i].x1, spans[j].x1) - Math.max(spans[i].x0, spans[j].x0)
          if (overlap >= minOverlap(spans[i], spans[j])) uf.union(i, j)
        }
      }
    }
    prevBegin = curBegin
    curBegin = curEnd
  }
  const groups = new Map<number, T[]>()
  spans.forEach((span, i) => {
    const root = uf.find(i)
    const group = groups.get(root)
    if (group) group.push(span)
    else groups.set(root, [span])
  })
  return [...groups.values()]
}

function darkness(raster: GrayRaster, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0
  return (255 - raster.data[y * raster.width + x]) / 255
}

/** y 行の [xa, xb) の平均の濃さ */
function rowDarkness(raster: GrayRaster, y: number, xa: number, xb: number): number {
  if (xb <= xa) return 0
  let sum = 0
  for (let x = xa; x < xb; x++) sum += darkness(raster, x, y)
  return sum / (xb - xa)
}

/** x 列の [ya, yb) の平均の濃さ */
function columnDarkness(raster: GrayRaster, x: number, ya: number, yb: number): number {
  if (yb <= ya) return 0
  let sum = 0
  for (let y = ya; y < yb; y++) sum += darkness(raster, x, y)
  return sum / (yb - ya)
}

/**
 * 行 [top, bottom) を芯とする帯の、太さと中心をサブピクセルで求める。
 * 芯の上下1行は、アンチエイリアスの縁なら濃さの分だけ太さに加える。
 */
function measureBand(
  raster: GrayRaster,
  top: number,
  bottom: number,
  xa: number,
  xb: number
): { thickness: number; center: number; peak: number } {
  let total = 0
  let moment = 0
  let peak = 0
  for (let y = top - 1; y <= bottom; y++) {
    const dark = rowDarkness(raster, y, xa, xb)
    const isCore = y >= top && y < bottom
    if (!isCore && dark >= EDGE_DARKNESS_LIMIT) continue
    total += dark
    moment += dark * (y + 0.5)
    if (dark > peak) peak = dark
  }
  return { thickness: total, center: total > 0 ? moment / total : (top + bottom) / 2, peak }
}

interface Piece {
  a: number
  b: number
  top: number
  count: number
  /** 束そのものの端か(別の区間に続いていないか) */
  openStart?: boolean
  openEnd?: boolean
}

/** 束を、太さと位置が一定の区間に分ける(太い枠線の延長に細い線が続く場合など) */
function splitByProfile(group: Span[], minLength: number): Piece[] {
  let gx0 = Infinity
  let gx1 = -Infinity
  for (const span of group) {
    gx0 = Math.min(gx0, span.x0)
    gx1 = Math.max(gx1, span.x1)
  }
  const width = gx1 - gx0
  const count = new Uint16Array(width)
  const top = new Int32Array(width).fill(0x7fffffff)
  for (const span of group) {
    for (let x = span.x0; x < span.x1; x++) {
      count[x - gx0]++
      if (span.row < top[x - gx0]) top[x - gx0] = span.row
    }
  }

  const pieces: Piece[] = []
  for (let i = 0; i < width; i++) {
    const last = pieces.at(-1)
    if (last && last.top === top[i] && last.count === count[i]) last.b = gx0 + i + 1
    else pieces.push({ a: gx0 + i, b: gx0 + i + 1, top: top[i], count: count[i] })
  }

  // 短い区間(端の欠けなど)は、隣の長いほうに吸収する
  for (;;) {
    let shortest = -1
    for (let i = 0; i < pieces.length; i++) {
      const length = pieces[i].b - pieces[i].a
      if (length < minLength && (shortest < 0 || length < pieces[shortest].b - pieces[shortest].a)) shortest = i
    }
    if (shortest < 0 || pieces.length === 1) break
    const left = pieces[shortest - 1]
    const right = pieces[shortest + 1]
    const target = !right || (left && left.b - left.a >= right.b - right.a) ? left : right
    if (target === left) left.b = pieces[shortest].b
    else right.a = pieces[shortest].a
    pieces.splice(shortest, 1)
    for (let i = pieces.length - 1; i > 0; i--) {
      if (pieces[i].top === pieces[i - 1].top && pieces[i].count === pieces[i - 1].count) {
        pieces[i - 1].b = pieces[i].b
        pieces.splice(i, 1)
      }
    }
  }
  for (const piece of pieces) {
    piece.openStart = piece.a === gx0
    piece.openEnd = piece.b === gx1
  }
  return pieces.filter((piece) => piece.b - piece.a >= minLength)
}

function detectSolid(raster: GrayRaster, runs: Runs, options: LineDetectorOptions): DetectedLine[] {
  const spans: Span[] = []
  for (let y = 0; y < raster.height; y++) {
    for (let i = runs.rowStart[y]; i < runs.rowStart[y + 1]; i++) {
      if (runs.x1[i] - runs.x0[i] >= options.minLengthPx) spans.push({ row: y, x0: runs.x0[i], x1: runs.x1[i] })
    }
  }
  const lines: DetectedLine[] = []
  for (const group of groupSpans(spans, () => 1)) {
    for (const piece of splitByProfile(group, options.minLengthPx)) {
      if (piece.count > options.maxThicknessPx) continue
      const top = piece.top
      const bottom = piece.top + piece.count
      // 端は別の線との接続部で乱れやすいので、内側だけで太さを測る
      const margin = Math.min(3, Math.floor((piece.b - piece.a) / 4))
      const band = measureBand(raster, top, bottom, piece.a + margin, piece.b - margin)
      // 束の端では、その先の1画素がアンチエイリアスの縁なら濃さの分だけ伸ばす
      const before = piece.openStart ? columnDarkness(raster, piece.a - 1, top, bottom) : 0
      const after = piece.openEnd ? columnDarkness(raster, piece.b, top, bottom) : 0
      lines.push({
        orientation: 'h',
        start: piece.a - (before < EDGE_DARKNESS_LIMIT ? before : 0),
        end: piece.b + (after < EDGE_DARKNESS_LIMIT ? after : 0),
        center: band.center,
        thickness: band.thickness,
        dash: null,
        gray: Math.round(255 * (1 - band.peak))
      })
    }
  }
  return lines
}

interface Chain extends Span {
  /** 点の数 */
  n: number
  /** 点の長さの合計 */
  inkLength: number
}

function detectDashed(raster: GrayRaster, runs: Runs, options: LineDetectorOptions): DetectedLine[] {
  const chains: Chain[] = []
  for (let y = 0; y < raster.height; y++) {
    const end = runs.rowStart[y + 1]
    let i = runs.rowStart[y]
    while (i < end) {
      const length0 = runs.x1[i] - runs.x0[i]
      if (length0 > options.maxDashPx) {
        i++
        continue
      }
      // i から、長さと隙間がそろったランが続く限り伸ばす。そろい具合はそれまでの平均と比べる
      let j = i
      let inkLength = length0
      let gapTotal = 0
      while (j + 1 < end) {
        const count = j - i + 1
        const length = runs.x1[j + 1] - runs.x0[j + 1]
        const gap = runs.x0[j + 1] - runs.x1[j]
        if (gap > options.maxDashGapPx || Math.abs(length - inkLength / count) > DASH_TOLERANCE_PX) break
        if (count > 1 && Math.abs(gap - gapTotal / (count - 1)) > DASH_TOLERANCE_PX) break
        inkLength += length
        gapTotal += gap
        j++
      }
      const n = j - i + 1
      if (n >= MIN_CHAIN_DASHES) chains.push({ row: y, x0: runs.x0[i], x1: runs.x1[j], n, inkLength })
      // 並びの末尾のランは、次の並びの先頭にもなりうる
      i = Math.max(j, i + 1)
    }
  }

  const lines: DetectedLine[] = []
  const overlapNeeded = (a: Chain, b: Chain): number => 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0)
  for (const group of groupSpans(chains, overlapNeeded)) {
    const top = group[0].row
    const bottom = group.at(-1)!.row + 1
    if (bottom - top > options.maxDashPx) continue
    // 点がいちばん長く写っている行を代表にする
    const main = group.reduce((best, chain) => (chain.inkLength > best.inkLength ? chain : best))
    const on = main.inkLength / main.n
    const period = main.n > 1 ? (main.x1 - main.x0 - on) / (main.n - 1) : on * 2
    const band = measureBand(raster, top, bottom, main.x0, main.x1)
    if (band.peak <= 0) continue
    lines.push({
      orientation: 'h',
      start: main.x0,
      end: main.x1,
      center: band.center,
      // 行の平均の濃さは隙間のぶん薄まるので、いちばん濃い行との比で太さを出す
      thickness: band.thickness / band.peak,
      dash: [on, Math.max(period - on, 0)],
      gray: 0
    })
  }
  return mergeCollinearDashed(lines, options).filter((line) => {
    const length = line.end - line.start
    const period = line.dash ? line.dash[0] + line.dash[1] : length
    return length >= options.minDashedLengthPx && length / period >= options.minDashCount - 0.5
  })
}

/** 同一直線上で、周期がそろっていて隙間ぶんしか離れていない点線の断片を1本につなぐ */
function mergeCollinearDashed(lines: DetectedLine[], options: LineDetectorOptions): DetectedLine[] {
  const period = (line: DetectedLine): number => (line.dash ? line.dash[0] + line.dash[1] : 0)
  const sorted = [...lines].sort((a, b) => a.start - b.start)
  const merged: DetectedLine[] = []
  for (const line of sorted) {
    const candidates = merged.filter(
      (other) =>
        Math.abs(other.center - line.center) <= 1 &&
        Math.abs(period(other) - period(line)) <= 0.75 &&
        line.start - other.end <= options.maxDashGapPx &&
        line.start - other.end >= -period(other)
    )
    const target = candidates.at(-1)
    if (!target) {
      merged.push({ ...line })
      continue
    }
    const targetLength = target.end - target.start
    const lineLength = line.end - line.start
    const total = targetLength + lineLength
    target.center = (target.center * targetLength + line.center * lineLength) / total
    target.thickness = (target.thickness * targetLength + line.thickness * lineLength) / total
    if (lineLength > targetLength) target.dash = line.dash
    target.end = Math.max(target.end, line.end)
  }
  return merged
}

function transpose(raster: GrayRaster): GrayRaster {
  const { width, height, data } = raster
  const out = new Uint8Array(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[x * height + y] = data[y * width + x]
  }
  return { width: height, height: width, data: out }
}

function detectHorizontal(raster: GrayRaster, options: LineDetectorOptions): DetectedLine[] {
  return [
    ...detectSolid(raster, collectRuns(raster, options.threshold), options),
    ...detectDashed(raster, collectRuns(raster, options.dashThreshold), options)
  ]
}

function touches(a: DetectedLine, b: DetectedLine, tolerance: number): boolean {
  if (a.orientation !== b.orientation) {
    // 直交: 互いの中心が相手の範囲に入っていれば、交差または接続している
    return (
      b.center >= a.start - tolerance - b.thickness / 2 &&
      b.center <= a.end + tolerance + b.thickness / 2 &&
      a.center >= b.start - tolerance - a.thickness / 2 &&
      a.center <= b.end + tolerance + a.thickness / 2
    )
  }
  // 平行: 同一直線上で端どうしが接している
  return (
    Math.abs(a.center - b.center) <= (a.thickness + b.thickness) / 2 &&
    a.start <= b.end + tolerance &&
    b.start <= a.end + tolerance
  )
}

/** 長い実線を起点に、そこへつながる短い実線だけを残す */
function dropIsolatedShortLines(lines: DetectedLine[], options: LineDetectorOptions): DetectedLine[] {
  if (options.isolatedMinLengthPx <= 0) return lines
  const solid = lines.filter((line) => !line.dash)
  const accepted = new Set(solid.filter((line) => line.end - line.start >= options.isolatedMinLengthPx))
  let pending = solid.filter((line) => !accepted.has(line))
  for (;;) {
    const members = [...accepted]
    const connected = pending.filter((line) =>
      members.some((other) => touches(line, other, options.snapTolerancePx))
    )
    if (connected.length === 0) break
    connected.forEach((line) => accepted.add(line))
    pending = pending.filter((line) => !accepted.has(line))
  }
  return lines.filter((line) => line.dash || accepted.has(line))
}

/** 近い値どうしをまとめ、各値をそのまとまりの中央値に置き換える対応表を返す */
function clusterValues(values: number[], tolerance: number): Map<number, number> {
  const sorted = [...values].sort((a, b) => a - b)
  const result = new Map<number, number>()
  let begin = 0
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] - sorted[i - 1] <= tolerance) continue
    const median = sorted[begin + Math.floor((i - 1 - begin) / 2)]
    for (let j = begin; j < i; j++) result.set(sorted[j], median)
    begin = i
  }
  return result
}

/**
 * 正規化: 測定のばらつきを取り、編集しやすい形にそろえる。
 * 1. 太さが近い実線は同じ太さにする
 * 2. 同じ向きで中心が近い線は同一直線上にそろえる
 * 3. 実線の端点が直交する実線の縁の近くにあれば、その縁にぴったり合わせる
 */
function normalize(lines: DetectedLine[], options: LineDetectorOptions): DetectedLine[] {
  const tolerance = options.snapTolerancePx
  const solid = lines.filter((line) => !line.dash)
  const thickness = clusterValues(
    solid.map((line) => line.thickness),
    tolerance / 4
  )
  const centers = {
    h: clusterValues(lines.filter((line) => line.orientation === 'h').map((line) => line.center), tolerance / 3),
    v: clusterValues(lines.filter((line) => line.orientation === 'v').map((line) => line.center), tolerance / 3)
  }
  const aligned = lines.map(
    (line): DetectedLine => ({
      ...line,
      thickness: line.dash ? line.thickness : (thickness.get(line.thickness) ?? line.thickness),
      center: centers[line.orientation].get(line.center) ?? line.center
    })
  )

  const alignedSolid = aligned.filter((line) => !line.dash)
  const snapEnd = (line: DetectedLine, value: number): number => {
    let best = value
    let bestDistance = tolerance
    for (const other of alignedSolid) {
      if (other.orientation === line.orientation) continue
      if (line.center < other.start - tolerance || line.center > other.end + tolerance) continue
      for (const edge of [other.center - other.thickness / 2, other.center + other.thickness / 2]) {
        const distance = Math.abs(edge - value)
        if (distance <= bestDistance) {
          best = edge
          bestDistance = distance
        }
      }
    }
    return best
  }
  return aligned.map((line) =>
    line.dash ? line : { ...line, start: snapEnd(line, line.start), end: snapEnd(line, line.end) }
  )
}

export function detectLines(raster: GrayRaster, overrides: Partial<LineDetectorOptions> = {}): DetectedLine[] {
  const options = { ...DEFAULT_LINE_DETECTOR_OPTIONS, ...overrides }
  const horizontal = detectHorizontal(raster, options)
  const vertical = detectHorizontal(transpose(raster), options).map(
    (line): DetectedLine => ({ ...line, orientation: 'v' })
  )
  return normalize(dropIsolatedShortLines([...horizontal, ...vertical], options), options)
}
