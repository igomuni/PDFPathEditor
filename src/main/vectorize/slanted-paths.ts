// 見つけた斜線と角丸の角(画素)を Path の候補にする(design.md §3-59)。どちらも罫線(role=frame)として持つ。
import type { Matrix } from '../../shared/model.ts'
import type { PathDraft } from '../../shared/vectorizer.ts'
import type { SlantedShapes } from './diagonals.ts'

const round = (value: number): number => Math.round(value * 1000) / 1000
const MIN_WIDTH = 0.2
// 4分の1の円弧をベジェ曲線で表すときの、制御点までの距離(半径に対する比)
const KAPPA = 0.5523

export function slantedToDrafts(shapes: SlantedShapes, pixelToPdf: Matrix): PathDraft[] {
  const [a, b, c, d, e, f] = pixelToPdf
  const toPdf = (x: number, y: number): { x: number; y: number } => ({ x: round(a * x + c * y + e), y: round(b * x + d * y + f) })
  const pxToPt = Math.sqrt(Math.abs(a * d - b * c))
  const base = {
    type: 'path' as const,
    role: 'frame' as const,
    fieldCode: null,
    transform: [1, 0, 0, 1, 0, 0] as Matrix,
    tags: [],
    closed: false,
    fill: null,
    stroke: '#000000',
    dash: null,
    lineCap: 'butt' as const
  }
  const diagonals = shapes.diagonals.map(
    (line): PathDraft => ({
      ...base,
      meta: { source: 'diagonal-detect' },
      nodes: [toPdf(line.x0, line.y0), toPdf(line.x1, line.y1)],
      strokeWidth: Math.max(MIN_WIDTH, round(line.thickness * pxToPt))
    })
  )
  const arcs = shapes.arcs.map((arc): PathDraft => {
    // 水平の罫線の側から、垂直の罫線の側へ。制御点は、それぞれの接線の向き(角へ向かう向き)に置く
    const from = toPdf(arc.hEnd.x, arc.hEnd.y)
    const to = toPdf(arc.vEnd.x, arc.vEnd.y)
    const out = toPdf(arc.hEnd.x + (arc.vEnd.x - arc.hEnd.x) * KAPPA, arc.hEnd.y)
    const inn = toPdf(arc.vEnd.x, arc.vEnd.y + (arc.hEnd.y - arc.vEnd.y) * KAPPA)
    return {
      ...base,
      meta: { source: 'corner-detect' },
      nodes: [
        { ...from, out: [out.x, out.y] },
        { ...to, in: [inn.x, inn.y] }
      ],
      strokeWidth: Math.max(MIN_WIDTH, round(arc.thickness * pxToPt))
    }
  })
  return [...diagonals, ...arcs]
}
