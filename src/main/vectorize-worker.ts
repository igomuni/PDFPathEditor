// utility process で動く。背景ラスター(PNG)を読み、Vectorizer で Path 候補を作る。
import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { VectorizeRequest, WorkerReply } from '../shared/ipc'
import type { Matrix } from '../shared/model'
import type { GrayRaster, PathDraft } from '../shared/vectorizer'
import { getVectorizer } from './vectorize'

async function loadGrayRaster(pngPath: string): Promise<GrayRaster> {
  const image = await loadImage(pngPath)
  const { width, height } = image
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0)
  const rgba = ctx.getImageData(0, 0, width, height).data
  const data = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    // ITU-R BT.601 の輝度
    data[i] = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2])
  }
  return { width, height, data }
}

async function vectorize(req: VectorizeRequest): Promise<PathDraft[]> {
  const vectorizer = getVectorizer(req.vectorizerId)
  const raster = await loadGrayRaster(req.pngPath)
  if (raster.width !== req.pixelWidth || raster.height !== req.pixelHeight) {
    throw new Error(
      `ラスターの大きさが document.json と一致しません(${raster.width}×${raster.height} / ${req.pixelWidth}×${req.pixelHeight})`
    )
  }
  // 画像は単位正方形(y上向き)に置かれる: u = x / W, v = 1 - y / H
  const [a, b, c, d, e, f] = req.imageTransform
  const { width: w, height: h } = raster
  const pixelToPdf: Matrix = [a / w, b / w, -c / h, -d / h, c + e, d + f]
  return vectorizer.vectorize({ raster, pixelToPdf })
}

process.parentPort.on('message', (event) => {
  vectorize(event.data as VectorizeRequest)
    .then((result): WorkerReply<PathDraft[]> => ({ ok: true, result }))
    .catch((err): WorkerReply<PathDraft[]> => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }))
    .then((reply) => process.parentPort.postMessage(reply))
})
