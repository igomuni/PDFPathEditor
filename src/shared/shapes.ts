// 図形(オートシェイプ的なもの)の扱い(design.md §3-60)。
// オブジェクトの種類は Path / Text のままで、meta.shape に「図形の種類」と「グループ」の印を付ける。
// 同じグループの印を持つオブジェクトが、1つの図形(角丸の枠なら罫線4本と角の円弧4つ)になる。
import type { DocObject, Page, PathNode, PathObject, TextObject } from './model.ts'

export type ShapeKind = 'roundRect' | 'star' | 'brace' | 'arrow' | 'circle'

export interface ShapeTag {
  kind: ShapeKind
  /** 同じ図形を作るオブジェクトに共通の番号 */
  group: string
}

export const SHAPE_KINDS: readonly ShapeKind[] = ['roundRect', 'arrow', 'brace', 'circle', 'star']

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  roundRect: '角丸の枠',
  arrow: '矢印',
  brace: '波括弧',
  circle: '丸',
  star: '星'
}

/** オブジェクトに付いている図形の印。なければ null */
export function shapeOf(object: Pick<DocObject, 'meta'>): ShapeTag | null {
  const tag = object.meta.shape as Partial<ShapeTag> | undefined
  if (!tag || typeof tag !== 'object' || typeof tag.group !== 'string' || !SHAPE_KINDS.includes(tag.kind as ShapeKind)) return null
  return { kind: tag.kind as ShapeKind, group: tag.group }
}

export interface ShapeEntry {
  kind: ShapeKind
  group: string
  ids: string[]
  /** 一覧に出す説明(星や丸の中の文字など) */
  detail: string
}

/** 編集できるレイヤーの図形を、種類ごと・グループごとにまとめる。boundsOf で上から・左からの順に並べる */
export function collectShapes(page: Page, boundsOf: (object: DocObject) => readonly [number, number, number, number]): ShapeEntry[] {
  const groups = new Map<string, ShapeEntry & { top: number; left: number }>()
  for (const layer of page.layers) {
    if (layer.locked) continue
    for (const object of layer.objects) {
      const tag = shapeOf(object)
      if (!tag) continue
      const [x0, , , y1] = boundsOf(object)
      const key = `${tag.kind}:${tag.group}`
      let entry = groups.get(key)
      if (!entry) groups.set(key, (entry = { kind: tag.kind, group: tag.group, ids: [], detail: '', top: y1, left: x0 }))
      entry.ids.push(object.id)
      entry.top = Math.max(entry.top, y1)
      entry.left = Math.min(entry.left, x0)
      if (object.type === 'text' && entry.detail === '') entry.detail = object.text
    }
  }
  return [...groups.values()]
    .sort((a, b) => SHAPE_KINDS.indexOf(a.kind) - SHAPE_KINDS.indexOf(b.kind) || b.top - a.top || a.left - b.left)
    .map(({ top: _top, left: _left, ...entry }) => entry)
}

// 4分の1の円弧をベジェ曲線で表すときの、制御点までの距離(半径に対する比)
const KAPPA = 0.5523
const round = (value: number): number => Math.round(value * 1000) / 1000

function pathBase(tag: ShapeTag, id: string): Omit<PathObject, 'nodes' | 'closed' | 'fill' | 'stroke' | 'strokeWidth'> {
  return {
    id,
    type: 'path',
    role: 'other',
    fieldCode: null,
    transform: [1, 0, 0, 1, 0, 0],
    z: 0,
    tags: [],
    meta: { source: 'manual', shape: tag },
    dash: null,
    lineCap: 'butt'
  }
}

const node = (x: number, y: number, handles: { in?: [number, number]; out?: [number, number] } = {}): PathNode => ({
  x: round(x),
  y: round(y),
  ...(handles.in ? { in: [round(handles.in[0]), round(handles.in[1])] as [number, number] } : {}),
  ...(handles.out ? { out: [round(handles.out[0]), round(handles.out[1])] as [number, number] } : {})
})

export interface ShapeOptions {
  /** 中心(PDF座標) */
  cx: number
  cy: number
  /** 大きさの目安(pt)。ページの文字の大きさから決める */
  size: number
  newId: () => string
  /** 星の Text に使うフォント */
  fontFamily: string
  fontWeight: number
}

