// utility process 用: pdf.js + @napi-rs/canvas でPDFの1ページを指定dpiのラスターにする。PDFは読むだけ。
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas, type Canvas } from '@napi-rs/canvas'
import type { Rect } from '../shared/model'

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

export interface RenderedPage {
  canvas: Canvas
  pixelWidth: number
  pixelHeight: number
  pageCount: number
  mediaBox: Rect
  encryptFilter: string | null
  permissions: number[] | null
}

/** PDFの1ページを白地の上に描く。data は pdf.js に渡すと使えなくなるので、呼び出し側で使い回さないこと */
export async function renderPdfPage(data: Uint8Array, pageNumber: number, dpi: number): Promise<RenderedPage> {
  const pdfjs = await loadPdfjs()
  const pdfjsRoot = dirname(createRequire(__filename).resolve('pdfjs-dist/package.json'))
  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: join(pdfjsRoot, 'cmaps') + '/',
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/',
    wasmUrl: join(pdfjsRoot, 'wasm') + '/',
    iccUrl: join(pdfjsRoot, 'iccs') + '/'
  })
  const doc = await loadingTask.promise
  try {
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      throw new Error(`ページ番号 ${pageNumber} は範囲外です(全 ${doc.numPages} ページ)`)
    }
    const page = await doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale: dpi / POINTS_PER_INCH })
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

    // ページが回転している(/Rotate 90・270)ときは、表示される向きの大きさをページの大きさにする。
    // モデルの座標は「表示される向きのページ」の左下が原点(design.md §3-57)
    const [vx0, vy0, vx1, vy1] = page.view
    const turned = page.rotate % 180 !== 0
    const [x0, y0, x1, y1] = turned ? [vx0, vy0, vx0 + (vy1 - vy0), vy0 + (vx1 - vx0)] : [vx0, vy0, vx1, vy1]
    const metadata = await doc.getMetadata()
    const info = metadata.info as { EncryptFilterName?: string | null }
    const permissions = await doc.getPermissions()
    return {
      canvas,
      pixelWidth,
      pixelHeight,
      pageCount: doc.numPages,
      mediaBox: [x0, y0, x1, y1],
      encryptFilter: info.EncryptFilterName ?? null,
      permissions: permissions ? [...permissions].sort((a, b) => a - b) : null
    }
  } finally {
    await loadingTask.destroy()
  }
}
