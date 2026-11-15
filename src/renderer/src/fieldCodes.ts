// 項目コード(G01 等)の半自動割り当て。
// 様式では、印字コードは「コードだけが入った小さな枠」にあり、その右隣の枠が記入欄になっている。
// ここでは割り当ての計画を作るだけで、ドキュメントの変更は commands.ts のコマンドが行う。
import type { DocObject, Layer, ObjectRole, Page, PathObject, Rect } from '../../shared/model.ts'

/** 英大文字1字 + 数字2〜3桁(G01, K22, G101) */
export const FIELD_CODE_PATTERN = /^[A-Z]\d{2,3}$/

/**
 * 文字列が項目コードならその正規形を返す。OCR の読み違い(小文字、数字部分の O → 0、I / l → 1、前後の記号)は直す。
 * 項目コードでなければ null。
 */
export function normalizeFieldCode(text: string): string | null {
  // 罫線の切れ端を読んだ記号(「G21|」など)は前後から落とす
  const upper = text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toUpperCase()
  if (upper.length < 3 || upper.length > 4) return null
  const fixed = upper[0] + upper.slice(1).replace(/O/g, '0').replace(/[IL]/g, '1')
  return FIELD_CODE_PATTERN.test(fixed) ? fixed : null
}

interface Rule {
  /** 線の位置(横線なら y、縦線なら x) */
  at: number
  from: number
  to: number
  width: number
}

interface Rules {
  horizontal: Rule[]
  vertical: Rule[]
}

/** 線の端が少し届いていなくても枠として扱う許容量(pt) */
const REACH_TOLERANCE = 1
/** 右隣の枠を探すとき、枠の右辺からこれだけ右を調べる(pt) */
const NEIGHBOUR_PROBE = 2
/** コードの枠と記入欄の高さのずれの許容量(pt) */
const ROW_TOLERANCE = 1.5
/** 枠の中にあるとみなすための、辺からの最小の距離(pt) */
const INSIDE_MARGIN = 1

/** 枠になる罫線(実線の水平・垂直の線)を集める */
function collectRules(layers: Layer[]): Rules {
  const rules: Rules = { horizontal: [], vertical: [] }
  for (const layer of layers) {
    for (const object of layer.objects) {
      if (object.type !== 'path' || object.closed || object.dash || object.stroke === null) continue
      if (object.nodes.length !== 2) continue
      const [a, b, c, d, e, f] = object.transform
      const [p, q] = object.nodes.map((node) => ({ x: a * node.x + c * node.y + e, y: b * node.x + d * node.y + f }))
      if (p.y === q.y) {
        rules.horizontal.push({ at: p.y, from: Math.min(p.x, q.x), to: Math.max(p.x, q.x), width: object.strokeWidth })
      } else if (p.x === q.x) {
        rules.vertical.push({ at: p.x, from: Math.min(p.y, q.y), to: Math.max(p.y, q.y), width: object.strokeWidth })
      }
    }
  }
  return rules
}

interface Cell {
  /** 罫線の中心で測った枠 */
  rect: Rect
  /** 罫線の太さを除いた内側 */
  inner: Rect
}

/** 点 (x, y) から上下左右に最も近い罫線で囲まれた枠。どれかの方向に罫線がなければ null */
function findCell(rules: Rules, x: number, y: number): Cell | null {
  const nearest = (candidates: Rule[], along: number, across: number, side: -1 | 1): Rule | null => {
    let best: Rule | null = null
    for (const rule of candidates) {
      if (rule.from - REACH_TOLERANCE > along || rule.to + REACH_TOLERANCE < along) continue
      if ((rule.at - across) * side <= 0) continue
      if (!best || (rule.at - best.at) * side < 0) best = rule
    }
    return best
  }
  const left = nearest(rules.vertical, y, x, -1)
  const right = nearest(rules.vertical, y, x, 1)
  const bottom = nearest(rules.horizontal, x, y, -1)
  const top = nearest(rules.horizontal, x, y, 1)
  if (!left || !right || !bottom || !top) return null
  return {
    rect: [left.at, bottom.at, right.at, top.at],
    inner: [left.at + left.width / 2, bottom.at + bottom.width / 2, right.at - right.width / 2, top.at - top.width / 2]
  }
}

const centerOf = (rect: Rect): [number, number] => [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2]

