// 見つけた斜線と角丸の角(画素)を Path の候補にする(design.md §3-59)。どちらも罫線(role=frame)として持つ。
import type { Matrix } from '../../shared/model.ts'
import { BRACE_SOURCE, type PathDraft } from '../../shared/vectorizer.ts'
import type { Brace } from './braces.ts'
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

/**
 * 角丸の枠に図形の印を付ける。角の円弧(corner-detect)と、その端につながる罫線を同じグループにする。
 * 罫線を介してつながる円弧どうしは、同じ枠とみなす。lines と slanted の順は変えない。
 */
export function tagRoundRects(lines: readonly PathDraft[], slanted: readonly PathDraft[]): { lines: PathDraft[]; slanted: PathDraft[] } {
  const arcs = slanted.map((draft, index) => ({ draft, index })).filter(({ draft }) => draft.meta.source === 'corner-detect')
  if (arcs.length === 0) return { lines: [...lines], slanted: [...slanted] }
  // 円弧ごとに、端につながる罫線を探す。罫線は円弧の始まりを少し拾っていることがあるので、線に沿った向きには半径ぶんの余裕を見る
  const touching = arcs.map(({ draft }) => {
    const [from, to] = draft.nodes
    const r = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))
    const reach = r * 0.6 + 2
    return lines.flatMap((line, index) => {
      if (line.closed || line.nodes.length !== 2 || line.dash) return []
      const [p, q] = line.nodes
      const horizontal = Math.abs(p.y - q.y) < 0.01
      const vertical = Math.abs(p.x - q.x) < 0.01
      const meets = (end: { x: number; y: number }): boolean =>
        horizontal
          ? Math.abs(p.y - end.y) <= 0.6 && Math.min(Math.abs(p.x - end.x), Math.abs(q.x - end.x)) <= reach
          : vertical
            ? Math.abs(p.x - end.x) <= 0.6 && Math.min(Math.abs(p.y - end.y), Math.abs(q.y - end.y)) <= reach
            : false
      return (horizontal && meets(from)) || (vertical && meets(to)) ? [index] : []
    })
  })
  // 罫線を共有する円弧をまとめる
  const parent = arcs.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < arcs.length; i++) {
    for (let j = i + 1; j < arcs.length; j++) {
      if (touching[i].some((line) => touching[j].includes(line))) parent[find(i)] = find(j)
    }
  }
  const tag = (i: number): { kind: 'roundRect'; group: string } => ({ kind: 'roundRect', group: `roundrect-${find(i)}` })
  const taggedLines = [...lines]
  const taggedSlanted = [...slanted]
  arcs.forEach(({ draft, index }, i) => {
    taggedSlanted[index] = { ...draft, meta: { ...draft.meta, shape: tag(i) } }
    for (const line of touching[i]) taggedLines[line] = { ...taggedLines[line], meta: { ...taggedLines[line].meta, shape: tag(i) } }
  })
  return { lines: taggedLines, slanted: taggedSlanted }
}

/**
 * 波括弧を1本の折れ線の Path にする: かぎの先 → 上の角 → 中央 → 突起の先 → 中央 → 下の角 → かぎの先。
 * 図形の印(brace)を付ける。
 */
export function bracesToDrafts(braces: readonly Brace[], pixelToPdf: Matrix): PathDraft[] {
  const [a, b, c, d, e, f] = pixelToPdf
  const toPdf = (x: number, y: number): { x: number; y: number } => ({ x: round(a * x + c * y + e), y: round(b * x + d * y + f) })
  const pxToPt = Math.sqrt(Math.abs(a * d - b * c))
  return braces.map(
    (brace, index): PathDraft => ({
      type: 'path',
      role: 'other',
      fieldCode: null,
      transform: [1, 0, 0, 1, 0, 0],
      tags: [],
      meta: { source: BRACE_SOURCE, shape: { kind: 'brace', group: `brace-${index}` } },
      nodes: [
        toPdf(brace.hookX, brace.top),
        toPdf(brace.x, brace.top),
        toPdf(brace.x, brace.tipY),
        toPdf(brace.tipX, brace.tipY),
        toPdf(brace.x, brace.tipY),
        toPdf(brace.x, brace.bottom),
        toPdf(brace.hookX, brace.bottom)
      ],
      closed: false,
      fill: null,
      stroke: '#000000',
      strokeWidth: Math.max(MIN_WIDTH, round(brace.thickness * pxToPt)),
      dash: null,
      lineCap: 'butt'
    })
  )
}
