// OCR の読み直し(design.md §3-44)のうち、画像の解析だけを行う部分。
// 縦書きや2段組は、OCR が1行の大きな文字として読み違えたり、読み落としたりする。
// 罫線で囲まれた枠の中のインクを、縦の列か横の行に分け直して、列・行ごとに読み直すための道具。
import type { DetectedLine } from '../vectorize/line-detector.ts'

/** 画素の範囲 [start, end) */
export interface Band {
  start: number
  end: number
}

export interface PixelRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

// 罫線の端が少し届いていなくても枠として扱う許容量(px)
const REACH_TOLERANCE_PX = 4

/** 点 (x, y) を囲む、上下左右に最も近い実線の罫線の内側。どれかの方向に罫線がなければ null */
export function findCellPx(rules: readonly DetectedLine[], x: number, y: number): PixelRect | null {
  const nearest = (orientation: 'h' | 'v', along: number, across: number, side: -1 | 1): DetectedLine | null => {
    let best: DetectedLine | null = null
    for (const rule of rules) {
      if (rule.orientation !== orientation || rule.dash !== null) continue
      if (rule.start - REACH_TOLERANCE_PX > along || rule.end + REACH_TOLERANCE_PX < along) continue
      if ((rule.center - across) * side <= 0) continue
      if (!best || (rule.center - best.center) * side < 0) best = rule
    }
    return best
  }
  const left = nearest('v', y, x, -1)
  const right = nearest('v', y, x, 1)
  const top = nearest('h', x, y, -1)
  const bottom = nearest('h', x, y, 1)
  if (!left || !right || !top || !bottom) return null
  // 罫線の太さと、縁のにじみのぶんだけ内側にする
  const inset = (rule: DetectedLine): number => rule.thickness / 2 + 2
  const rect = {
    x0: Math.ceil(left.center + inset(left)),
    y0: Math.ceil(top.center + inset(top)),
    x1: Math.floor(right.center - inset(right)),
    y1: Math.floor(bottom.center - inset(bottom))
  }
  return rect.x1 > rect.x0 && rect.y1 > rect.y0 ? rect : null
}

/**
 * rect の中のインクを x 軸(または y 軸)に投影し、インクのある範囲を返す。
 * minGap 画素未満の切れ目はつなぐ。
 */
export function projectBands(mask: Uint8Array, width: number, rect: PixelRect, axis: 'x' | 'y', minGap: number): Band[] {
  const length = axis === 'x' ? rect.x1 - rect.x0 : rect.y1 - rect.y0
  const filled = new Uint8Array(Math.max(0, length))
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      if (mask[y * width + x]) filled[axis === 'x' ? x - rect.x0 : y - rect.y0] = 1
    }
  }
  const origin = axis === 'x' ? rect.x0 : rect.y0
  const bands: Band[] = []
  for (let i = 0; i < filled.length; i++) {
    if (!filled[i]) continue
    let end = i + 1
    while (end < filled.length && filled[end]) end++
    const last = bands.at(-1)
    if (last && origin + i - last.end < minGap) last.end = origin + end
    else bands.push({ start: origin + i, end: origin + end })
    i = end
  }
  return bands
}

export type ReadMode = 'vertical' | 'horizontal'

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
const gaps = (bands: Band[]): number[] => bands.slice(1).map((band, i) => band.start - bands[i].end)

// 縦の1列とみなす、インクの範囲の縦横比の下限
const MIN_COLUMN_ASPECT = 1.6
// 文字とみなす最小の大きさ(px)
const MIN_GLYPH_PX = 8

/**
 * 枠の中のインクが、縦書きの列か、横書きの複数行かを決める。
 * columns は x 軸、rows は y 軸への投影。どちらとも言えない(1行だけ、など)ときは null。
 */
