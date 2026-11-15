// utility process で動く。背景ラスター(PNG)を読み、Vectorizer で Path 候補を作る。矢印もここで見つける。
import type { VectorizeRequest, WorkerReply } from '../shared/ipc'
import type { PathDraft } from '../shared/vectorizer'
import { loadRaster, pixelToPdfMatrix } from './raster'
import { getVectorizer } from './vectorize'
import { arrowsToDrafts, dropLinesOnArrows } from './vectorize/arrow-paths'
import { findArrows } from './vectorize/arrows'

async function vectorize(req: VectorizeRequest): Promise<PathDraft[]> {
  const vectorizer = getVectorizer(req.vectorizerId)
  const { raster } = await loadRaster(req.pngPath, req)
  const pixelToPdf = pixelToPdfMatrix(req.imageTransform, raster.width, raster.height)
  const lines = vectorizer.vectorize({ raster, pixelToPdf })
  // 矢印(吹き出しの細い線 + 先端の三角形)。軸と重なる罫線の候補は外す
  const arrows = arrowsToDrafts(findArrows(raster), pixelToPdf)
  return [...dropLinesOnArrows(lines, arrows), ...arrows]
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
