// utility process で動く。背景ラスターを OCR にかけ、フォントに合わせて配置した Text 候補を作る。
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import type { OcrRequest, WorkerReply } from '../shared/ipc'
import type { TextDraft } from '../shared/ocr'
import { recognize } from './ocr/engines'
import { cleanText, fitText, splitAtRules, tightInkBox, type InkMetrics } from './ocr/postprocess'
import { mergeVerticalRuns } from './ocr/vertical'
import { loadRaster, pixelToPdfMatrix } from './raster'
import { detectLines } from './vectorize/line-detector'

// これ未満の確信度の行は、QRコードなどを読んだゴミとみなして捨てる
const MIN_CONFIDENCE = 0.3
// 文字のインクとみなす濃度値。文字の縁はぼけているので、罫線検出より緩くする
const INK_THRESHOLD = 160
const MIN_FONT_SIZE_PX = 6
const FIT_FONT_ALIAS = 'pdfpe-ocr-fit'
const MEASURE_SIZE = 200

const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits

async function detectText(req: OcrRequest): Promise<TextDraft[]> {
  const { canvas, raster } = await loadRaster(req.pngPath, req)
  const rules = detectLines(raster)

  if (!GlobalFonts.registerFromPath(req.fontFile, FIT_FONT_ALIAS)) {
    throw new Error(`フォントを読めません: ${req.fontFile}`)
  }
  const measureCtx = createCanvas(16, 16).getContext('2d')
  measureCtx.font = `${MEASURE_SIZE}px "${FIT_FONT_ALIAS}"`
  const measure = (text: string): InkMetrics => {
    const m = measureCtx.measureText(text)
    return {
      left: m.actualBoundingBoxLeft / MEASURE_SIZE,
      right: m.actualBoundingBoxRight / MEASURE_SIZE,
      ascent: m.actualBoundingBoxAscent / MEASURE_SIZE,
      descent: m.actualBoundingBoxDescent / MEASURE_SIZE
    }
  }

  const recognized = await recognize(req.engineId, {
    pngPath: req.pngPath,
    canvas,
    rules,
    visionBinary: req.visionBinary,
    tesseractLangPath: req.tesseractLangPath
  })

  const m = pixelToPdfMatrix(req.imageTransform, raster.width, raster.height)
  const ptPerPx = Math.hypot(m[0], m[1])
  const drafts: TextDraft[] = []
  for (const line of splitAtRules(recognized, rules)) {
    const text = cleanText(line.text)
    if (text === '' || line.confidence < MIN_CONFIDENCE) continue
    // OCR の枠は粗いので、枠内のインクの範囲に合わせ直す
    const ink = tightInkBox(raster, line.box, rules, INK_THRESHOLD)
    const fit = ink && fitText(ink, [...text].length, measure(text))
    if (!fit || fit.fontSize < MIN_FONT_SIZE_PX) continue
    drafts.push({
      type: 'text',
      role: 'label',
      fieldCode: null,
      transform: [
        1,
        0,
        0,
        1,
        round(m[0] * fit.originX + m[2] * fit.baselineY + m[4], 3),
        round(m[1] * fit.originX + m[3] * fit.baselineY + m[5], 3)
      ],
      tags: [],
      meta: { ocr: req.engineId, confidence: round(line.confidence, 2) },
      text,
      fontFamily: req.fontFamily,
      fontWeight: req.fontWeight,
      fontSize: round(fit.fontSize * ptPerPx, 2),
      letterSpacing: round(fit.letterSpacing * ptPerPx, 2),
      fill: '#000000',
      align: 'left',
      outline: false
    })
  }
  // 縦に並ぶ1字の Text を縦書きの Text にまとめる。横の罫線(画素)を PDF座標に直して、またぐものは別の枠とみなす
  const horizontals = rules
    .filter((rule) => rule.orientation === 'h' && rule.dash === null)
    .map((rule) => ({ y: m[3] * rule.center + m[5], x0: m[0] * rule.start + m[4], x1: m[0] * rule.end + m[4] }))
  return mergeVerticalRuns(drafts, (x, yBottom, yTop) =>
    horizontals.some((rule) => rule.y > yBottom && rule.y < yTop && rule.x0 <= x && x <= rule.x1)
  )
}

process.parentPort.on('message', (event) => {
  detectText(event.data as OcrRequest)
    .then((result): WorkerReply<TextDraft[]> => ({ ok: true, result }))
    .catch((err): WorkerReply<TextDraft[]> => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }))
    .then((reply) => process.parentPort.postMessage(reply))
})
