// utility process で動く。PDFの1ページを指定dpiでPNGにする。元PDFは読むだけ。
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { RasterizeRequest, RasterizeResult, WorkerReply } from '../shared/ipc'

const POINTS_PER_INCH = 72

/**
 * pdf.js は読み込み時に「Electron で process.type が 'browser' 以外ならブラウザ環境」と判定し、
 * utility process('utility')では DOM を探して失敗する。Node 用の経路(@napi-rs/canvas、fs 読み込み)
 * を使わせるため、読み込みの間だけ process.type を 'browser' に見せる。
 */
async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  const original = Object.getOwnPropertyDescriptor(process, 'type')
  Object.defineProperty(process, 'type', { value: 'browser', configurable: true })
  try {
    // pdfjs-dist は ESM のみなので動的 import する
    return await import('pdfjs-dist/legacy/build/pdf.mjs')
  } finally {
    if (original) Object.defineProperty(process, 'type', original)
    else delete (process as { type?: string }).type
  }
}

async function rasterize(req: RasterizeRequest): Promise<RasterizeResult> {
  const pdfjs = await loadPdfjs()
  const pdfjsRoot = dirname(createRequire(__filename).resolve('pdfjs-dist/package.json'))

  const data = new Uint8Array(await readFile(req.pdfPath))
  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: join(pdfjsRoot, 'cmaps') + '/',
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/',
    wasmUrl: join(pdfjsRoot, 'wasm') + '/',
    iccUrl: join(pdfjsRoot, 'iccs') + '/'
  })
  const doc = await loadingTask.promise
  try {
    if (req.pageNumber < 1 || req.pageNumber > doc.numPages) {
      throw new Error(`ページ番号 ${req.pageNumber} は範囲外です(全 ${doc.numPages} ページ)`)
    }
    const page = await doc.getPage(req.pageNumber)
    const scale = req.dpi / POINTS_PER_INCH
    const viewport = page.getViewport({ scale })
    // 端数は切り上げて欠けを防ぐ。配置側は pixel 数と dpi から pt を逆算する
    const pixelWidth = Math.ceil(viewport.width - 1e-6)
    const pixelHeight = Math.ceil(viewport.height - 1e-6)

    const canvas = createCanvas(pixelWidth, pixelHeight)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pixelWidth, pixelHeight)
    // pdf.js の型は DOM の canvas 前提なので、@napi-rs/canvas を渡すために型だけ合わせる
    const renderParams = { canvas, canvasContext: ctx, viewport } as unknown as Parameters<typeof page.render>[0]
    await page.render(renderParams).promise
    await writeFile(req.outPngPath, await canvas.encode('png'))

    const [x0, y0, x1, y1] = page.view
    const metadata = await doc.getMetadata()
    const info = metadata.info as { EncryptFilterName?: string | null }
    const permissions = await doc.getPermissions()
    return {
      pageCount: doc.numPages,
      mediaBox: [x0, y0, x1, y1],
      pixelWidth,
      pixelHeight,
      encryptFilter: info.EncryptFilterName ?? null,
      permissions: permissions ? [...permissions].sort((a, b) => a - b) : null
    }
  } finally {
    await loadingTask.destroy()
  }
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
