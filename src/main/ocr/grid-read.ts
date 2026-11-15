// 小さな字の切り抜きを、格子に並べた1枚の画像にして OCR で読む。
// OCR は、1字だけがまばらに並んだ画像をほとんど読まない。横の間隔を単語の間くらいに詰めて
// 行のように並べると読める。読めなかったものだけを並べ直すと、さらに読めることがある。
import { copyFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import type { OcrEngineId, OcrLine } from '../../shared/ocr'
import { recognize } from './engines'

export interface GridItem {
  /** 読ませる画像の中での大きさ(px) */
  width: number
  height: number
  /** (left, top) を左上にして、黒で描く */
  draw(ctx: SKRSContext2D, left: number, top: number): void
}

export interface GridOptions {
  engineId: OcrEngineId
  visionBinary: string
  tesseractLangPath: string
  /** 読めたとみなす条件。満たさないものは、次の回でもう一度読む */
  accept(text: string): boolean
  /** 調査用のファイル名(環境変数 PDFPE_OCR_DEBUG_DIR があるときだけ使う) */
  debugName: string
  /** 読む回数の上限 */
  passes?: number
}

export interface GridText {
  text: string
  confidence: number
}

// 行の間の余白と、隣の字との間隔(px)
const PADDING_PX = 60
const GAP_X_PX = 70

/** items を読んで、同じ順番で結果を返す。読めなかったものは text が空になる */
export async function readGrid(items: readonly GridItem[], options: GridOptions): Promise<GridText[]> {
  const result: GridText[] = items.map(() => ({ text: '', confidence: 1 }))
  for (let pass = 0; pass < (options.passes ?? 3); pass++) {
    const pending = items.map((_, i) => i).filter((i) => !options.accept(result[i].text))
    if (pending.length === 0) break
    const cellWidth = Math.max(...pending.map((i) => items[i].width)) + GAP_X_PX
    const cellHeight = Math.max(...pending.map((i) => items[i].height)) + PADDING_PX
    // 正方形に近い形にする(細長い画像は、OCR が縮小して何も読めなくなる)
    const columns = Math.max(1, Math.ceil(Math.sqrt((pending.length * cellHeight) / cellWidth)))
    const rows = Math.ceil(pending.length / columns)
    const mosaic = createCanvas(Math.ceil(PADDING_PX * 2 + columns * cellWidth), Math.ceil(PADDING_PX * 2 + rows * cellHeight))
    const ctx = mosaic.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, mosaic.width, mosaic.height)
    ctx.fillStyle = '#000000'
    pending.forEach((itemIndex, slot) => {
      items[itemIndex].draw(ctx, PADDING_PX + (slot % columns) * cellWidth, PADDING_PX + Math.floor(slot / columns) * cellHeight)
    })

    const pngPath = join(tmpdir(), `pdfpe-${options.debugName}-${process.pid}-${Date.now()}-${pass}.png`)
    let lines: OcrLine[]
    try {
      await writeFile(pngPath, await mosaic.encode('png'))
      lines = await recognize(options.engineId, {
        pngPath,
        canvas: mosaic,
        rules: [],
        visionBinary: options.visionBinary,
        tesseractLangPath: options.tesseractLangPath
      })
      const debugDir = process.env.PDFPE_OCR_DEBUG_DIR
      if (debugDir) {
        await copyFile(pngPath, join(debugDir, `${options.debugName}-${pass}.png`)).catch(() => {})
        await writeFile(join(debugDir, `${options.debugName}-${pass}.json`), JSON.stringify({ count: pending.length, columns, lines }, null, 2)).catch(() => {})
      }
    } finally {
      await rm(pngPath, { force: true })
    }

    // 読めた文字を、位置から元の切り抜きに戻す(隣の字と1行として読まれるので、1字ずつ振り分ける)
    const slotAt = (x: number, y: number): number => {
      const column = Math.floor((x - PADDING_PX + GAP_X_PX / 2) / cellWidth)
      const row = Math.floor((y - PADDING_PX / 2) / cellHeight)
      return column >= 0 && column < columns && row >= 0 ? row * columns + column : -1
    }
    const texts: GridText[] = pending.map(() => ({ text: '', confidence: 1 }))
    for (const line of [...lines].sort((p, q) => p.box.x - q.box.x)) {
      const chars = [...line.text]
      chars.forEach((char, i) => {
        const box = line.chars.length === chars.length ? line.chars[i] : null
        if (line.chars.length === chars.length && !box) return
        const target = box ?? line.box
        const slot = slotAt(target.x + target.width / 2, target.y + target.height / 2)
        if (slot < 0 || slot >= texts.length) return
        texts[slot].text += char
        texts[slot].confidence = Math.min(texts[slot].confidence, line.confidence)
      })
    }
    pending.forEach((itemIndex, slot) => {
      if (options.accept(texts[slot].text)) result[itemIndex] = texts[slot]
    })
  }
  return result.map((entry) => (options.accept(entry.text) ? entry : { text: '', confidence: 0 }))
}
