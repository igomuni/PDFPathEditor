import type { Matrix, PathNode } from '../../shared/model'
import type { PathDraft, Vectorizer, VectorizerInput } from '../../shared/vectorizer'
import { detectLines, type DetectedLine } from './line-detector'

// JSON が読みやすいよう 1/1000 pt に丸める(約 0.35µm)
const round = (value: number): number => Math.round(value * 1000) / 1000

function toHex(gray: number): string {
  const channel = Math.min(255, Math.max(0, gray)).toString(16).padStart(2, '0')
  return `#${channel}${channel}${channel}`
}

function lineToPath(line: DetectedLine, m: Matrix): PathDraft {
  const point = (x: number, y: number): PathNode => ({
    x: round(m[0] * x + m[2] * y + m[4]),
    y: round(m[1] * x + m[3] * y + m[5])
  })
  const horizontal = line.orientation === 'h'
  // 線に沿う方向と、直交する方向の 1px あたりの pt
  const xScale = Math.hypot(m[0], m[1])
  const yScale = Math.hypot(m[2], m[3])
  const alongScale = horizontal ? xScale : yScale
  const acrossScale = horizontal ? yScale : xScale
  return {
    type: 'path',
    role: 'frame',
    fieldCode: null,
    transform: [1, 0, 0, 1, 0, 0],
    tags: [],
    meta: { vectorizer: 'line-detector', orientation: line.orientation },
    nodes: horizontal
      ? [point(line.start, line.center), point(line.end, line.center)]
      : [point(line.center, line.start), point(line.center, line.end)],
    closed: false,
    fill: null,
    stroke: toHex(line.gray),
    strokeWidth: round(line.thickness * acrossScale),
    dash: line.dash ? line.dash.map((length) => round(length * alongScale)) : null,
    lineCap: 'butt'
  }
}

/** 罫線・枠用。水平・垂直の線分だけを検出する(文字や曲線は対象外) */
export const lineDetectorVectorizer: Vectorizer = {
  id: 'line-detector',
  label: '罫線検出(水平・垂直の線分)',
  vectorize({ raster, pixelToPdf }: VectorizerInput): PathDraft[] {
    return detectLines(raster).map((line) => lineToPath(line, pixelToPdf))
  }
}
