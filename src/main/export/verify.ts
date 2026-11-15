// 自動差分検証: 出力PDFのラスターと背景ラスターを二値化して比べる。
import type { GrayRaster } from '../../shared/vectorizer.ts'

export interface CompareOptions {
  /** これ未満の濃度値をインクとみなす */
  threshold: number
  /** ずれを許す画素数。この範囲(正方形)に相手のインクがあれば一致とみなす */
  tolerancePx: number
}

export const DEFAULT_COMPARE_OPTIONS: CompareOptions = { threshold: 128, tolerancePx: 1 }

/** 画素ごとの分類 */
export const DIFF_NONE = 0
export const DIFF_MATCH = 1
/** 背景にだけある(欠落) */
export const DIFF_MISSING = 2
/** 出力にだけある(過剰) */
export const DIFF_EXTRA = 3

export interface RasterComparison {
  width: number
  height: number
  backgroundInk: number
  outputInk: number
  /** 再現率: 背景のインクのうち、出力に対応するインクがある割合。背景にインクがなければ 1 */
  recall: number
  /** 過剰率: 出力のインクのうち、背景に対応するインクがない割合。出力にインクがなければ 0 */
  excess: number
  /** 対応のないインク(欠落 + 過剰)が全画素に占める割合 */
  mismatch: number
  /** 画素ごとの分類(DIFF_*) */
  classes: Uint8Array
}

function binarize(raster: GrayRaster, width: number, height: number, threshold: number): Uint8Array {
  const ink = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * raster.width
    for (let x = 0; x < width; x++) if (raster.data[row + x] < threshold) ink[y * width + x] = 1
  }
  return ink
}

/** インクを上下左右に radius 画素ずつ広げる(正方形の膨張)。横と縦に分けて行う */
function dilate(ink: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return ink
  const horizontal = new Uint8Array(ink.length)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (!ink[row + x]) continue
      const from = Math.max(0, x - radius)
      const to = Math.min(width - 1, x + radius)
      for (let i = from; i <= to; i++) horizontal[row + i] = 1
    }
  }
  const result = new Uint8Array(ink.length)
  for (let y = 0; y < height; y++) {
    const from = Math.max(0, y - radius)
    const to = Math.min(height - 1, y + radius)
    for (let x = 0; x < width; x++) {
      if (!horizontal[y * width + x]) continue
      for (let i = from; i <= to; i++) result[i * width + x] = 1
    }
  }
  return result
}

/** 大きさが違うときは、左上を合わせて共通の範囲だけを比べる */
export function compareRasters(
  background: GrayRaster,
  output: GrayRaster,
  overrides: Partial<CompareOptions> = {}
): RasterComparison {
  const { threshold, tolerancePx } = { ...DEFAULT_COMPARE_OPTIONS, ...overrides }
  const width = Math.min(background.width, output.width)
  const height = Math.min(background.height, output.height)
  const b = binarize(background, width, height, threshold)
  const o = binarize(output, width, height, threshold)
  const nearB = dilate(b, width, height, tolerancePx)
  const nearO = dilate(o, width, height, tolerancePx)

  const classes = new Uint8Array(width * height)
  let backgroundInk = 0
  let outputInk = 0
  let missing = 0
  let extra = 0
  for (let i = 0; i < classes.length; i++) {
    if (b[i]) backgroundInk++
    if (o[i]) outputInk++
    if (b[i] && !nearO[i]) {
      missing++
      classes[i] = DIFF_MISSING
    } else if (o[i] && !nearB[i]) {
      extra++
      classes[i] = DIFF_EXTRA
    } else if (b[i] || o[i]) {
      classes[i] = DIFF_MATCH
    }
  }
  return {
    width,
    height,
    backgroundInk,
    outputInk,
    recall: backgroundInk === 0 ? 1 : (backgroundInk - missing) / backgroundInk,
    excess: outputInk === 0 ? 0 : extra / outputInk,
    mismatch: classes.length === 0 ? 0 : (missing + extra) / classes.length,
    classes
  }
}
