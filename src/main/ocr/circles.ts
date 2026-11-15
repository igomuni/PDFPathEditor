// 丸囲みの文字(丸数字、丸囲みのカタカナ)を見つけるための、画像の解析(design.md §3-45)。
// OCR は丸囲みを外して数字だけを読んだり、丸ごと読み落としたりするので、丸(輪)を画像から直接探す。
import type { PixelRect } from './reread.ts'

export interface Ring {
  /** 中心と半径(線の中心までの距離)、線の太さ。画素単位 */
  cx: number
  cy: number
  radius: number
  thickness: number
  /** 輪の外接矩形 */
  box: PixelRect
  /** 輪の画素(mask の添字) */
  pixels: number[]
}

// 丸囲みの文字とみなす大きさ(px。300dpi で約 4〜19pt)
const MIN_SIZE_PX = 16
const MAX_SIZE_PX = 80
// 縦横の差の許容量(大きいほうに対する比)
const MAX_ASPECT_DIFF = 0.18
// 輪とみなす外周の範囲(外接円の半径に対する比)。中の数字が輪に触れてつながっていても、外周だけで判定する
const OUTER_BAND = 0.78
// 外周の、中心からの距離のばらつき(標準偏差 ÷ 平均)の上限。正方形の枠は 0.1 を超える
const MAX_RADIUS_SPREAD = 0.06
// 中心付近(半径の 0.6 倍まで)がこれ以上塗られていたら、輪ではなく塗りつぶした円
const MAX_CORE_FILL = 0.6
// 全周を 24 等分して、線が通っていなければならない区画の数(かすれを少し許す)
const ANGLE_BINS = 24
const MIN_ANGLE_BINS = 22
const MIN_THICKNESS_PX = 0.8
const MAX_THICKNESS_PX = 6
// 輪の内側に、文字とみなすインクが最低これだけあること
const MIN_INNER_INK = 6

/**
 * インクのマスクから、輪(中に何かが書いてある円)を探す。
 * 連結成分ごとに、中心からの距離がそろっていて全周にわたっているものを輪とみなす。
 */
export function findRings(mask: Uint8Array, width: number, height: number): Ring[] {
  const seen = new Uint8Array(mask.length)
  const rings: Ring[] = []
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    // 8近傍でつながった画素を集める
    const pixels: number[] = []
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    seen[start] = 1
    stack.push(start)
    while (stack.length > 0) {
      const i = stack.pop()!
      const x = i % width
      const y = (i - x) / width
      // 大きすぎる成分は輪ではないので、画素を覚えるのをやめる(たどるのは続ける)
      if (pixels.length <= MAX_SIZE_PX * MAX_SIZE_PX) pixels.push(i)
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          const j = ny * width + nx
          if (mask[j] && !seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        }
      }
    }
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    if (w < MIN_SIZE_PX || h < MIN_SIZE_PX || w > MAX_SIZE_PX || h > MAX_SIZE_PX) continue
    if (Math.abs(w - h) > MAX_ASPECT_DIFF * Math.max(w, h)) continue

    const cx = (x0 + x1 + 1) / 2
    const cy = (y0 + y1 + 1) / 2
    // 外周の画素だけを輪として調べる(中の数字が輪に触れて、同じ成分になっていることがある)
    const outerLimit = (OUTER_BAND * Math.min(w, h)) / 2
    const coreLimit = (0.6 * Math.min(w, h)) / 2
    const outer: number[] = []
    let sum = 0
    let sumSquares = 0
    let core = 0
    const bins = new Uint8Array(ANGLE_BINS)
    for (const i of pixels) {
      const dx = (i % width) + 0.5 - cx
      const dy = Math.floor(i / width) + 0.5 - cy
      const r = Math.hypot(dx, dy)
      if (r <= coreLimit) core++
      if (r <= outerLimit) continue
      outer.push(i)
      sum += r
      sumSquares += r * r
      bins[Math.min(ANGLE_BINS - 1, Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * ANGLE_BINS))] = 1
    }
    if (outer.length === 0) continue
    const radius = sum / outer.length
    const spread = Math.sqrt(Math.max(0, sumSquares / outer.length - radius * radius)) / radius
    if (spread > MAX_RADIUS_SPREAD) continue
    if (bins.reduce((count, bin) => count + bin, 0) < MIN_ANGLE_BINS) continue
    const thickness = outer.length / (2 * Math.PI * radius)
    if (thickness < MIN_THICKNESS_PX || thickness > MAX_THICKNESS_PX) continue
    if (core > MAX_CORE_FILL * Math.PI * coreLimit * coreLimit) continue
    const ring: Ring = { cx, cy, radius, thickness, box: { x0, y0, x1: x1 + 1, y1: y1 + 1 }, pixels: outer }
    // 中に何も書いていない丸(「〇」や図形)は対象にしない
    const inner = innerInk(mask, width, ring)
    if (!inner || inner.count < MIN_INNER_INK) continue
    rings.push(ring)
  }
  return rings
}

