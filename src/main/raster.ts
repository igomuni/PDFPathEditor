// utility process 用: PNG を読み、検出処理に使う濃淡ラスターにする
import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas'
import type { Matrix } from '../shared/model'
import type { GrayRaster } from '../shared/vectorizer'

export interface LoadedRaster {
  canvas: Canvas
  raster: GrayRaster
}

export async function loadRaster(pngPath: string, expected: { pixelWidth: number; pixelHeight: number }): Promise<LoadedRaster> {
  const image = await loadImage(pngPath)
  const { width, height } = image
  if (width !== expected.pixelWidth || height !== expected.pixelHeight) {
    throw new Error(
      `ラスターの大きさが document.json と一致しません(${width}×${height} / ${expected.pixelWidth}×${expected.pixelHeight})`
    )
  }
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
  return { canvas, raster: { width, height, data } }
}

/**
 * 画素座標(左上原点、y下向き)→ PDF座標 の行列。
 * 画像は単位正方形(y上向き)に置かれる: u = x / W, v = 1 - y / H
 */
export function pixelToPdfMatrix(imageTransform: Matrix, width: number, height: number): Matrix {
  const [a, b, c, d, e, f] = imageTransform
  return [a / width, b / width, -c / height, -d / height, c + e, d + f]
}
