// OCR の読み直し(design.md §3-44)。1回目の OCR の結果が背景と合っていない枠、読み落としのある枠を、
// インクの並びから縦の列・横の行に分けて読み直す。縦の列は、字を横1行に並べ直した画像にして読む。
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import type { Matrix } from '../../shared/model'
import type { OcrEngineId, OcrLine, TextDraft } from '../../shared/ocr'
import { fitVertical, isVertical, verticalChars, verticalLocalBox } from '../../shared/vertical'
import type { GrayRaster } from '../../shared/vectorizer'
import { dilateMask, groupInk } from '../review/uncovered'
import type { DetectedLine } from '../vectorize/line-detector'
import { recognize } from './engines'
import { cleanText, fitText, type InkMetrics } from './postprocess'
import { readGrid } from './grid-read'
import { normalizeMissedText } from './missed'
import { findCellPx, splitCell, type PixelRect, type RereadItem } from './reread'

export interface RereadContext {
  engineId: OcrEngineId
  /** 背景ラスターを描いたキャンバス(切り抜きの元にする) */
  canvas: Canvas
  raster: GrayRaster
  rules: DetectedLine[]
  /** 画素座標 → PDF座標 */
  pixelToPdf: Matrix
  inkThreshold: number
  minConfidence: number
  minFontSizePx: number
  /** 候補を描くフォント(canvas に登録済みの名前)と、その測り方 */
  fontAlias: string
  measure(text: string): InkMetrics
  visionBinary: string
  tesseractLangPath: string
  /** 文字のインクとして扱わない画素(丸囲みの輪など) */
  excludeInk?: Uint8Array
}

// 候補のインクのうち、背景に対応するインクがない割合がこれを超えたら「合っていない」とみなす(確認用データと同じ基準)
const MISFIT_EXCESS = 0.25
const NEAR_RADIUS_PX = 2
const COVER_RADIUS_PX = 4
// 読み落としとみなす、対応する候補のないインクのまとまりの最小の画素数
const UNCOVERED_MIN_INK = 40
// 読み直す枠の大きさの上限。広い領域は、枠ではなくページの余白のことが多い
const MAX_CELL_SHORT_SIDE_PX = 260
const MAX_CELL_AREA_PX = 500_000
// 読み直し用の画像での拡大率と、行の間の余白
const SCALE = 3
const PADDING_PX = 48
// 縦の列を横に並べ直すときの、字の間の余白(字の大きさに対する比)
const GLYPH_GAP = 0.25
// 縦の列として受け入れる字間の下限(em)
const MIN_VERTICAL_SPACING_EM = -0.15
// 元の候補がない場所(読み落とし)に足す候補に許す、背景に合わないインクの割合の上限
const MAX_EXCESS_FOR_NEW = 0.4
// 読み落としの拾い直し: まとめる距離、最小の画素数、1字とみなす大きさの上限、読ませるときの拡大率
const MISSED_MERGE_RADIUS_PX = 3
const MISSED_MIN_INK = 14
const MISSED_MAX_SIZE_PX = 70
const MISSED_SCALE = 5
const MISSED_MIN_FONT_PX = 6
// 読んだ字を描いたとき、元のインクのこの割合以上に重なること
const MISSED_MIN_COVERAGE = 0.6
// 横棒とみなす形(幅 ÷ 高さの下限、高さの上限)
const MISSED_BAR_ASPECT = 4
const MISSED_BAR_MAX_HEIGHT_PX = 10
// 拾い直す字の大きさの範囲(ページの文字の大きさの中央値に対する比)
const MISSED_MIN_SIZE_RATIO = 0.55
const MISSED_MAX_SIZE_RATIO = 1.5
const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits

interface Placed {
  item: RereadItem
  cell: PixelRect
  /** 読み直し用の画像の中での行の範囲 */
  top: number
  bottom: number
}

const contains = (rect: PixelRect, x: number, y: number, margin = 0): boolean =>
  x >= rect.x0 - margin && x < rect.x1 + margin && y >= rect.y0 - margin && y < rect.y1 + margin

