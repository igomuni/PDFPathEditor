// Text の結合と分離(design.md §3-51)。文字の位置を変えずに、Text の区切りだけを変える。
import type { Matrix, Rect, TextObject } from '../../shared/model.ts'
import { isVertical, verticalLength } from '../../shared/vertical.ts'

/** 組んだときの送り幅の合計(base のフォント・サイズ・字間で測る。末尾の字間は含めない) */
export type AdvanceOf = (text: string, base: TextObject) => number

const round = (value: number): number => {
  const rounded = Math.round(value * 1000) / 1000
  return rounded === 0 ? 0 : rounded
}

/** ローカル座標の点 (x, y) を原点にした変換行列 */
function originAt(object: TextObject, x: number, y: number): Matrix {
  const [a, b, c, d, e, f] = object.transform
  return [a, b, c, d, round(a * x + c * y + e), round(b * x + d * y + f)]
}

/** 1字ずつに分けるときの切れ目(文字列の中の位置。UTF-16 の単位) */
export function charCuts(text: string): number[] {
  const cuts: number[] = []
  let index = 0
  for (const char of text) {
    index += char.length
    cuts.push(index)
  }
  cuts.pop()
  return cuts
}

/**
 * Text を cuts(文字列の中の位置)で分ける。分けた後も、それぞれの字の位置は変わらない。
 * 1つ目は元のIDを引き継ぎ、残りは新しいIDになる。空白だけの部分は捨てる。分けられなければ空の配列。
 */
export function splitText(
  object: TextObject,
  cuts: readonly number[],
  advanceOf: AdvanceOf,
  newId: () => string = () => `obj-${crypto.randomUUID()}`
): TextObject[] {
  const length = object.text.length
  const bounds = [0, ...[...new Set(cuts)].filter((cut) => cut > 0 && cut < length).sort((p, q) => p - q), length]
  const vertical = isVertical(object)
  const pitch = object.fontSize + object.letterSpacing
  const total = vertical ? verticalLength(object) : advanceOf(object.text, object)
  // 行の始まり(横書きは左端、縦書きは上端)。原点からの距離
  const start = object.align === 'left' ? 0 : object.align === 'center' ? -total / 2 : -total
  const pieces: { text: string; offset: number }[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const raw = object.text.slice(bounds[i], bounds[i + 1])
    const text = raw.trim()
    if (text === '') continue
    // 先頭の空白は、位置に繰り入れる
    const prefix = object.text.slice(0, bounds[i]) + raw.slice(0, raw.length - raw.trimStart().length)
    const offset = prefix === '' ? 0 : vertical ? [...prefix].length * pitch : advanceOf(prefix, object) + object.letterSpacing
    pieces.push({ text, offset })
  }
  if (pieces.length < 2) return []
  return pieces.map((piece, i) => ({
    ...object,
    id: i === 0 ? object.id : newId(),
    text: piece.text,
    align: 'left' as const,
    transform: vertical ? originAt(object, 0, -(start + piece.offset)) : originAt(object, start + piece.offset, 0)
  }))
}

interface Item {
  object: TextObject
  box: Rect
}

/** 読む順に並べる。横書きは上の行から・左から、縦書きは右の列から・上から。行(列)の数も返す */
function readingOrder(items: Item[], vertical: boolean): { items: Item[]; lines: number } {
  const center = (box: Rect): number => (vertical ? (box[0] + box[2]) / 2 : (box[1] + box[3]) / 2)
  const thickness = (box: Rect): number => (vertical ? box[2] - box[0] : box[3] - box[1])
  const sorted = [...items].sort((p, q) => center(q.box) - center(p.box))
  const lines: Item[][] = []
  for (const item of sorted) {
    const line = lines.at(-1)
    if (line && center(line[0].box) - center(item.box) <= 0.5 * thickness(line[0].box)) line.push(item)
    else lines.push([item])
  }
  for (const line of lines) line.sort((p, q) => (vertical ? q.box[3] - p.box[3] : p.box[0] - q.box[0]))
  return { items: lines.flat(), lines: lines.length }
}

/**
 * 複数の Text を、読む順に並べて1つにする。フォントや役割は先頭のものを引き継ぐ。
 * 1行(縦書きは1列)に並んでいれば、全体の幅(高さ)が変わらないよう字間を決める。
 * boundsOf はページ上の外形、advanceOf は送り幅。2つ未満なら null。
 */
export function mergeTexts(objects: readonly TextObject[], boundsOf: (object: TextObject) => Rect, advanceOf: AdvanceOf): TextObject | null {
  if (objects.length < 2) return null
  const vertical = objects.every(isVertical)
  const ordered = readingOrder(
    objects.map((object) => ({ object, box: boundsOf(object) })),
    vertical
  )
  const first = ordered.items[0]
  const base = first.object
  const text = ordered.items.map((item) => item.object.text).join('')
  const count = [...text].length
  const union = ordered.items.reduce<Rect>(
    (box, item) => [Math.min(box[0], item.box[0]), Math.min(box[1], item.box[1]), Math.max(box[2], item.box[2]), Math.max(box[3], item.box[3])],
    first.box
  )
  const single = ordered.lines === 1 && count > 1
  const [a, b, c, d, , f] = base.transform
  if (vertical) {
    return {
      ...base,
      text,
      align: 'left',
      letterSpacing: single ? round((union[3] - union[1] - count * base.fontSize) / (count - 1)) : base.letterSpacing,
      transform: [a, b, c, d, round((first.box[0] + first.box[2]) / 2), round(single ? union[3] : first.box[3])]
    }
  }
  return {
    ...base,
    text,
    align: 'left',
    letterSpacing: single ? round((union[2] - union[0] - advanceOf(text, { ...base, letterSpacing: 0 })) / (count - 1)) : base.letterSpacing,
    transform: [a, b, c, d, round(single ? union[0] : first.box[0]), f]
  }
}
