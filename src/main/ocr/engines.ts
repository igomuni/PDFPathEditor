// OCR エンジンの実装。どちらも画素座標の行(OcrLine)を返す。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Canvas } from '@napi-rs/canvas'
import type { OcrEngineId, OcrLine, PixelBox } from '../../shared/ocr'
import type { DetectedLine } from '../vectorize/line-detector'

export interface OcrContext {
  pngPath: string
  /** 背景ラスターを描いたキャンバス。エンジンが前処理で描き換えてよい */
  canvas: Canvas
  /** 検出済みの罫線(画素座標) */
  rules: DetectedLine[]
  visionBinary: string
  tesseractLangPath: string
}

interface VisionLine {
  text: string
  confidence: number
  box: PixelBox
  chars: (PixelBox | null)[]
}

/** macOS Vision。native/vision-ocr のヘルパーを呼ぶ。罫線があっても読めるので元画像のまま渡す */
async function recognizeWithVision(context: OcrContext): Promise<OcrLine[]> {
  const { stdout } = await promisify(execFile)(context.visionBinary, [context.pngPath, 'ja-JP,en-US'], {
    maxBuffer: 256 * 1024 * 1024
  })
  return (JSON.parse(stdout) as VisionLine[]).map((line) => ({
    text: line.text,
    confidence: line.confidence,
    box: line.box,
    chars: line.chars
  }))
}

/** tesseract.js(WASM)。罫線を文字として読んでしまうので、検出済みの罫線を白で消してから渡す */
async function recognizeWithTesseract(context: OcrContext): Promise<OcrLine[]> {
  const ctx = context.canvas.getContext('2d')
  ctx.strokeStyle = '#ffffff'
  ctx.lineCap = 'butt'
  ctx.setLineDash([])
  for (const rule of context.rules) {
    ctx.lineWidth = rule.thickness + 3
    ctx.beginPath()
    if (rule.orientation === 'h') {
      ctx.moveTo(rule.start - 1, rule.center)
      ctx.lineTo(rule.end + 1, rule.center)
    } else {
      ctx.moveTo(rule.center, rule.start - 1)
      ctx.lineTo(rule.center, rule.end + 1)
    }
    ctx.stroke()
  }
  const png = await context.canvas.encode('png')

  const { createWorker, PSM } = await import('tesseract.js')
  // 言語データは同梱のものを使い、実行時にダウンロードもキャッシュ書き込みもしない
  const worker = await createWorker('jpn', 1, {
    langPath: context.tesseractLangPath,
    cacheMethod: 'none',
    gzip: true
  })
  try {
    await worker.setParameters({
      // 帳票は文字が散らばっているので「まばらな文字」として読む
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    })
    const { data } = await worker.recognize(png, {}, { blocks: true })
    const lines: OcrLine[] = []
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          let text = ''
          const chars: (PixelBox | null)[] = []
          line.words.forEach((word, wordIndex) => {
            if (wordIndex > 0) {
              text += ' '
              chars.push(null)
            }
            for (const symbol of word.symbols) {
              const { x0, y0, x1, y1 } = symbol.bbox
              for (const char of symbol.text) {
                text += char
                chars.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
              }
            }
          })
          const { x0, y0, x1, y1 } = line.bbox
          lines.push({
            text,
            confidence: line.confidence / 100,
            box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
            chars
          })
        }
      }
    }
    return lines
  } finally {
    await worker.terminate()
  }
}

export function recognize(engineId: OcrEngineId, context: OcrContext): Promise<OcrLine[]> {
  switch (engineId) {
    case 'vision':
      return recognizeWithVision(context)
    case 'tesseract':
      return recognizeWithTesseract(context)
  }
}
