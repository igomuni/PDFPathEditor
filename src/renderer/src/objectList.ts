// オブジェクト一覧(左サイドバー)の中身を作る。画面に依存しない部分をここに置く。
import type { DocObject, Layer, ObjectRole, Page, PathObject, Rect } from '../../shared/model.ts'

/** 表示されているか。visible を持たない古いデータは表示として扱う */
export const isVisible = (object: DocObject): boolean => object.visible !== false

export type ObjectKind = DocObject['type']

/** 2頂点の水平・垂直な線か(commands.ts の lineAxis と同じ判定) */
function axisOf(path: PathObject): 'h' | 'v' | null {
  if (path.closed || path.nodes.length !== 2) return null
  const [p, q] = path.nodes
  if (p.in || p.out || q.in || q.out) return null
  return p.y === q.y ? 'h' : p.x === q.x ? 'v' : null
}

/** 一覧に出す内容。Text は文字列、Path は形、Image はファイル名 */
export function describeObject(object: DocObject): string {
  if (object.type === 'text') return object.text
  if (object.type === 'image') return object.asset.split('/').pop() ?? object.asset
  if (object.role === 'inputCell') return '記入欄'
  const axis = axisOf(object)
  const shape = axis === 'h' ? '横線' : axis === 'v' ? '縦線' : object.closed ? '閉じた Path' : 'Path'
  return object.dash ? `${shape}(点線)` : shape
}

export interface ObjectFilter {
  /** 表示する種別 */
  types: ReadonlySet<ObjectKind>
  role: ObjectRole | 'all'
  /** 項目コードの有無 */
  code: 'all' | 'with' | 'without'
  /** 内容・項目コードに含まれる文字列(大文字小文字は区別しない) */
  query: string
}

export const ALL_KINDS: readonly ObjectKind[] = ['path', 'text', 'image']
export const NO_FILTER: ObjectFilter = { types: new Set(ALL_KINDS), role: 'all', code: 'all', query: '' }

export function isFiltering(filter: ObjectFilter): boolean {
  return filter.types.size < ALL_KINDS.length || filter.role !== 'all' || filter.code !== 'all' || filter.query.trim() !== ''
}

export function matchesFilter(object: DocObject, filter: ObjectFilter): boolean {
  if (!filter.types.has(object.type)) return false
  if (filter.role !== 'all' && object.role !== filter.role) return false
  if (filter.code === 'with' && object.fieldCode === null) return false
  if (filter.code === 'without' && object.fieldCode !== null) return false
  const query = filter.query.trim().toLowerCase()
  if (query === '') return true
  return describeObject(object).toLowerCase().includes(query) || (object.fieldCode ?? '').toLowerCase().includes(query)
}

export type ListRow =
  | { kind: 'layer'; layer: Layer; total: number; shown: number; collapsed: boolean }
  | { kind: 'object'; layer: Layer; object: DocObject }

/**
 * 一覧の行を作る。Inkscape と同じく手前のものを上に並べる(レイヤーは手前から、オブジェクトは z の大きい順)。
 * 絞り込みに合わないオブジェクトと、折りたたんだレイヤーの中身は出さない。
 */
export function buildRows(page: Page, filter: ObjectFilter, collapsed: ReadonlySet<string>): ListRow[] {
  const rows: ListRow[] = []
  for (const layer of [...page.layers].reverse()) {
    // 差分オーバーレイは中身を持たない表示用のレイヤーなので出さない
    if (layer.kind === 'diff') continue
    const objects = layer.objects.filter((object) => matchesFilter(object, filter)).sort((a, b) => b.z - a.z)
    const isCollapsed = collapsed.has(layer.id)
    rows.push({ kind: 'layer', layer, total: layer.objects.length, shown: objects.length, collapsed: isCollapsed })
    if (!isCollapsed) for (const object of objects) rows.push({ kind: 'object', layer, object })
  }
  return rows
}

/** 絞り込みに合う、ロックされていないレイヤーのオブジェクトのID(まとめて表示/非表示にする対象) */
export function filteredIds(page: Page, filter: ObjectFilter): string[] {
  return page.layers
    .filter((layer) => !layer.locked && layer.kind !== 'diff')
    .flatMap((layer) => layer.objects.filter((object) => matchesFilter(object, filter)).map((object) => object.id))
}

export interface ViewLike {
  x: number
  y: number
  scale: number
}

/**
 * rect(SVG座標 [x0, y0, x1, y1])が画面に収まっていなければ、中央に来るよう表示位置を動かす。
 * 収まっていれば view をそのまま返す。拡大率は変えない。
 */
export function revealRect<V extends ViewLike>(view: V, viewport: { width: number; height: number }, rect: Rect, marginPx = 24): V {
  const width = viewport.width / view.scale
  const height = viewport.height / view.scale
  const margin = marginPx / view.scale
  const inside =
    rect[0] >= view.x + margin && rect[2] <= view.x + width - margin && rect[1] >= view.y + margin && rect[3] <= view.y + height - margin
  if (inside) return view
  return { ...view, x: (rect[0] + rect[2]) / 2 - width / 2, y: (rect[1] + rect[3]) / 2 - height / 2 }
}

/** 仮想スクロール: 表示する行の範囲 [start, end)。前後に overscan 行ぶん余分に描く */
export function visibleRange(scrollTop: number, viewportHeight: number, rowHeight: number, count: number, overscan = 8): [number, number] {
  const start = Math.min(count, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan))
  const end = Math.min(count, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan)
  return [start, Math.max(start, end)]
}