export function decideMode(columns: Band[], rows: Band[]): ReadMode | null {
  if (columns.length === 0 || rows.length < 2) return null
  const inkWidth = columns.at(-1)!.end - columns[0].start
  const inkHeight = rows.at(-1)!.end - rows[0].start
  if (columns.length === 1) {
    // 縦に長ければ、1列に2字以上が縦に並ぶ縦書き。そうでなければ、字がつながって見える横書きの複数行
    // (「住宅 / 借入金」のような2段組。1行の大きな文字として読み違えやすい)
    if (inkWidth < MIN_GLYPH_PX) return null
    return inkHeight >= MIN_COLUMN_ASPECT * inkWidth ? 'vertical' : 'horizontal'
  }
  // 列も行も2つ以上: 少ないほうが「行(列)」、多いほうがその中の「字」
  if (rows.length < columns.length) return 'horizontal'
  if (columns.length < rows.length) return 'vertical'
  // 同数のときは、切れ目の広いほうが行(列)の区切り
  return mean(gaps(rows)) >= mean(gaps(columns)) ? 'horizontal' : 'vertical'
}

// 1字の高さの上限(列の幅に対する比)。これを超えるまでは、切れ目があっても同じ字とみなす
const MAX_GLYPH_ASPECT = 1.15

/**
 * 縦の列を1字ずつに分ける。インクの切れ目で分けたあと、列の幅くらいの高さになるまでつなぐ
 * (「二」「号」のように、字の中に切れ目がある字を割らないため)。
 * bands は列の中を y 軸へ投影したもの、columnWidth は列の幅。
 */
export function mergeIntoGlyphs(bands: Band[], columnWidth: number): Band[] {
  const glyphs: Band[] = []
  for (const band of bands) {
    const last = glyphs.at(-1)
    if (last && band.end - last.start <= MAX_GLYPH_ASPECT * columnWidth) last.end = band.end
    else glyphs.push({ ...band })
  }
  return glyphs
}

/** rect の中のインクの外接矩形。インクがなければ null */
export function inkBounds(mask: Uint8Array, width: number, rect: PixelRect): PixelRect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      if (!mask[y * width + x]) continue
      if (x < x0) x0 = x
      if (x + 1 > x1) x1 = x + 1
      if (y < y0) y0 = y
      if (y + 1 > y1) y1 = y + 1
    }
  }
  return x1 > x0 ? { x0, y0, x1, y1 } : null
}

/** 読み直す単位。縦書きの1列、または横書きの1行 */
export interface RereadItem {
  mode: ReadMode
  /** インクの外接矩形 */
  box: PixelRect
  /** 縦書きのとき、1字ずつの外接矩形(上から) */
  glyphs: PixelRect[]
}

/**
 * 枠の中のインクを、読み直す単位に分ける。縦書きは列ごと(2字以上の列だけ)、横書きは行ごと。
 * 1行だけの枠は、その1行を返す。分けられないときは空。
 */
export function splitCell(mask: Uint8Array, width: number, cell: PixelRect): RereadItem[] {
  const columns = projectBands(mask, width, cell, 'x', 2)
  const rows = projectBands(mask, width, cell, 'y', 2)
  // 1行だけの枠は、その行をそのまま読み直す(別の枠の文字と一緒に、大きな1行として読み違えた候補を直すため)
  const mode = rows.length === 1 ? 'horizontal' : decideMode(columns, rows)
  if (mode === 'horizontal') {
    return rows.flatMap((row) => {
      const box = inkBounds(mask, width, { x0: cell.x0, y0: row.start, x1: cell.x1, y1: row.end })
      return box && box.y1 - box.y0 >= MIN_GLYPH_PX ? [{ mode, box, glyphs: [] }] : []
    })
  }
  if (mode === 'vertical') {
    return columns.flatMap((column) => {
      const strip = { x0: column.start, y0: cell.y0, x1: column.end, y1: cell.y1 }
      const columnWidth = column.end - column.start
      if (columnWidth < MIN_GLYPH_PX) return []
      const glyphs = mergeIntoGlyphs(projectBands(mask, width, strip, 'y', 1), columnWidth)
        .map((glyph) => inkBounds(mask, width, { x0: column.start, y0: glyph.start, x1: column.end, y1: glyph.end }))
        .filter((glyph): glyph is PixelRect => glyph !== null)
      const box = inkBounds(mask, width, strip)
      return box && glyphs.length >= 2 ? [{ mode, box, glyphs }] : []
    })
  }
  return []
}
