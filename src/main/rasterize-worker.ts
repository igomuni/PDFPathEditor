// utility process で動く。PDFの1ページを指定dpiでPNGにする。元PDFは読むだけ。
import { readFile, writeFile } from 'node:fs/promises'
import type { RasterizeRequest, RasterizeResult, WorkerReply } from '../shared/ipc'
import { renderPdfPage } from './pdf-raster'

async function rasterize(req: RasterizeRequest): Promise<RasterizeResult> {
  const { canvas, ...result } = await renderPdfPage(new Uint8Array(await readFile(req.pdfPath)), req.pageNumber, req.dpi)
  await writeFile(req.outPngPath, await canvas.encode('png'))
  return result
}

process.parentPort.on('message', (event) => {
  rasterize(event.data as RasterizeRequest)
    .then((result): WorkerReply<RasterizeResult> => ({ ok: true, result }))
    .catch((err): WorkerReply<RasterizeResult> => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }))
    .then((reply) => process.parentPort.postMessage(reply))
})