function toMask(canvas: Canvas, threshold: number): Uint8Array {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  const mask = new Uint8Array(canvas.width * canvas.height)
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2] < threshold) mask[i] = 1
  }
  return mask
}

function whiteCanvas(width: number, height: number): { canvas: Canvas; ctx: SKRSContext2D } {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#000000'
  return { canvas, ctx }
}

/**
 * drafts のうち、読み直しでよくなる見込みのあるものを作り直して返す。
 * 読み直した列・行に重なっていた候補は外し、読み直した結果に置き換える。
 */
export async function rereadCells(context: RereadContext, drafts: readonly TextDraft[]): Promise<TextDraft[]> {
  const { raster, rules, pixelToPdf: m, measure } = context
  const { width, height } = raster
  const pxPerPt = 1 / Math.hypot(m[0], m[1])
  const toPxX = (x: number): number => (x - m[4]) / m[0]
  const toPxY = (y: number): number => (y - m[5]) / m[3]

  // 文字のインク(罫線の上は除く)
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

  if (context.excludeInk) for (let i = 0; i < ink.length; i++) if (context.excludeInk[i]) ink[i] = 0

  // 候補を、画面と同じフォント・サイズ・字間で描く(縦書きにまとめたものは、ここより後で作るので来ない)
  const drawDraft = (ctx: SKRSContext2D, draft: TextDraft, offsetX: number, offsetY: number): void => {
    ctx.font = `${draft.fontSize * pxPerPt}px "${context.fontAlias}"`
    ctx.textBaseline = 'alphabetic'
    if (isVertical(draft)) {
      ctx.letterSpacing = '0px'
      ctx.textAlign = 'center'
      for (const item of verticalChars(draft)) {
        ctx.fillText(item.char, toPxX(draft.transform[4]) - offsetX, toPxY(draft.transform[5]) + item.baseline * pxPerPt - offsetY)
      }
      return
    }
    ctx.textAlign = 'left'
    ctx.letterSpacing = `${draft.letterSpacing * pxPerPt}px`
    ctx.fillText(draft.text, toPxX(draft.transform[4]) - offsetX, toPxY(draft.transform[5]) - offsetY)
  }
  const all = whiteCanvas(width, height)
  for (const draft of drafts) drawDraft(all.ctx, draft, 0, 0)
  const textInk = toMask(all.canvas, context.inkThreshold)
  const nearInk = dilateMask(ink, width, height, NEAR_RADIUS_PX)
  const nearText = dilateMask(textInk, width, height, COVER_RADIUS_PX)

  // 候補の中心と、背景との合い具合(excess: 描いたインクのうち、背景に対応するインクがない割合)
  const evaluate = (draft: TextDraft): { centerX: number; centerY: number; excess: number; misfit: boolean } => {
    const size = draft.fontSize * pxPerPt
    let x0: number
    let y0: number
    let w: number
    let h: number
    if (isVertical(draft)) {
      const [bx0, by0, bx1, by1] = verticalLocalBox(draft)
      x0 = Math.floor(toPxX(draft.transform[4] + bx0)) - 2
      y0 = Math.floor(toPxY(draft.transform[5] + by1)) - 2
      w = Math.ceil((bx1 - bx0) * pxPerPt) + 4
      h = Math.ceil((by1 - by0) * pxPerPt) + 4
    } else {
      const metrics = measure(draft.text)
      const spacing = Math.max(0, [...draft.text].length - 1) * draft.letterSpacing * pxPerPt
      x0 = Math.floor(toPxX(draft.transform[4]) - metrics.left * size) - 2
      y0 = Math.floor(toPxY(draft.transform[5]) - metrics.ascent * size) - 2
      w = Math.ceil((metrics.left + metrics.right) * size + spacing) + 4
      h = Math.ceil((metrics.ascent + metrics.descent) * size) + 4
    }
    const info = { centerX: x0 + w / 2, centerY: y0 + h / 2, excess: 0, misfit: false }
    if (w <= 4 || h <= 4 || w * h > 4_000_000) return info
    const single = whiteCanvas(w, h)
    drawDraft(single.ctx, draft, x0, y0)
    const mask = toMask(single.canvas, context.inkThreshold)
    let drawn = 0
    let extra = 0
    for (let y = 0; y < h; y++) {
      const gy = y0 + y
      if (gy < 0 || gy >= height) continue
      for (let x = 0; x < w; x++) {
        const gx = x0 + x
        if (gx < 0 || gx >= width || !mask[y * w + x]) continue
        drawn++
        if (!nearInk[gy * width + gx]) extra++
      }
    }
    info.excess = drawn > 0 ? extra / drawn : 1
    info.misfit = info.excess > MISFIT_EXCESS
    return info
  }
  // 丸囲みの文字として作った候補は、輪から決めた位置と大きさなので、読み直しのきっかけにも置き換えの対象にもしない
  const isFixed = (draft: TextDraft): boolean => draft.meta.circled !== undefined
  const infos = drafts.map((draft) => (isFixed(draft) ? { ...evaluate(draft), misfit: false } : evaluate(draft)))

  // 読み直すきっかけ: 合っていない候補の中心と、読み落としたインクのまとまりの中心
  const rest = new Uint8Array(width * height)
  for (let i = 0; i < rest.length; i++) if (ink[i] && !nearText[i]) rest[i] = 1
  const triggers = [
    ...infos.filter((info) => info.misfit).map((info) => ({ x: info.centerX, y: info.centerY })),
    ...groupInk(rest, width, height, { mergeRadius: 7, minInk: UNCOVERED_MIN_INK, rowTolerance: 30 }).map((group) => ({
      x: (group.x0 + group.x1 + 1) / 2,
      y: (group.y0 + group.y1 + 1) / 2
    }))
  ]

  // きっかけのある枠を、列・行に分ける。きっかけを含む列・行だけを読み直す
  const cells = new Map<string, PixelRect>()
  for (const trigger of triggers) {
    const cell = findCellPx(rules, trigger.x, trigger.y)
    if (!cell) continue
    const w = cell.x1 - cell.x0
    const h = cell.y1 - cell.y0
    if (Math.min(w, h) > MAX_CELL_SHORT_SIDE_PX || w * h > MAX_CELL_AREA_PX) continue
    cells.set(`${cell.x0},${cell.y0},${cell.x1},${cell.y1}`, cell)
  }
  const placed: Placed[] = []
  let cursor = PADDING_PX
  let mosaicWidth = 0
  const stripSize = (item: RereadItem): { width: number; height: number; glyph: number } => {
    if (item.mode === 'horizontal') return { width: (item.box.x1 - item.box.x0) * SCALE, height: (item.box.y1 - item.box.y0) * SCALE, glyph: 0 }
    const glyph = Math.max(...item.glyphs.map((g) => Math.max(g.x1 - g.x0, g.y1 - g.y0))) * SCALE
    return { width: item.glyphs.length * glyph + (item.glyphs.length - 1) * glyph * GLYPH_GAP, height: glyph, glyph }
  }
  // 罫線の届き方によって、同じ場所が少し違う枠として2回見つかることがある。重なる列・行は広いほうだけを使う
  const area = (rect: PixelRect): number => (rect.x1 - rect.x0) * (rect.y1 - rect.y0)
  const overlap = (p: PixelRect, q: PixelRect): number =>
    Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0)) * Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0))
  const candidates = [...cells.values()]
    .flatMap((cell) => splitCell(ink, width, cell).map((item) => ({ item, cell })))
    .filter(({ item }) => triggers.some((trigger) => contains(item.box, trigger.x, trigger.y, 3)))
    .sort((p, q) => area(q.item.box) - area(p.item.box))
  const accepted: typeof candidates = []
  for (const candidate of candidates) {
    if (accepted.some((other) => overlap(candidate.item.box, other.item.box) > 0.5 * area(candidate.item.box))) continue
    accepted.push(candidate)
  }
  // 読み直し用の画像では、元の位置の順(上から、左から)に並べる
  accepted.sort((p, q) => p.item.box.y0 - q.item.box.y0 || p.item.box.x0 - q.item.box.x0)
  for (const { item, cell } of accepted) {
    const size = stripSize(item)
    placed.push({ item, cell, top: cursor, bottom: cursor + size.height })
    cursor += size.height + PADDING_PX
    mosaicWidth = Math.max(mosaicWidth, size.width)
  }
  if (placed.length === 0) return [...drafts]

  // 読み直し用の画像: 1つの列・行を1行にして、縦に並べる
  const mosaic = whiteCanvas(Math.ceil(mosaicWidth) + PADDING_PX * 2, Math.ceil(cursor))
  for (const { item, top } of placed) {
    if (item.mode === 'horizontal') {
      const { box } = item
      mosaic.ctx.drawImage(context.canvas, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, PADDING_PX, top, (box.x1 - box.x0) * SCALE, (box.y1 - box.y0) * SCALE)
      continue
    }
    const { glyph } = stripSize(item)
    item.glyphs.forEach((g, i) => {
      // 縦に並んでいた字を、上から順に左から右へ並べる。字は枠の中央に置く
      const w = (g.x1 - g.x0) * SCALE
      const h = (g.y1 - g.y0) * SCALE
      const x = PADDING_PX + i * glyph * (1 + GLYPH_GAP) + (glyph - w) / 2
      mosaic.ctx.drawImage(context.canvas, g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0, x, top + (glyph - h) / 2, w, h)
    })
  }
  const pngPath = join(tmpdir(), `pdfpe-reread-${process.pid}-${Date.now()}.png`)
  let lines: OcrLine[]
  try {
    await writeFile(pngPath, await mosaic.canvas.encode('png'))
    lines = await recognize(context.engineId, {
      pngPath,
      canvas: mosaic.canvas,
      rules: [],
      visionBinary: context.visionBinary,
      tesseractLangPath: context.tesseractLangPath
    })
  } finally {
    await rm(pngPath, { force: true })
  }

  // 読めた行を、元の列・行に戻して候補にする
  const created: TextDraft[] = []
  const done: Placed[] = []
  /** この列・行の読み直しで置き換わる、元の候補 */
  const replacedBy = ({ item, cell }: Placed): number[] =>
    infos.flatMap((info, i) =>
      !isFixed(drafts[i]) && (contains(item.box, info.centerX, info.centerY, 3) || (info.misfit && contains(cell, info.centerX, info.centerY)))
        ? [i]
        : []
    )
  /** 読み直した候補を、元の候補より背景に合うときだけ採用する */
  const accept = (entry: Placed, draft: TextDraft): void => {
    const excess = evaluate(draft).excess
    const replaced = replacedBy(entry)
    const before = replaced.length === 0 ? MAX_EXCESS_FOR_NEW : Math.max(...replaced.map((i) => infos[i].excess))
    if (excess > before) return
    created.push(draft)
    done.push(entry)
  }
  for (const entry of placed) {
    const { item, top, bottom } = entry
    const own = lines
      .filter((line) => {
        const center = line.box.y + line.box.height / 2
        return center >= top - PADDING_PX / 3 && center < bottom + PADDING_PX / 3
      })
      .sort((p, q) => p.box.x - q.box.x)
    if (own.length === 0) continue
    const confidence = Math.min(...own.map((line) => line.confidence))
    if (confidence < context.minConfidence) continue
    const joined = cleanText(own.map((line) => line.text).join(''))
    const base = {
      type: 'text' as const,
      role: 'label' as const,
      fieldCode: null,
      tags: [],
      meta: { ocr: context.engineId, confidence: round(confidence, 2), reread: item.mode },
      fontFamily: drafts[0]?.fontFamily ?? 'Noto Sans JP',
      fontWeight: drafts[0]?.fontWeight ?? 400,
      fill: '#000000',
      align: 'left' as const,
      outline: false
    }
    if (item.mode === 'horizontal') {
      if (joined === '') continue
      const fit = fitText(item.box, [...joined].length, measure(joined))
      if (!fit || fit.fontSize < context.minFontSizePx) continue
      accept(entry, {
        ...base,
        text: joined,
        transform: [1, 0, 0, 1, round(m[0] * fit.originX + m[4], 3), round(m[3] * fit.baselineY + m[5], 3)],
        fontSize: round(fit.fontSize / pxPerPt, 2),
        letterSpacing: round(fit.letterSpacing / pxPerPt, 2)
      })
      continue
    }
    // 縦の列: 字の数が、分けた字の数と大きく違うなら信用しない
    const text = joined.replace(/\s+/g, '')
    const count = [...text].length
    if (count < 2 || Math.abs(count - item.glyphs.length) > Math.max(1, Math.round(item.glyphs.length / 3))) continue
    const { box } = item
    const fit = fitVertical(
      [...text].map((char) => measure(char)),
      [m[0] * box.x0 + m[4], m[3] * box.y1 + m[5], m[0] * box.x1 + m[4], m[3] * box.y0 + m[5]]
    )
    if (!fit || fit.fontSize * pxPerPt < context.minFontSizePx) continue
    // 字が重なるほど詰まるなら、縦の列ではなかった(2行の横書きを列と見誤った、など)
    if (fit.letterSpacing < MIN_VERTICAL_SPACING_EM * fit.fontSize) continue
    accept(entry, {
      ...base,
      text,
      writingMode: 'vertical',
      transform: [1, 0, 0, 1, round(fit.x, 3), round(fit.y, 3)],
      fontSize: round(fit.fontSize, 2),
      letterSpacing: round(fit.letterSpacing, 2)
    })
  }

  // 読み直した列・行に重なっていた候補と、同じ枠の中で合っていなかった候補を外す
  const removed = new Set(done.flatMap(replacedBy))
  const kept = drafts.filter((_, i) => !removed.has(i))
  const reread = [...kept, ...created]

  // ---- 読み落としの拾い直し: どの候補にも対応しない小さなインクのまとまり(1字、記号)を、1つずつ読む
  const after = whiteCanvas(width, height)
  for (const draft of reread) drawDraft(after.ctx, draft, 0, 0)
  const covered = dilateMask(toMask(after.canvas, context.inkThreshold), width, height, COVER_RADIUS_PX)
  const missed = new Uint8Array(width * height)
  for (let i = 0; i < missed.length; i++) if (ink[i] && !covered[i]) missed[i] = 1
  const spots = groupInk(missed, width, height, { mergeRadius: MISSED_MERGE_RADIUS_PX, minInk: MISSED_MIN_INK, rowTolerance: 30 }).filter(
    (group) => group.x1 - group.x0 < MISSED_MAX_SIZE_PX && group.y1 - group.y0 < MISSED_MAX_SIZE_PX
  )
  if (spots.length === 0) return reread

  const boxOf = (group: (typeof spots)[number]): PixelRect => ({ x0: group.x0, y0: group.y0, x1: group.x1 + 1, y1: group.y1 + 1 })
  /** 横棒(記入欄の区切りの「ー」)。OCR は単独の横棒を読まないので、形で決める */
  const isBar = (group: (typeof spots)[number]): boolean => {
    const w = group.x1 - group.x0 + 1
    const h = group.y1 - group.y0 + 1
    return w >= MISSED_BAR_ASPECT * h && h <= MISSED_BAR_MAX_HEIGHT_PX && group.ink >= 0.7 * w * h
  }
  const toRead = spots.filter((group) => !isBar(group))
  const texts = await readGrid(
    toRead.map((group) => ({
      width: (group.x1 - group.x0 + 1) * MISSED_SCALE,
      height: (group.y1 - group.y0 + 1) * MISSED_SCALE,
      draw: (ctx, left, top) => {
        for (let y = group.y0; y <= group.y1; y++) {
          for (let x = group.x0; x <= group.x1; x++) {
            if (missed[y * width + x]) ctx.fillRect(left + (x - group.x0) * MISSED_SCALE, top + (y - group.y0) * MISSED_SCALE, MISSED_SCALE, MISSED_SCALE)
          }
        }
      }
    })),
    {
      engineId: context.engineId,
      visionBinary: context.visionBinary,
      tesseractLangPath: context.tesseractLangPath,
      accept: (text) => normalizeMissedText(text) !== null,
      debugName: 'missed'
    }
  )

  /** spot のインクのうち、draft を描いたインクの近くにある割合(字が合っていれば 1 に近い) */
  const coverage = (draft: TextDraft, box: PixelRect): number => {
    const pad = 6
    const w = box.x1 - box.x0 + pad * 2
    const h = box.y1 - box.y0 + pad * 2
    const local = whiteCanvas(w, h)
    drawDraft(local.ctx, draft, box.x0 - pad, box.y0 - pad)
    const drawn = toMask(local.canvas, context.inkThreshold)
    let total = 0
    let near = 0
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = box.x0; x < box.x1; x++) {
        if (!missed[y * width + x]) continue
        total++
        let hit = false
        for (let dy = -2; dy <= 2 && !hit; dy++) {
          for (let dx = -2; dx <= 2 && !hit; dx++) {
            const lx = x + dx - (box.x0 - pad)
            const ly = y + dy - (box.y0 - pad)
            if (lx >= 0 && ly >= 0 && lx < w && ly < h && drawn[ly * w + lx]) hit = true
          }
        }
        if (hit) near++
      }
    }
    return total === 0 ? 0 : near / total
  }

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
  const picked: TextDraft[] = []
  const sizes = reread.map((draft) => draft.fontSize).sort((p, q) => p - q)
  const typicalSize = sizes.length > 0 ? sizes[sizes.length >> 1] : 8
  const tryAdd = (group: (typeof spots)[number], text: string, confidence: number, byWidth: boolean): void => {
    const box = boxOf(group)
    const metrics = measure(text)
    const count = [...text].length
    // 横棒は高さが小さく、高さから大きさを決めると不安定なので、幅から決める
    const fit = byWidth
      ? (() => {
          const fontSize = (box.x1 - box.x0) / (metrics.left + metrics.right)
          return { fontSize, letterSpacing: 0, originX: box.x0 + metrics.left * fontSize, baselineY: (box.y0 + box.y1) / 2 + ((metrics.ascent - metrics.descent) * fontSize) / 2 }
        })()
      : fitText(box, count, metrics)
    if (!fit || fit.fontSize < MISSED_MIN_FONT_PX) return
    // ページのふつうの文字の大きさから外れるものは、字ではない(点線のかけら、罫線の切れ端、図形の一部など)
    const sizePt = fit.fontSize / pxPerPt
    if (sizePt < MISSED_MIN_SIZE_RATIO * typicalSize || sizePt > MISSED_MAX_SIZE_RATIO * typicalSize) return
    const draft: TextDraft = {
      ...base,
      meta: { ocr: context.engineId, confidence: round(confidence, 2), missed: true },
      text,
      transform: [1, 0, 0, 1, round(m[0] * fit.originX + m[4], 3), round(m[3] * fit.baselineY + m[5], 3)],
      fontSize: round(fit.fontSize / pxPerPt, 2),
      letterSpacing: round(fit.letterSpacing / pxPerPt, 2)
    }
    // 読んだ字を描いて、元のインクと重なるときだけ採用する(字の一部を別の字として読んだものを入れないため)
    if (evaluate(draft).excess > MAX_EXCESS_FOR_NEW || coverage(draft, box) < MISSED_MIN_COVERAGE) return
    picked.push(draft)
  }
  for (const group of spots) if (isBar(group)) tryAdd(group, 'ー', 1, true)
  toRead.forEach((group, i) => {
    const text = normalizeMissedText(texts[i].text)
    if (text && texts[i].confidence >= context.minConfidence) tryAdd(group, text, texts[i].confidence, false)
  })
  return [...reread, ...picked]
}