/** bounds が枠の中に収まっているか(中心が辺から離れていて、全体がはみ出していない) */
function isInside(cell: Rect, bounds: Rect): boolean {
  const [x, y] = centerOf(bounds)
  return (
    x > cell[0] + INSIDE_MARGIN &&
    x < cell[2] - INSIDE_MARGIN &&
    y > cell[1] + INSIDE_MARGIN &&
    y < cell[3] - INSIDE_MARGIN &&
    bounds[0] >= cell[0] - INSIDE_MARGIN &&
    bounds[2] <= cell[2] + INSIDE_MARGIN &&
    bounds[1] >= cell[1] - INSIDE_MARGIN &&
    bounds[3] <= cell[3] + INSIDE_MARGIN
  )
}

export interface ObjectPatch {
  fieldCode?: string | null
  role?: ObjectRole
}

export interface FieldCodeSummary {
  /** 見つかった印字コードの数 */
  codes: number
  /** 新しく項目コードを付けたオブジェクトの数(作った記入欄は含めない) */
  tagged: number
  /** 新しく作った記入欄の数 */
  cells: number
}

export interface FieldCodePlan {
  patches: Map<string, ObjectPatch>
  /** レイヤーID → そのレイヤーに追加する記入欄 */
  additions: Map<string, PathObject[]>
  summary: FieldCodeSummary
}

/** 記入欄の範囲を表すオブジェクト。線も塗りもないので出力には描かれない */
export function inputCellObject(id: string, fieldCode: string, rect: Rect): PathObject {
  const [x0, y0, x1, y1] = rect.map((value) => Math.round(value * 1000) / 1000)
  return {
    id,
    type: 'path',
    role: 'inputCell',
    fieldCode,
    transform: [1, 0, 0, 1, 0, 0],
    z: 0,
    tags: [],
    meta: { generatedBy: 'field-code-assign' },
    nodes: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 }
    ],
    closed: true,
    fill: null,
    stroke: null,
    strokeWidth: 0,
    dash: null,
    lineCap: 'butt'
  }
}

/**
 * ページの項目コードの割り当てを計画する。
 * - 枠の中に単独で印字されたコードの Text に、fieldCode と role=fieldCode を付ける
 * - その右隣の枠を記入欄とみなし、中のオブジェクトに同じ fieldCode を付ける
 * - 記入欄の範囲を表すオブジェクトがなければ、コードの Text と同じレイヤーに作る
 * すでに fieldCode が付いているオブジェクトは変えない(人の修正を優先する)。
 */
export function planFieldCodes(
  page: Page,
  boundsOf: (object: DocObject) => Rect,
  newId: () => string = () => `obj-${crypto.randomUUID()}`
): FieldCodePlan {
  const layers = page.layers.filter((layer) => (layer.kind === 'candidates' || layer.kind === 'confirmed') && !layer.locked)
  const rules = collectRules(layers)
  const items = layers.flatMap((layer) =>
    layer.objects.map((object) => ({
      object,
      layerId: layer.id,
      bounds: boundsOf(object),
      code: object.type === 'text' ? normalizeFieldCode(object.text) : null
    }))
  )
  const plan: FieldCodePlan = { patches: new Map(), additions: new Map(), summary: { codes: 0, tagged: 0, cells: 0 } }
  const tag = (object: DocObject, patch: ObjectPatch): void => {
    plan.patches.set(object.id, patch)
    plan.summary.tagged++
  }

  for (const item of items) {
    if (!item.code) continue
    const [x, y] = centerOf(item.bounds)
    const cell = findCell(rules, x, y)
    if (!cell) continue
    // 枠の中に他の文字があれば、項目コードの印字ではなく文章の一部とみなす
    if (items.some((other) => other !== item && other.object.type === 'text' && isInside(cell.rect, other.bounds))) continue
    plan.summary.codes++
    const fieldCode = item.object.fieldCode ?? item.code
    if (item.object.fieldCode === null) tag(item.object, { fieldCode, role: 'fieldCode' })

    const input = findCell(rules, cell.rect[2] + NEIGHBOUR_PROBE, y)
    if (!input) continue
    if (Math.abs(input.rect[1] - cell.rect[1]) > ROW_TOLERANCE || Math.abs(input.rect[3] - cell.rect[3]) > ROW_TOLERANCE) continue
    const contents = items.filter((other) => other !== item && isInside(input.rect, other.bounds))
    // 右隣も印字コードの枠なら記入欄ではない
    if (contents.some((other) => other.code !== null)) continue
    for (const other of contents) {
      if (other.object.fieldCode === null && !plan.patches.has(other.object.id)) tag(other.object, { fieldCode })
    }
    if (!contents.some((other) => other.object.role === 'inputCell')) {
      const added = plan.additions.get(item.layerId) ?? []
      added.push(inputCellObject(newId(), fieldCode, input.inner))
      plan.additions.set(item.layerId, added)
      plan.summary.cells++
    }
  }
  return plan
}
