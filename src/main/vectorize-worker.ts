// utility process で動く。背景ラスター(PNG)を読み、Vectorizer で Path 候補を作る。
import type { VectorizeRequest, WorkerReply } from '../shared/ipc'
import type { PathDraft } from '../shared/vectorizer'
import { loadRaster, pixelToPdfMatrix } from './raster'
import { getVectorizer } from './vectorize'

async function vectorize(req: VectorizeRequest): Promise<PathDraft[]> {
  const vectorizer = getVectorizer(req.vectorizerId)
  const { raster } = await loadRaster(req.pngPath, req)
  return vectorizer.vectorize({
    raster,
    pixelToPdf: pixelToPdfMatrix(req.imageTransform, raster.width, raster.height)
  })
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
