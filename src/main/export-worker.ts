// utility process で動く。確定オブジェクトを PDF / SVG / JSON に出力し、出力PDFを背景ラスターと比べる。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { DiffMetrics, ExportPageResult, ExportResult } from '../shared/export'
import type { ExportRequest, WorkerReply } from '../shared/ipc'
import { createLayout, FontBook } from './export/fonts'
import { buildExportJson } from './export/json'
import { exportedObjects } from './export/layout'
import { writePdf } from './export/pdf'
import { pageToSvg } from './export/svg'
import { compareRasters, DEFAULT_COMPARE_OPTIONS, DIFF_EXTRA, DIFF_MATCH, DIFF_MISSING, type RasterComparison } from './export/verify'
import { renderPdfPage } from './pdf-raster'
import { assetPath, pageLabel } from './safe-paths'
import { canvasToGray, loadRaster } from './raster'

const POINTS_PER_INCH = 72
const PDF_FILE = 'output.pdf'
const JSON_FILE = 'output.json'
const REPORT_FILE = 'verify.json'

/** 差分画像。画面の差分表示と同じ色: 一致=黒 / 背景のみ(欠落)=赤 / 出力のみ(過剰)=シアン */
async function diffPng(comparison: RasterComparison): Promise<Buffer> {
  const { width, height, classes } = comparison
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(width, height)
  const colors: Record<number, [number, number, number]> = {
    [DIFF_MATCH]: [0, 0, 0],
    [DIFF_MISSING]: [255, 0, 0],
    [DIFF_EXTRA]: [0, 255, 255]
  }
  for (let i = 0, p = 0; i < classes.length; i++, p += 4) {
    const [r, g, b] = colors[classes[i]] ?? [255, 255, 255]
    image.data[p] = r
    image.data[p + 1] = g
    image.data[p + 2] = b
    image.data[p + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  return canvas.encode('png')
}

async function exportDocument(req: ExportRequest): Promise<ExportResult> {
  const { document, projectDir } = req
  const counts = document.pages.map((page) => exportedObjects(page).length)
  if (counts.every((count) => count === 0)) {
    throw new Error('確定レイヤーにオブジェクトがありません。候補を確定してから出力してください')
  }
  // 何かを書き出す前に、ファイル名に使う値を確かめる
  document.pages.forEach(pageLabel)
  const dir = req.outDir
  await mkdir(dir, { recursive: true })
  const book = new FontBook(req.fontDirs)
  const layout = createLayout(book)
  const files: string[] = []

  await writePdf(document, book, layout, join(dir, PDF_FILE))
  files.push(PDF_FILE)
  for (const page of document.pages) {
    const name = `${pageLabel(page)}.svg`
    await writeFile(join(dir, name), pageToSvg(page, layout), 'utf8')
    files.push(name)
  }
  await writeFile(join(dir, JSON_FILE), JSON.stringify(buildExportJson(document, layout), null, 2) + '\n', 'utf8')
  files.push(JSON_FILE)

  // 自動検証: 出力PDFを背景と同じ解像度でラスタライズして比べる
  const pages: ExportPageResult[] = []
  for (const [index, page] of document.pages.entries()) {
    const result: ExportPageResult = { pageNumber: page.sourcePageNumber, objectCount: counts[index], metrics: null }
    pages.push(result)
    const image = page.layers
      .filter((layer) => layer.kind === 'background')
      .flatMap((layer) => layer.objects)
      .find((object) => object.type === 'image')
    if (!image) continue
    const dpi = (image.pixelWidth / Math.abs(image.transform[0])) * POINTS_PER_INCH
    const background = await loadRaster(assetPath(projectDir, image.asset), image)
    const rendered = await renderPdfPage(new Uint8Array(await readFile(join(dir, PDF_FILE))), index + 1, dpi)
    const comparison = compareRasters(background.raster, canvasToGray(rendered.canvas))
    const metrics: DiffMetrics = {
      dpi: Math.round(dpi * 100) / 100,
      tolerancePx: DEFAULT_COMPARE_OPTIONS.tolerancePx,
      backgroundInk: comparison.backgroundInk,
      outputInk: comparison.outputInk,
      recall: comparison.recall,
      excess: comparison.excess,
      mismatch: comparison.mismatch
    }
    result.metrics = metrics
    const name = `verify-${pageLabel(page)}-diff.png`
    await writeFile(join(dir, name), await diffPng(comparison))
    files.push(name)
  }
  const report = { createdAt: new Date().toISOString(), output: PDF_FILE, inkThreshold: DEFAULT_COMPARE_OPTIONS.threshold, pages }
  await writeFile(join(dir, REPORT_FILE), JSON.stringify(report, null, 2) + '\n', 'utf8')
  files.push(REPORT_FILE)
  return { dir, files, pages }
}

process.parentPort.on('message', (event) => {
  exportDocument(event.data as ExportRequest)
    .then((result): WorkerReply<ExportResult> => ({ ok: true, result }))
    .catch((err): WorkerReply<ExportResult> => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }))
    .then((reply) => process.parentPort.postMessage(reply))
})
