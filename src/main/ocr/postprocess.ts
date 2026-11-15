// OCR 結果の後処理(エンジン共通)。罫線での分割、文字列の整形、インクの範囲とフォントに合わせた配置の推定。
import type { OcrLine, PixelBox } from '../../shared/ocr.ts'
import type { GrayRaster } from '../../shared/vectorizer.ts'
import type { DetectedLine } from '../vectorize/line-detector.ts'

const CJK = /[぀-ヿ㐀-鿿豈-﫿＀-￯　-〿]/

/** 均等割り付けで入った空白を取る(和文どうしの間だけ)。欧文・数字の語間の空白は残す */
export function cleanText(text: string): string {
  const chars = [...text.trim()]
  return chars
    .filter((char, i) => {
      if (!/\s/.test(char)) return true
      let before = i - 1
      while (before >= 0 && /\s/.test(chars[before])) before--
      let after = i + 1
      while (after < chars.length && /\s/.test(chars[after])) after++
      return !(before >= 0 && after < chars.length && CJK.test(chars[before]) && CJK.test(chars[after]))
    })
    .join('')
    .replace(/\s+/g, ' ')
}

function unionBox(boxes: PixelBox[]): PixelBox {
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.width))
  const y1 = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * 縦の罫線をまたいで1行に読まれたもの(「区分K05」など)を、罫線の位置で分ける。
 * 文字ごとの位置が分からない行はそのまま返す。
 */
export function splitAtRules(lines: OcrLine[], rules: DetectedLine[]): OcrLine[] {
  const verticals = rules.filter((rule) => rule.orientation === 'v')
  const result: OcrLine[] = []
  for (const line of lines) {
    const chars = [...line.text]
    const { box } = line
    const cuts = verticals
      .filter((rule) => {
        const overlap = Math.min(rule.end, box.y + box.height) - Math.max(rule.start, box.y)
        return overlap >= box.height / 2 && rule.center > box.x && rule.center < box.x + box.width
      })
      .map((rule) => rule.center)
      .sort((a, b) => a - b)
    if (cuts.length === 0 || chars.length !== line.chars.length) {
      result.push(line)
      continue
    }
    // 各文字を、中心がどの区間にあるかで振り分ける。位置のない文字(空白など)は直前の文字に従う
    const groups = new Map<number, number[]>()
    let segment = 0
    chars.forEach((_, i) => {
      const charBox = line.chars[i]
      if (charBox && charBox.width > 0) {
        const center = charBox.x + charBox.width / 2
        segment = cuts.filter((cut) => cut <= center).length
      }
      const group = groups.get(segment)
      if (group) group.push(i)
      else groups.set(segment, [i])
    })
    if (groups.size === 1) {
      result.push(line)
      continue
    }
    for (const indices of [...groups.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])) {
      // 前後の空白は落とす
      while (indices.length > 0 && /\s/.test(chars[indices[0]])) indices.shift()
      while (indices.length > 0 && /\s/.test(chars[indices.at(-1)!])) indices.pop()
      const boxes = indices.map((i) => line.chars[i]).filter((b): b is PixelBox => b !== null && b.width > 0)
      if (indices.length === 0 || boxes.length === 0) continue
      result.push({
        text: indices.map((i) => chars[i]).join(''),
        confidence: line.confidence,
        box: unionBox(boxes),
        chars: indices.map((i) => line.chars[i])
      })
    }
  }
  return result
}

export interface InkBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * box の中のインク(threshold 未満の画素)の外接矩形を求める。罫線の上の画素は数えない。
 * インクがなければ null。
 */
export function tightInkBox(raster: GrayRaster, box: PixelBox, rules: DetectedLine[], threshold: number): InkBox | null {
  const bx0 = Math.max(0, Math.floor(box.x))
  const by0 = Math.max(0, Math.floor(box.y))
  const bx1 = Math.min(raster.width, Math.ceil(box.x + box.width))
  const by1 = Math.min(raster.height, Math.ceil(box.y + box.height))
  // 罫線の帯(1px の余裕つき)を [x0, y0, x1, y1] で持つ
  const bands = rules
    .map((rule) => {
      const half = rule.thickness / 2 + 1
      return rule.orientation === 'h'
        ? [rule.start, rule.center - half, rule.end, rule.center + half]
        : [rule.center - half, rule.start, rule.center + half, rule.end]
    })
    .filter((band) => band[0] < bx1 && band[2] > bx0 && band[1] < by1 && band[3] > by0)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      if (raster.data[y * raster.width + x] >= threshold) continue
      if (bands.some((band) => x + 1 > band[0] && x < band[2] && y + 1 > band[1] && y < band[3])) continue
      if (x < x0) x0 = x
      if (x + 1 > x1) x1 = x + 1
      if (y < y0) y0 = y
      if (y + 1 > y1) y1 = y + 1
    }
  }
  return x1 > x0 ? { x0, y0, x1, y1 } : null
}

/** フォントサイズ 1 のときの、文字列のインクの範囲(原点=ベースライン左端からの距離) */
export interface InkMetrics {
  /** 原点から左へ */
  left: number
  /** 原点から右へ */
  right: number
  ascent: number
  descent: number
}

export interface TextFit {
  /** ベースライン左端の位置(画素座標) */
  originX: number
  baselineY: number
  fontSize: number
  letterSpacing: number
}

// 字間を詰めすぎる推定は誤認識のことが多いので、ここまでに抑える(em)
const MIN_LETTER_SPACING_EM = -0.1

/**
 * インクの外接矩形に、指定フォントで組んだ文字列がぴったり重なるよう、サイズ・位置・字間を決める。
 * 高さからサイズを、幅の余りから字間を出す。
 */
export function fitText(ink: InkBox, charCount: number, metrics: InkMetrics): TextFit | null {
  const inkHeight = metrics.ascent + metrics.descent
  const inkWidth = metrics.left + metrics.right
  if (inkHeight <= 0 || inkWidth <= 0) return null
  const fontSize = (ink.y1 - ink.y0) / inkHeight
  const spare = ink.x1 - ink.x0 - inkWidth * fontSize
  const letterSpacing = charCount > 1 ? Math.max(spare / (charCount - 1), MIN_LETTER_SPACING_EM * fontSize) : 0
  return {
    originX: ink.x0 + metrics.left * fontSize,
    baselineY: ink.y1 - metrics.descent * fontSize,
    fontSize,
    letterSpacing
  }
}
