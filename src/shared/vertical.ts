// 縦書きの Text の組み方(design.md §3-41, 42)。画面・出力・確認用データで同じ計算を使う。
//
// ローカル座標(y上向き、pt)の原点は「1字目の仮想ボディ(全角の正方形)の上辺の中央」。
// 文字は1字ずつ正立で上から下へ積み、各文字は左右の中央に置く。1字の送りは fontSize + letterSpacing。
// 括弧・長音・句読点は、フォントの縦書き用の字形(OpenType の vert)に切り替える。
import type { Rect, TextObject } from './model.ts'

/** 和文フォントの仮想ボディの中での、ベースラインの位置(上辺から 0.88em) */
export const VERTICAL_BASELINE = 0.88

export const isVertical = (text: Pick<TextObject, 'writingMode'>): boolean => text.writingMode === 'vertical'

type VerticalInput = Pick<TextObject, 'text' | 'fontSize' | 'letterSpacing' | 'align'>

/** 行全体の長さ(1字目の上辺から最後の字の下辺まで) */
export function verticalLength(text: VerticalInput): number {
  const count = [...text.text].length
  return count === 0 ? 0 : count * text.fontSize + (count - 1) * text.letterSpacing
}

/** align による行の始まりの位置(原点から下向きに測った、1字目の上辺)。left = 上端、center = 中央、right = 下端が原点 */
function verticalStart(text: VerticalInput): number {
  const length = verticalLength(text)
  return text.align === 'left' ? 0 : text.align === 'center' ? -length / 2 : -length
}

export interface VerticalChar {
  char: string
  /** 仮想ボディの上辺(原点から下向きに測った距離) */
  top: number
  /** ベースライン(原点から下向きに測った距離) */
  baseline: number
}

/** 1字ずつの位置 */
export function verticalChars(text: VerticalInput): VerticalChar[] {
  const start = verticalStart(text)
  return [...text.text].map((char, i) => {
    const top = start + i * (text.fontSize + text.letterSpacing)
    return { char, top, baseline: top + VERTICAL_BASELINE * text.fontSize }
  })
}

/** ローカル座標での外形 [x0, y0, x1, y1](y上向き) */
export function verticalLocalBox(text: VerticalInput): Rect {
  const start = verticalStart(text)
  // 0 の符号を落とす(-0 を返さない)
  return [-text.fontSize / 2, 0 - (start + verticalLength(text)), text.fontSize / 2, 0 - start]
}

/** 横書きの字形で測った、1字のインクの範囲(em 単位。ベースラインと左端が原点) */
export interface CharInk {
  left: number
  right: number
  ascent: number
  descent: number
}

export interface VerticalFit {
  fontSize: number
  letterSpacing: number
  x: number
  y: number
}

/**
 * 縦書きの文字のインクが box [x0, y0, x1, y1](pt、y上向き)に収まるよう、サイズ・位置・字間を決める。
 * 幅からサイズを決め、高さは字間で合わせる。1字で縦長の字形は高さからサイズを決める。
 */
export function fitVertical(inks: readonly CharInk[], box: Rect): VerticalFit | null {
  if (inks.length === 0) return null
  const widths = inks.map((ink) => ink.left + ink.right)
  const heights = inks.map((ink) => ink.ascent + ink.descent)
  const maxWidth = Math.max(...widths)
  if (!(maxWidth > 0) || heights.some((height) => !(height > 0))) return null
  const boxWidth = box[2] - box[0]
  const boxHeight = box[3] - box[1]
  const first = inks[0]
  const last = inks.at(-1)!
  const byHeight = inks.length === 1 && heights[0] > widths[0]
  const fontSize = byHeight ? boxHeight / heights[0] : boxWidth / maxWidth
  // 1字目のインクの上端と、最後の字のインクの下端が、枠の上下に合うようにする
  const inkTop = (VERTICAL_BASELINE - first.ascent) * fontSize
  const inkBottom = (VERTICAL_BASELINE + last.descent) * fontSize
  const letterSpacing = inks.length > 1 ? (boxHeight - (inkBottom - inkTop)) / (inks.length - 1) - fontSize : 0
  const slack = inks.length === 1 ? (boxHeight - heights[0] * fontSize) / 2 : 0
  return { fontSize, letterSpacing, x: (box[0] + box[2]) / 2, y: box[3] + inkTop - slack }
}
