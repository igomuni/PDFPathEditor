// テキストの外形(選択枠や範囲選択用)。画面と同じフォントで実測する。
import type { Rect, TextObject } from '../../shared/model'

let context: OffscreenCanvasRenderingContext2D | null = null

/** CSS の font-family 値。フォント未取得のときは総称フォントで代用する */
export function cssFontFamily(family: string): string {
  return `"${family}", ${/serif/i.test(family) && !/sans/i.test(family) ? 'serif' : 'sans-serif'}`
}

/** 組んだときの送り幅の合計(pt)。末尾の字間は含めない */
export function textWidth(object: Pick<TextObject, 'text' | 'fontFamily' | 'fontWeight' | 'fontSize' | 'letterSpacing'>): number {
  context ??= new OffscreenCanvas(1, 1).getContext('2d')
  if (!context) return object.text.length * object.fontSize
  // 小さいサイズは丸められるので、大きく測って縮める
  const scale = 100 / object.fontSize
  context.font = `${object.fontWeight} 100px ${cssFontFamily(object.fontFamily)}`
  const count = [...object.text].length
  return context.measureText(object.text).width / scale + Math.max(0, count - 1) * object.letterSpacing
}

/** ローカル座標(原点=ベースライン上の基準点、y上向き)での外形 [x0, y0, x1, y1] */
export function textLocalBox(object: TextObject): Rect {
  const width = textWidth(object)
  const x0 = object.align === 'left' ? 0 : object.align === 'center' ? -width / 2 : -width
  // 和文フォントの標準的な字面(ベースラインの上 0.88em、下 0.12em)
  return [x0, -0.12 * object.fontSize, x0 + width, 0.88 * object.fontSize]
}
