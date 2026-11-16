// 見つけた矢印(画素)を Path の候補にする(design.md §3-55)。
// 先端は塗りつぶした三角形の Path、軸は折れ線の Path。どちらも role=other、meta.source=ARROW_SOURCE。
import type { Matrix } from '../../shared/model.ts'
import { ARROW_SOURCE, type PathDraft } from '../../shared/vectorizer.ts'
import type { Arrow, ArrowPoint } from './arrows.ts'

const round = (value: number): number => Math.round(value * 1000) / 1000
// 軸の線幅の下限(pt)。細すぎると出力で見えなくなる
const MIN_SHAFT_WIDTH = 0.2

export function arrowsToDrafts(arrows: readonly Arrow[], pixelToPdf: Matrix): PathDraft[] {
  const [a, b, c, d, e, f] = pixelToPdf
  const toPdf = (p: ArrowPoint): { x: number; y: number } => ({ x: round(a * p.x + c * p.y + e), y: round(b * p.x + d * p.y + f) })
  const pxToPt = Math.sqrt(Math.abs(a * d - b * c))
  const base = { type: 'path' as const, role: 'other' as const, fieldCode: null, transform: [1, 0, 0, 1, 0, 0] as Matrix, tags: [], dash: null }
  return arrows.flatMap((arrow, index): PathDraft[] => [
    {
      ...base,
      meta: { source: ARROW_SOURCE, part: 'shaft', arrow: index, shape: { kind: 'arrow', group: `arrow-${index}` } },
      nodes: arrow.shaft.map(toPdf),
      closed: false,
      fill: null,
      stroke: '#000000',
      strokeWidth: Math.max(MIN_SHAFT_WIDTH, round(arrow.shaftWidth * pxToPt)),
      lineCap: 'butt'
    },
    {
      ...base,
      meta: { source: ARROW_SOURCE, part: 'head', arrow: index, shape: { kind: 'arrow', group: `arrow-${index}` } },
      nodes: arrow.head.map(toPdf),
      closed: true,
      fill: '#000000',
      stroke: null,
      strokeWidth: 0,
      lineCap: 'butt'
    }
  ])
}

function distanceToSegment(p: { x: number; y: number }, s: { x: number; y: number }, t: { x: number; y: number }): number {
  const dx = t.x - s.x
  const dy = t.y - s.y
  const length2 = dx * dx + dy * dy
  const u = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / length2))
  return Math.hypot(p.x - (s.x + u * dx), p.y - (s.y + u * dy))
}

/**
 * 罫線として検出された線のうち、矢印の軸と重なるものを外す(同じ線が二重にならないように)。
 * 線の両端が、同じ矢印の軸から tolerance(pt)以内にあれば重なりとみなす。
 */
export function dropLinesOnArrows(lines: readonly PathDraft[], arrowDrafts: readonly PathDraft[], tolerance = 1.2): PathDraft[] {
  const shafts = arrowDrafts.filter((draft) => !draft.closed)
  const onShaft = (p: { x: number; y: number }, shaft: PathDraft): boolean =>
    shaft.nodes.slice(1).some((node, i) => distanceToSegment(p, shaft.nodes[i], node) <= tolerance)
  return lines.filter(
    (line) => line.closed || line.nodes.length !== 2 || !shafts.some((shaft) => onShaft(line.nodes[0], shaft) && onShaft(line.nodes[1], shaft))
  )
}
