// 丸囲みの文字の検出(design.md §3-45)。輪を画像から探し、中の文字を読んで候補にする。
// ①〜㊿ と丸囲みのカタカナは1つの Text、51 以上の丸数字は「数字の Text + 丸の Path」にする。
import { copyFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { CIRCLE_SOURCE, type OcrLine, type TextDraft } from '../../shared/ocr'
import type { PathDraft } from '../../shared/vectorizer'
import { findRings, innerInk, parseCircled, type Ring } from './circles'
import { recognize } from './engines'
import { fitText } from './postprocess'
import type { RereadContext } from './reread-run'

// 輪の中を読むための画像での拡大率と、行の間の余白
const SCALE = 6
const PADDING_PX = 60
// 格子の中で、隣の輪の文字との間に空ける幅(px)
const GAP_X_PX = 70
// 輪の中を読む回数の上限
const READ_PASSES = 3
// 円をベジェ曲線4本で近似するときの、制御点までの距離(半径に対する比)
const KAPPA = 0.5522847498
const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits

export interface CircledResult {
  drafts: TextDraft[]
  paths: PathDraft[]
  /** 輪の画素。読み直しでは文字のインクとして扱わない */
  ringMask: Uint8Array
}

/** 罫線の上を除いた、文字のインクのマスク */
export function buildInkMask(context: Pick<RereadContext, 'raster' | 'rules' | 'inkThreshold'>): Uint8Array {
  const { raster, rules } = context
  const { width, height } = raster
  const ink = new Uint8Array(width * height)
  for (let i = 0; i < ink.length; i++) if (raster.data[i] < context.inkThreshold) ink[i] = 1
  for (const rule of rules) {
    const half = rule.thickness / 2 + 1
    const [x0, y0, x1, y1] =
      rule.orientation === 'h'
        ? [rule.start, rule.center - half, rule.end, rule.center + half]
        : [rule.center - half, rule.start, rule.center + half, rule.end]
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y++) {
      ink.fill(0, y * width + Math.max(0, Math.floor(x0)), y * width + Math.min(width, Math.ceil(x1)))
    }
  }
  return ink
}

/**
 * 丸囲みの文字を検出して、drafts のうち輪に重なっていたもの(丸を外して数字だけ読んだ候補など)と入れ替える。
 */
