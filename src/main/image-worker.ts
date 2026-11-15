// utility process で動く。背景ラスターの一部を切り出して、Image 用の PNG を書く(QRコードの検出、範囲の指定)。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { ImageCutDraft, ImageCutRequest, WorkerReply } from '../shared/ipc'
import { findQrCodes, type PixelRect } from './qr/finder'
import { loadRaster } from './raster'

const round = (value: number): number => Math.round(value * 1000) / 1000

async function cut(req: ImageCutRequest): Promise<ImageCutDraft[]> {
  const { canvas, raster } = await loadRaster(req.pngPath, req)
  const { width, height } = raster
  const [a, , , d, e, f] = req.imageTransform
  let rects: PixelRect[]
  if (req.kind === 'qr') {
    rects = findQrCodes(raster)
  } else {
    if (!req.rect) throw new Error('切り出す範囲がありません')
    // PDF座標(pt)→ 画素。ページの外にはみ出した分は切る
    const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, Math.round(value)))
    const rect = {
      x0: clamp(((req.rect[0] - e) / a) * width, width),
      y0: clamp((1 - (req.rect[3] - f) / d) * height, height),
      x1: clamp(((req.rect[2] - e) / a) * width, width),
      y1: clamp((1 - (req.rect[1] - f) / d) * height, height)
    }
    if (rect.x1 - rect.x0 < 2 || rect.y1 - rect.y0 < 2) throw new Error('切り出す範囲が小さすぎます(ページの中をドラッグしてください)')
    rects = [rect]
  }
  const drafts: ImageCutDraft[] = []
  for (const [index, rect] of rects.entries()) {
    const w = rect.x1 - rect.x0
    const h = rect.y1 - rect.y0
    const out = createCanvas(w, h)
    out.getContext('2d').drawImage(canvas, rect.x0, rect.y0, w, h, 0, 0, w, h)
    const file = `${req.filePrefix}-${index + 1}.png`
    await writeFile(join(req.outDir, file), await out.encode('png'))
    drafts.push({
      file,
      pixelWidth: w,
      pixelHeight: h,
      // 単位正方形 → ページ上の位置(画素の境界に合わせる)
      transform: [round((w / width) * a), 0, 0, round((h / height) * d), round(e + (rect.x0 / width) * a), round(f + d - (rect.y1 / height) * d)]
    })
  }
  return drafts
}

process.parentPort.on('message', (event) => {
  cut(event.data as ImageCutRequest)
    .then((result): WorkerReply<ImageCutDraft[]> => ({ ok: true, result }))
    .catch((err): WorkerReply<ImageCutDraft[]> => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }))
    .then((reply) => process.parentPort.postMessage(reply))
})
