// utility process で動く。AI などに候補を確認してもらうためのデータを exports/review/ に書き出す。
// 候補の一覧(review.json)と、背景に候補を重ねたタイル画像を作る。あわせて、取れていないインクと
// 背景に合っていない Text を機械的に洗い出して印を付ける。
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanvas, GlobalFonts, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import type { ReviewExportResult } from '../shared/corrections'
import { BUNDLED_FONTS } from '../shared/fonts'
import type { ExportRequest, WorkerReply } from '../shared/ipc'
import type { DocObject, Rect, TextObject } from '../shared/model'
import { isVertical, verticalChars, verticalLocalBox } from '../shared/vertical'
import { canvasToGray, loadRaster } from './raster'
import { dilateMask, groupInk } from './review/uncovered'
import { assetPath, pageLabel } from './safe-paths'

// 文字の縁はぼけているので、罫線検出より緩い濃度でインクとみなす
const INK_THRESHOLD = 160
// 候補の文字の周りこの画素数までは「対応する候補がある」とみなす
const COVER_RADIUS_PX = 4
const NEAR_RADIUS_PX = 2
// 取れていないインクをまとめる距離と、報告する最小の画素数
const GROUP_OPTIONS = { mergeRadius: 7, minInk: 60, rowTolerance: 30 }
// 背景に合っていないとみなす基準: 候補のインクのうち、背景に対応するインクがない割合。
// インク量の比(inkRatio)は書体の太さの違いでも大きくなるので、参考値として出すだけにする
const MISFIT_EXCESS = 0.25
const TILE_COLUMNS = 3
const TILE_ROWS = 4
const TILE_OVERLAP_PX = 60
const round = (value: number, digits = 2): number => Math.round(value * 10 ** digits) / 10 ** digits

/** canvas のフォント指定。取得済みのフォントを family:weight の別名で登録する */
function fontAlias(text: TextObject, fontDirs: readonly string[], registered: Map<string, string | null>): string | null {
  const key = `${text.fontFamily}:${text.fontWeight}`
  if (!registered.has(key)) {
    const known = BUNDLED_FONTS.find((font) => font.family === text.fontFamily && font.weight === text.fontWeight)
    const file = known && fontDirs.map((dir) => join(dir, known.file)).find((path) => existsSync(path))
    const alias = `pdfpe-review-${registered.size}`
    registered.set(key, file && GlobalFonts.registerFromPath(file, alias) ? alias : null)
  }
  return registered.get(key) ?? null
}

const toMask = (canvas: Canvas, threshold: number): Uint8Array => {
  const { data } = canvasToGray(canvas)
  const mask = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) if (data[i] < threshold) mask[i] = 1
  return mask
}

function whiteCanvas(width: number, height: number): { canvas: Canvas; ctx: SKRSContext2D } {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  return { canvas, ctx }
}