/** 角丸の四角(1本の閉じた Path)。左下 (x, y)、幅 w、高さ h、角の半径 r */
export function roundRectNodes(x: number, y: number, w: number, h: number, r: number): PathNode[] {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  const k = radius * KAPPA
  const [x0, y0, x1, y1] = [x, y, x + w, y + h]
  return [
    node(x0 + radius, y1, { in: [x0 + radius - k, y1] }),
    node(x1 - radius, y1, { out: [x1 - radius + k, y1] }),
    node(x1, y1 - radius, { in: [x1, y1 - radius + k] }),
    node(x1, y0 + radius, { out: [x1, y0 + radius - k] }),
    node(x1 - radius, y0, { in: [x1 - radius + k, y0] }),
    node(x0 + radius, y0, { out: [x0 + radius - k, y0] }),
    node(x0, y0 + radius, { in: [x0, y0 + radius - k] }),
    node(x0, y1 - radius, { out: [x0, y1 - radius + k] })
  ]
}

/**
 * 波括弧(開いた Path)。上端 (x, top) から下端 (x, bottom) まで。depth は中央のとがりが出る向きと長さ
 * (負なら左へとがる「｛」、正なら右へとがる「｝」)。
 */
export function braceNodes(x: number, top: number, bottom: number, depth: number): PathNode[] {
  const mid = (top + bottom) / 2
  const quarter = (top - bottom) / 4
  // 端は depth の半分だけ反対側に開き、中央で depth の半分だけとがる
  const open = x - depth / 2
  const tip = x + depth / 2
  return [
    node(open, top, { out: [x, top] }),
    node(x, top - quarter * 0.9, { in: [x, top - quarter * 0.3], out: [x, mid + quarter * 0.5] }),
    node(tip, mid, { in: [x, mid + quarter * 0.1], out: [x, mid - quarter * 0.1] }),
    node(x, bottom + quarter * 0.9, { in: [x, mid - quarter * 0.5], out: [x, bottom + quarter * 0.3] }),
    node(open, bottom, { in: [x, bottom] })
  ]
}

/** 円(閉じた Path、4頂点) */
export function circleNodes(cx: number, cy: number, r: number): PathNode[] {
  const k = r * KAPPA
  return [
    node(cx + r, cy, { in: [cx + r, cy - k], out: [cx + r, cy + k] }),
    node(cx, cy + r, { in: [cx + k, cy + r], out: [cx - k, cy + r] }),
    node(cx - r, cy, { in: [cx - r, cy + k], out: [cx - r, cy - k] }),
    node(cx, cy - r, { in: [cx - k, cy - r], out: [cx + k, cy - r] })
  ]
}

/** 手で追加する図形を作る。図形ごとに新しいグループの印を付ける */
export function createShape(kind: ShapeKind, options: ShapeOptions): DocObject[] {
  const { cx, cy, size, newId } = options
  const tag: ShapeTag = { kind, group: `${kind}-${newId()}` }
  const stroke = { fill: null, stroke: '#000000', strokeWidth: 0.5 }
  switch (kind) {
    case 'roundRect':
      return [{ ...pathBase(tag, newId()), nodes: roundRectNodes(cx - size * 4, cy - size * 1.5, size * 8, size * 3, size * 0.6), closed: true, ...stroke }]
    case 'brace':
      return [{ ...pathBase(tag, newId()), nodes: braceNodes(cx, cy + size * 2, cy - size * 2, -size * 0.6), closed: false, ...stroke }]
    case 'circle':
      return [{ ...pathBase(tag, newId()), nodes: circleNodes(cx, cy, size * 0.6), closed: true, ...stroke }]
    case 'arrow': {
      // 右向き: 軸と、先端の塗りつぶした三角形
      const head = size * 0.8
      const tip = cx + size * 3
      return [
        { ...pathBase(tag, newId()), meta: { source: 'manual', shape: tag, part: 'shaft' }, nodes: [node(cx - size * 3, cy), node(tip - head, cy)], closed: false, ...stroke },
        {
          ...pathBase(tag, newId()),
          meta: { source: 'manual', shape: tag, part: 'head' },
          nodes: [node(tip - head, cy + head / 2), node(tip - head, cy - head / 2), node(tip, cy)],
          closed: true,
          fill: '#000000',
          stroke: null,
          strokeWidth: 0
        }
      ]
    }
    case 'star': {
      const text: TextObject = {
        id: newId(),
        type: 'text',
        role: 'other',
        fieldCode: null,
        transform: [1, 0, 0, 1, round(cx - size), round(cy - size * 0.7)],
        z: 0,
        tags: [],
        meta: { source: 'manual', shape: tag },
        text: '★',
        fontFamily: options.fontFamily,
        fontWeight: options.fontWeight,
        fontSize: round(size * 2),
        letterSpacing: 0,
        fill: '#000000',
        align: 'left',
        outline: false
      }
      return [text]
    }
  }
}