/** 輪の内側にあるインク(輪そのものは除く)の外接矩形と画素数。なければ null */
export function innerInk(mask: Uint8Array, width: number, ring: Ring): (PixelRect & { count: number }) | null {
  const limit = ring.radius - ring.thickness / 2 - 1
  const own = new Set(ring.pixels)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let count = 0
  for (let y = ring.box.y0; y < ring.box.y1; y++) {
    for (let x = ring.box.x0; x < ring.box.x1; x++) {
      const i = y * width + x
      if (!mask[i] || own.has(i)) continue
      if (Math.hypot(x + 0.5 - ring.cx, y + 0.5 - ring.cy) > limit) continue
      count++
      if (x < x0) x0 = x
      if (x + 1 > x1) x1 = x + 1
      if (y < y0) y0 = y
      if (y + 1 > y1) y1 = y + 1
    }
  }
  return count > 0 ? { x0, y0, x1, y1, count } : null
}

const CIRCLED_KATAKANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヰヱヲ'

/** 1〜50 の丸数字(Unicode にあるもの)。範囲外は null */
export function circledNumberChar(value: number): string | null {
  if (!Number.isInteger(value)) return null
  if (value >= 1 && value <= 20) return String.fromCodePoint(0x2460 + value - 1)
  if (value >= 21 && value <= 35) return String.fromCodePoint(0x3251 + value - 21)
  if (value >= 36 && value <= 50) return String.fromCodePoint(0x32b1 + value - 36)
  return null
}

export type CircledContent =
  /** 1つの文字で表せる(①〜㊿、㋐〜㋾) */
  | { kind: 'char'; char: string; number: number | null }
  /** Unicode にない丸数字(51 以上)。数字の Text と丸の Path で表す */
  | { kind: 'number'; digits: string; number: number }

/**
 * 輪の中を読んだ文字列から、丸囲みの中身を決める。数字(1〜99)かカタカナ1字以外は null。
 * OCR が数字を英字と読み違えたもの(O → 0、l / I → 1 など)は直す。
 */
export function parseCircled(text: string): CircledContent | null {
  const compact = text.replace(/\s+/g, '').normalize('NFKC')
  const digits = compact.replace(/[OoＯ〇]/g, '0').replace(/[lI|｜]/g, '1').replace(/[Ss]/g, '5').replace(/[Bb]/g, '8')
  if (/^[1-9]\d?$/.test(digits)) {
    const value = Number(digits)
    const char = circledNumberChar(value)
    return char ? { kind: 'char', char, number: value } : { kind: 'number', digits, number: value }
  }
  if ([...compact].length === 1) {
    const index = CIRCLED_KATAKANA.indexOf(compact)
    if (index >= 0) return { kind: 'char', char: String.fromCodePoint(0x32d0 + index), number: null }
  }
  return null
}