export async function detectCircled(context: RereadContext, drafts: readonly TextDraft[]): Promise<CircledResult> {
  const { raster, pixelToPdf: m, measure } = context
  const { width, height } = raster
  const ink = buildInkMask(context)
  const ringMask = new Uint8Array(width * height)
  const rings = findRings(ink, width, height)
  if (rings.length === 0) return { drafts: [...drafts], paths: [], ringMask }

  // 輪の中のインクだけを、格子状に並べた画像にして読む(輪があると OCR が読み違えるため)。
  // 縦1列に並べると細長い画像になり、OCR が縮小して何も読めなくなるので、正方形に近い形にする。
  // 横の間隔は単語の間くらいに詰める(離しすぎると、OCR が1字だけの並びを文字として拾わない)
  const entries = rings.map((ring) => ({ ring, inner: innerInk(ink, width, ring)! }))
  const read = entries.map(() => ({ text: '', confidence: 1 }))
  const readInner = async (indices: readonly number[], pass: number): Promise<void> => {
    const cellWidth = Math.max(...indices.map((i) => entries[i].inner.x1 - entries[i].inner.x0)) * SCALE + GAP_X_PX
    const cellHeight = Math.max(...indices.map((i) => entries[i].inner.y1 - entries[i].inner.y0)) * SCALE + PADDING_PX
    const columns = Math.max(1, Math.ceil(Math.sqrt((indices.length * cellHeight) / cellWidth)))
    const rows = Math.ceil(indices.length / columns)
    const mosaic = createCanvas(PADDING_PX * 2 + columns * cellWidth, PADDING_PX * 2 + rows * cellHeight)
    const ctx = mosaic.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, mosaic.width, mosaic.height)
    ctx.fillStyle = '#000000'
    indices.forEach((entryIndex, slot) => {
      const { ring, inner } = entries[entryIndex]
      const own = new Set(ring.pixels)
      const limit = ring.radius - ring.thickness / 2 - 1
      const left = PADDING_PX + (slot % columns) * cellWidth
      const top = PADDING_PX + Math.floor(slot / columns) * cellHeight
      for (let y = inner.y0; y < inner.y1; y++) {
        for (let x = inner.x0; x < inner.x1; x++) {
          const i = y * width + x
          if (!ink[i] || own.has(i) || Math.hypot(x + 0.5 - ring.cx, y + 0.5 - ring.cy) > limit) continue
          ctx.fillRect(left + (x - inner.x0) * SCALE, top + (y - inner.y0) * SCALE, SCALE, SCALE)
        }
      }
    })
    const pngPath = join(tmpdir(), `pdfpe-circles-${process.pid}-${Date.now()}-${pass}.png`)
    let lines: OcrLine[]
    try {
      await writeFile(pngPath, await mosaic.encode('png'))
      lines = await recognize(context.engineId, {
        pngPath,
        canvas: mosaic,
        rules: [],
        visionBinary: context.visionBinary,
        tesseractLangPath: context.tesseractLangPath
      })
      // 調査用: 環境変数で指定されたフォルダに、読ませた画像と結果を残す
      const debugDir = process.env.PDFPE_OCR_DEBUG_DIR
      if (debugDir) {
        await copyFile(pngPath, join(debugDir, `circles-${pass}.png`)).catch(() => {})
        await writeFile(join(debugDir, `circles-${pass}.json`), JSON.stringify({ count: indices.length, columns, lines }, null, 2)).catch(() => {})
      }
    } finally {
      await rm(pngPath, { force: true })
    }
    // 読めた文字を、位置から元の輪に戻す(隣り合う輪の文字が1行として読まれるので、1字ずつ振り分ける)
    const slotAt = (x: number, y: number): number => {
      const column = Math.floor((x - PADDING_PX + GAP_X_PX / 2) / cellWidth)
      const row = Math.floor((y - PADDING_PX + PADDING_PX / 2) / cellHeight)
      return column >= 0 && column < columns && row >= 0 ? row * columns + column : -1
    }
    const texts = indices.map(() => ({ text: '', confidence: 1 }))
    for (const line of [...lines].sort((p, q) => p.box.x - q.box.x)) {
      const chars = [...line.text]
      chars.forEach((char, i) => {
        const box = line.chars.length === chars.length ? line.chars[i] : null
        if (line.chars.length === chars.length && !box) return
        const target = box ?? line.box
        const slot = slotAt(target.x + target.width / 2, target.y + target.height / 2)
        if (slot < 0 || slot >= texts.length) return
        texts[slot].text += char
        texts[slot].confidence = Math.min(texts[slot].confidence, line.confidence)
      })
    }
    indices.forEach((entryIndex, slot) => {
      if (parseCircled(texts[slot].text)) read[entryIndex] = texts[slot]
    })
  }
  // 1回で読めなかった輪は、読めなかったものだけを並べ直してもう一度読む(並びが変わると読めることがある)
  for (let pass = 0; pass < READ_PASSES; pass++) {
    const pending = entries.map((_, i) => i).filter((i) => !parseCircled(read[i].text))
    if (pending.length === 0) break
    await readInner(pending, pass)
  }

  const pxPerPt = 1 / Math.hypot(m[0], m[1])
  const toPdf = (x: number, y: number): [number, number] => [m[0] * x + m[4], m[3] * y + m[5]]
  const base = {
    type: 'text' as const,
    role: 'label' as const,
    fieldCode: null,
    tags: [],
    fontFamily: drafts[0]?.fontFamily ?? 'Noto Sans JP',
    fontWeight: drafts[0]?.fontWeight ?? 400,
    fill: '#000000',
    align: 'left' as const,
    outline: false
  }
  const created: TextDraft[] = []
  const paths: PathDraft[] = []
  const found: Ring[] = []
  entries.forEach(({ ring, inner }, index) => {
    const content = parseCircled(read[index].text)
    if (!content) return
    const confidence = round(read[index].confidence, 2)
    const meta = { ocr: context.engineId, confidence, circled: content.kind === 'number' ? content.number : (content.number ?? content.char) }

    if (content.kind === 'char') {
      // 丸ごと1文字: 輪の外接矩形に、丸囲みの字形のインクが重なるようにする
      const fit = fitText(ring.box, 1, measure(content.char))
      if (!fit) return
      const [x, y] = toPdf(fit.originX, fit.baselineY)
      created.push({ ...base, meta, text: content.char, transform: [1, 0, 0, 1, round(x, 3), round(y, 3)], fontSize: round(fit.fontSize / pxPerPt, 2), letterSpacing: 0 })
    } else {
      // Unicode にない丸数字: 数字は中のインクに合わせた Text、丸は Path にする
      const fit = fitText(inner, content.digits.length, measure(content.digits))
      if (!fit) return
      const [x, y] = toPdf(fit.originX, fit.baselineY)
      created.push({
        ...base,
        meta,
        text: content.digits,
        transform: [1, 0, 0, 1, round(x, 3), round(y, 3)],
        fontSize: round(fit.fontSize / pxPerPt, 2),
        letterSpacing: round(fit.letterSpacing / pxPerPt, 2)
      })
      const [cx, cy] = toPdf(ring.cx, ring.cy)
      const r = ring.radius / pxPerPt
      const k = r * KAPPA
      const point = (px: number, py: number): number[] => [round(px, 3), round(py, 3)]
      const node = (px: number, py: number, inDelta: [number, number], outDelta: [number, number]) => ({
        x: round(px, 3),
        y: round(py, 3),
        in: point(px + inDelta[0], py + inDelta[1]) as [number, number],
        out: point(px + outDelta[0], py + outDelta[1]) as [number, number]
      })
      paths.push({
        type: 'path',
        role: 'label',
        fieldCode: null,
        transform: [1, 0, 0, 1, 0, 0],
        tags: [],
        meta: { source: CIRCLE_SOURCE, circled: content.number },
        // 右 → 上 → 左 → 下 の順(反時計回り)
        nodes: [
          node(cx + r, cy, [0, -k], [0, k]),
          node(cx, cy + r, [k, 0], [-k, 0]),
          node(cx - r, cy, [0, k], [0, -k]),
          node(cx, cy - r, [-k, 0], [k, 0])
        ],
        closed: true,
        fill: null,
        stroke: '#000000',
        strokeWidth: round(ring.thickness / pxPerPt, 3),
        dash: null,
        lineCap: 'butt'
      })
    }
    found.push(ring)
    for (const i of ring.pixels) ringMask[i] = 1
  })

  // 輪の中にあった元の候補(丸を外して読んだ数字など)は、入れ替える
  const inRing = (draft: TextDraft): boolean => {
    const metrics = measure(draft.text)
    const size = draft.fontSize * pxPerPt
    const spacing = Math.max(0, [...draft.text].length - 1) * draft.letterSpacing * pxPerPt
    const x = (draft.transform[4] - m[4]) / m[0] + ((metrics.right - metrics.left) * size + spacing) / 2
    const y = (draft.transform[5] - m[5]) / m[3] - ((metrics.ascent - metrics.descent) * size) / 2
    return found.some((ring) => Math.hypot(x - ring.cx, y - ring.cy) <= ring.radius)
  }
  return { drafts: [...drafts.filter((draft) => !inRing(draft)), ...created], paths, ringMask }
}