async function exportReview(req: ExportRequest): Promise<ReviewExportResult> {
  const { document, projectDir } = req
  const page = document.pages[0]
  if (!page) throw new Error('ページがありません')
  const label = pageLabel(page)
  const image = page.layers
    .filter((layer) => layer.kind === 'background')
    .flatMap((layer) => layer.objects)
    .find((object) => object.type === 'image')
  if (!image) throw new Error('背景ラスターがありません')
  const background = await loadRaster(assetPath(projectDir, image.asset), image)
  const { width, height } = background.raster
  const [a, , , d, e, f] = image.transform
  // PDF座標(pt)→ 画素
  const px = (x: number): number => ((x - e) / a) * width
  const py = (y: number): number => (1 - (y - f) / d) * height
  const pxPerPt = width / a
  const toPt = (x0: number, y0: number, x1: number, y1: number): Rect => [
    round(e + (x0 / width) * a),
    round(f + d - (y1 / height) * d),
    round(e + (x1 / width) * a),
    round(f + d - (y0 / height) * d)
  ]

  const layers = page.layers.filter((layer) => layer.kind === 'candidates' || layer.kind === 'confirmed')
  const objects: { object: DocObject; layer: string }[] = layers.flatMap((layer) =>
    layer.objects.map((object) => ({ object, layer: layer.kind }))
  )
  const backgroundInk = new Uint8Array(width * height)
  for (let i = 0; i < backgroundInk.length; i++) if (background.raster.data[i] < INK_THRESHOLD) backgroundInk[i] = 1

  // 罫線: 少し太らせて描き、罫線のインクを文字の評価から外す
  const lines = whiteCanvas(width, height)
  lines.ctx.strokeStyle = '#000000'
  lines.ctx.fillStyle = '#000000'
  for (const { object } of objects) {
    if (object.type === 'image') {
      // 切り出した画像(QRコードなど)の範囲は、取れているものとして扱う
      const [w, , , h, x, y] = object.transform
      lines.ctx.fillRect(px(x) - 2, py(y + h) - 2, w * pxPerPt + 4, h * pxPerPt + 4)
      continue
    }
    if (object.type !== 'path' || (object.stroke === null && object.fill === null) || object.nodes.length < 2) continue
    lines.ctx.lineWidth = (object.stroke === null ? 0 : object.strokeWidth) * pxPerPt + 4
    lines.ctx.beginPath()
    // 曲線の頂点(丸数字の丸など)は曲線として描く。直線でつなぐと、丸が「取れていないインク」と誤判定される
    const segment = (from: (typeof object.nodes)[number], to: (typeof object.nodes)[number]): void => {
      if (!from.out && !to.in) {
        lines.ctx.lineTo(px(to.x), py(to.y))
        return
      }
      const c1 = from.out ?? [from.x, from.y]
      const c2 = to.in ?? [to.x, to.y]
      lines.ctx.bezierCurveTo(px(c1[0]), py(c1[1]), px(c2[0]), py(c2[1]), px(to.x), py(to.y))
    }
    lines.ctx.moveTo(px(object.nodes[0].x), py(object.nodes[0].y))
    for (let i = 1; i < object.nodes.length; i++) segment(object.nodes[i - 1], object.nodes[i])
    if (object.closed) {
      segment(object.nodes.at(-1)!, object.nodes[0])
      lines.ctx.closePath()
    }
    lines.ctx.stroke()
    // 塗りのある Path(矢印など)は、中も塗る
    if (object.fill !== null) lines.ctx.fill()
  }
  const lineMask = toMask(lines.canvas, 200)

  // 候補の文字を、画面と同じフォント・サイズ・字間で描く
  const registered = new Map<string, string | null>()
  const drawText = (ctx: SKRSContext2D, text: TextObject, alias: string, offsetX: number, offsetY: number): void => {
    ctx.font = `${text.fontSize * pxPerPt}px "${alias}"`
    ctx.textBaseline = 'alphabetic'
    if (isVertical(text)) {
      // 縦書き: 1字ずつ中央揃えで下へ積む(canvas では縦書き用の字形にできないので、括弧などは横向きのまま)
      ctx.letterSpacing = '0px'
      ctx.textAlign = 'center'
      for (const item of verticalChars(text)) {
        ctx.fillText(item.char, px(text.transform[4]) - offsetX, py(text.transform[5]) + item.baseline * pxPerPt - offsetY)
      }
      return
    }
    ctx.letterSpacing = `${text.letterSpacing * pxPerPt}px`
    ctx.textAlign = text.align
    ctx.fillText(text.text, px(text.transform[4]) - offsetX, py(text.transform[5]) - offsetY)
  }
  const all = whiteCanvas(width, height)
  all.ctx.fillStyle = '#000000'
  const texts = objects.flatMap(({ object, layer }) => (object.type === 'text' ? [{ text: object, layer }] : []))
  for (const { text } of texts) {
    const alias = fontAlias(text, req.fontDirs, registered)
    if (alias) drawText(all.ctx, text, alias, 0, 0)
  }
  const textInk = toMask(all.canvas, INK_THRESHOLD)
  const nearBackground = dilateMask(backgroundInk, width, height, NEAR_RADIUS_PX)
  const nearText = dilateMask(textInk, width, height, COVER_RADIUS_PX)

  // Text ごとに、描いたインクと背景のインクを比べる
  const textRows = texts.map(({ text, layer }, index) => {
    const row = {
      index,
      id: text.id,
      layer,
      text: text.text,
      fontFamily: text.fontFamily,
      fontWeight: text.fontWeight,
      fontSize: text.fontSize,
      letterSpacing: text.letterSpacing,
      align: text.align,
      writingMode: text.writingMode ?? 'horizontal',
      x: text.transform[4],
      y: text.transform[5],
      role: text.role,
      fieldCode: text.fieldCode,
      /** 描いた文字のインクの範囲 [x0, y0, x1, y1](pt) */
      inkBox: null as Rect | null,
      /** 候補のインク量 ÷ 同じ範囲の背景のインク量(罫線を除く) */
      inkRatio: null as number | null,
      /** 候補のインクのうち、背景に対応するインクがない割合 */
      excess: null as number | null,
      misfit: false
    }
    const alias = fontAlias(text, req.fontDirs, registered)
    if (!alias) return row
    all.ctx.font = `${text.fontSize * pxPerPt}px "${alias}"`
    all.ctx.letterSpacing = `${text.letterSpacing * pxPerPt}px`
    all.ctx.textAlign = text.align
    let x0: number
    let y0: number
    let w: number
    let h: number
    if (isVertical(text)) {
      // 縦書きは外形(仮想ボディを積んだ範囲)を測る範囲にする
      const [bx0, by0, bx1, by1] = verticalLocalBox(text)
      x0 = Math.floor(px(text.transform[4] + bx0)) - 2
      y0 = Math.floor(py(text.transform[5] + by1)) - 2
      w = Math.ceil((bx1 - bx0) * pxPerPt) + 4
      h = Math.ceil((by1 - by0) * pxPerPt) + 4
    } else {
      const m = all.ctx.measureText(text.text)
      x0 = Math.floor(px(text.transform[4]) - m.actualBoundingBoxLeft) - 2
      y0 = Math.floor(py(text.transform[5]) - m.actualBoundingBoxAscent) - 2
      w = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight) + 4
      h = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + 4
    }
    if (w <= 4 || h <= 4 || w * h > 4_000_000) return row
    // 透明のままだと全面がインクと判定されるので、白地に描く
    const { canvas: single, ctx } = whiteCanvas(w, h)
    ctx.fillStyle = '#000000'
    drawText(ctx, text, alias, x0, y0)
    const mask = toMask(single, INK_THRESHOLD)
    let ink = 0
    let extra = 0
    let backgroundInBox = 0
    for (let y = 0; y < h; y++) {
      const gy = y0 + y
      if (gy < 0 || gy >= height) continue
      for (let x = 0; x < w; x++) {
        const gx = x0 + x
        if (gx < 0 || gx >= width) continue
        const i = gy * width + gx
        if (mask[y * w + x]) {
          ink++
          if (!nearBackground[i]) extra++
        }
        if (backgroundInk[i] && !lineMask[i]) backgroundInBox++
      }
    }
    row.inkBox = toPt(x0 + 2, y0 + 2, x0 + w - 2, y0 + h - 2)
    row.inkRatio = backgroundInBox === 0 ? null : round(ink / backgroundInBox)
    row.excess = ink === 0 ? null : round(extra / ink)
    row.misfit = row.excess !== null && row.excess > MISFIT_EXCESS
    return row
  })

  // 取れていないインク: 罫線にも候補の文字にも対応しない背景のインク
  const rest = new Uint8Array(width * height)
  for (let i = 0; i < rest.length; i++) if (backgroundInk[i] && !lineMask[i] && !nearText[i]) rest[i] = 1
  const groups = groupInk(rest, width, height, GROUP_OPTIONS)
  const uncovered = groups.map((group, i) => ({
    number: i + 1,
    box: toPt(group.x0, group.y0, group.x1 + 1, group.y1 + 1),
    inkPixels: group.ink
  }))

  // タイル画像: 背景(黒)に候補の文字(赤)を重ね、取れていないインクを青枠、合っていない Text を橙枠で示す
  const overlay = createCanvas(width, height)
  const octx = overlay.getContext('2d')
  octx.drawImage(background.canvas, 0, 0)
  octx.fillStyle = 'rgba(255, 0, 0, 0.55)'
  for (const { text } of texts) {
    const alias = fontAlias(text, req.fontDirs, registered)
    if (alias) drawText(octx, text, alias, 0, 0)
  }
  octx.letterSpacing = '0px'
  octx.textAlign = 'left'
  octx.font = 'bold 22px sans-serif'
  octx.lineWidth = 2
  const tag = (labelText: string, x: number, y: number, color: string): void => {
    const w = octx.measureText(labelText).width + 6
    octx.fillStyle = '#ffffff'
    octx.fillRect(x, y - 22, w, 22)
    octx.fillStyle = color
    octx.fillText(labelText, x + 3, y - 4)
  }
  groups.forEach((group, i) => {
    octx.strokeStyle = '#0050ff'
    octx.strokeRect(group.x0 - 4, group.y0 - 4, group.x1 - group.x0 + 9, group.y1 - group.y0 + 9)
    tag(`U${i + 1}`, group.x0 - 4, group.y0 - 6, '#0050ff')
  })
  for (const row of textRows) {
    if (!row.misfit || !row.inkBox) continue
    const [x0, y0, x1, y1] = [px(row.inkBox[0]), py(row.inkBox[3]), px(row.inkBox[2]), py(row.inkBox[1])]
    octx.strokeStyle = '#e07000'
    octx.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6)
    tag(`T${row.index}`, x0 - 3, y1 + 28, '#e07000')
  }

  const dir = join(req.outDir, 'review')
  await mkdir(dir, { recursive: true })
  const files: string[] = []
  const tiles: { file: string; box: Rect }[] = []
  const tileWidth = Math.ceil(width / TILE_COLUMNS)
  const tileHeight = Math.ceil(height / TILE_ROWS)
  for (let r = 0; r < TILE_ROWS; r++) {
    for (let c = 0; c < TILE_COLUMNS; c++) {
      const x0 = Math.max(0, c * tileWidth - TILE_OVERLAP_PX)
      const y0 = Math.max(0, r * tileHeight - TILE_OVERLAP_PX)
      const x1 = Math.min(width, (c + 1) * tileWidth + TILE_OVERLAP_PX)
      const y1 = Math.min(height, (r + 1) * tileHeight + TILE_OVERLAP_PX)
      const tile = createCanvas(x1 - x0, y1 - y0)
      tile.getContext('2d').drawImage(overlay, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0)
      const name = `${label}-tile-r${r + 1}-c${c + 1}.png`
      await writeFile(join(dir, name), await tile.encode('png'))
      files.push(name)
      tiles.push({ file: name, box: toPt(x0, y0, x1, y1) })
    }
  }

  const review = {
    version: 1,
    about:
      '候補の確認用データ。座標はPDF座標(pt、左下原点)。タイル画像は背景(黒)に候補の文字(赤)を重ねたもので、青枠 U<番号> は uncovered、橙枠 T<番号> は texts の index に対応する。修正は docs/corrections-format.md の形式の JSON にして、アプリの「修正を取り込む」で適用する。',
    page: page.sourcePageNumber,
    mediaBox: page.mediaBox,
    raster: { asset: image.asset, pixelWidth: width, pixelHeight: height, dpi: round(pxPerPt * 72), pxPerPt: round(pxPerPt, 4) },
    thresholds: { misfitExcess: MISFIT_EXCESS, uncoveredMinInkPixels: GROUP_OPTIONS.minInk },
    tiles,
    uncovered,
    texts: textRows
  }
  const reviewFile = `${label}-review.json`
  await writeFile(join(dir, reviewFile), JSON.stringify(review, null, 2) + '\n', 'utf8')
  files.push(reviewFile)
  return {
    dir,
    files,
    textCount: textRows.length,
    uncoveredCount: uncovered.length,
    misfitCount: textRows.filter((row) => row.misfit).length
  }
}

process.parentPort.on('message', (event) => {
  exportReview(event.data as ExportRequest)
    .then((result): WorkerReply<ReviewExportResult> => ({ ok: true, result }))
    .catch((err): WorkerReply<ReviewExportResult> => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }))
    .then((reply) => process.parentPort.postMessage(reply))
})
