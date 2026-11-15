// 出力用のフォントの読み込みと、Text の組版(fontkit)。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as fontkit from 'fontkit'
import { BUNDLED_FONTS } from '../../shared/fonts'
import type { TextObject } from '../../shared/model'
import { isVertical, verticalChars, verticalLocalBox } from '../../shared/vertical'
import type { LayoutText, TextLayout } from './layout'

/** family と weight からフォントファイルを探して開く。プロジェクトの fonts/ を先に見る */
export class FontBook {
  private fonts = new Map<string, { file: string; font: fontkit.Font }>()

  constructor(private readonly dirs: readonly string[]) {}

  private entry(family: string, weight: number): { file: string; font: fontkit.Font } {
    const key = `${family}:${weight}`
    let entry = this.fonts.get(key)
    if (!entry) {
      const known = BUNDLED_FONTS.find((font) => font.family === family && font.weight === weight)
      const file = known && this.dirs.map((dir) => join(dir, known.file)).find((path) => existsSync(path))
      if (!file) {
        throw new Error(
          `フォント「${family}」(太さ ${weight})のファイルがありません。\`pnpm fonts\` で取得するか、別のフォントに変えてください`
        )
      }
      const opened = fontkit.openSync(file)
      if (!('layout' in opened)) throw new Error(`フォントコレクションは未対応です: ${file}`)
      this.fonts.set(key, (entry = { file, font: opened }))
    }
    return entry
  }

  file(family: string, weight: number): string {
    return this.entry(family, weight).file
  }

  font(family: string, weight: number): fontkit.Font {
    return this.entry(family, weight).font
  }
}

/** Text を1行に組む。字間は各グリフの送りに足す(画面の letter-spacing と同じ) */
export function createLayout(book: FontBook): LayoutText {
  const cache = new WeakMap<TextObject, TextLayout>()
  return (object) => {
    const cached = cache.get(object)
    if (cached) return cached
    const font = book.font(object.fontFamily, object.fontWeight)
    const scale = object.fontSize / font.unitsPerEm
    if (isVertical(object)) {
      // 縦書き: 1字ずつ、縦書き用の字形(vert)にして左右の中央に置く
      const box = verticalLocalBox(object)
      const vertical: TextLayout = {
        x0: box[0],
        width: box[2] - box[0],
        scale,
        box,
        glyphs: verticalChars(object).flatMap((item) => {
          const run = font.layout(item.char, ['vert'])
          const advance = run.positions.reduce((sum, position) => sum + position.xAdvance, 0) * scale
          let pen = -advance / 2
          return run.glyphs.map((glyph, i) => {
            const position = run.positions[i]
            const placed = { d: glyph.path.toSVG(), x: pen + position.xOffset * scale, y: -item.baseline + position.yOffset * scale }
            pen += position.xAdvance * scale
            return placed
          })
        })
      }
      cache.set(object, vertical)
      return vertical
    }
    const run = font.layout(object.text)
    let pen = 0
    const glyphs = run.glyphs.map((glyph, i) => {
      const position = run.positions[i]
      const placed = { d: glyph.path.toSVG(), x: pen + position.xOffset * scale, y: position.yOffset * scale }
      pen += position.xAdvance * scale + object.letterSpacing
      return placed
    })
    const width = glyphs.length === 0 ? 0 : pen - object.letterSpacing
    const x0 = object.align === 'left' ? 0 : object.align === 'center' ? -width / 2 : -width
    const layout: TextLayout = { x0, width, scale, glyphs: glyphs.map((glyph) => ({ ...glyph, x: glyph.x + x0 })) }
    cache.set(object, layout)
    return layout
  }
}
