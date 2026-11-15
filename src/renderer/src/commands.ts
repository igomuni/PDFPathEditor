// ドキュメントを変更する操作はすべてここのコマンドを通す(Undo/Redo のため)。
import type {
  DocObject,
  DocumentModel,
  Layer,
  Matrix,
  Page,
  PathNode,
  PathObject,
  Rect,
  TextObject
} from '../../shared/model.ts'
import type { CorrectionPlan } from './corrections.ts'
import { planFieldCodes, type FieldCodeSummary, type ObjectPatch } from './fieldCodes.ts'
import type { Command } from './history.ts'

function updateLayer(document: DocumentModel, layerId: string, patch: Partial<Layer>): DocumentModel {
  return {
    ...document,
    pages: document.pages.map((page) =>
      page.layers.some((layer) => layer.id === layerId)
        ? { ...page, layers: page.layers.map((layer) => (layer.id === layerId ? { ...layer, ...patch } : layer)) }
        : page
    )
  }
}

export function setLayerOpacity(layer: Layer, opacity: number): Command {
  const before = layer.opacity
  return {
    label: `「${layer.name}」の不透明度`,
    mergeKey: `layer-opacity:${layer.id}`,
    apply: (document) => updateLayer(document, layer.id, { opacity }),
    revert: (document) => updateLayer(document, layer.id, { opacity: before })
  }
}

export function setLayerVisible(layer: Layer, visible: boolean): Command {
  const before = layer.visible
  return {
    label: `「${layer.name}」の表示切替`,
    apply: (document) => updateLayer(document, layer.id, { visible }),
    revert: (document) => updateLayer(document, layer.id, { visible: before })
  }
}

interface LayerChange {
  layerId: string
  before: DocObject[]
  after: DocObject[]
}

function applyChanges(document: DocumentModel, changes: LayerChange[], pick: 'before' | 'after'): DocumentModel {
  const objectsByLayer = new Map(changes.map((change) => [change.layerId, change[pick]]))
  return {
    ...document,
    pages: document.pages.map((page) =>
      page.layers.some((layer) => objectsByLayer.has(layer.id))
        ? {
            ...page,
            layers: page.layers.map((layer) => {
              const objects = objectsByLayer.get(layer.id)
              return objects ? { ...layer, objects } : layer
            })
          }
        : page
    )
  }
}

/**
 * レイヤーのオブジェクト配列を作り直すコマンドを作る。compute が null を返したレイヤーは変更しない。
 * 何も変わらなければ null を返す。
 */
function objectsCommand(
  label: string,
  document: DocumentModel,
  compute: (layer: Layer, page: Page) => DocObject[] | null,
  mergeKey?: string
): Command | null {
  const changes: LayerChange[] = []
  for (const page of document.pages) {
    for (const layer of page.layers) {
      const after = compute(layer, page)
      if (after && after !== layer.objects) changes.push({ layerId: layer.id, before: layer.objects, after })
    }
  }
  if (changes.length === 0) return null
  return {
    label,
    mergeKey,
    apply: (target) => applyChanges(target, changes, 'after'),
    revert: (target) => applyChanges(target, changes, 'before')
  }
}

/** ロックされていないレイヤーの、ids に含まれるオブジェクトだけを変換する */
function mapSelected(layer: Layer, ids: ReadonlySet<string>, fn: (object: DocObject) => DocObject): DocObject[] | null {
  if (layer.locked || !layer.objects.some((object) => ids.has(object.id))) return null
  return layer.objects.map((object) => (ids.has(object.id) ? fn(object) : object))
}

/**
 * レイヤーの中の、指定した種類のオブジェクトだけを入れ替える(候補の再抽出)。
 * 罫線を検出し直しても文字の候補は残る、という動きにする。
 */
export function replaceObjectsOfType(
  document: DocumentModel,
  layerId: string,
  type: DocObject['type'],
  objects: DocObject[],
  label: string
): Command | null {
  return objectsCommand(label, document, (layer) => {
    if (layer.id !== layerId) return null
    const kept = layer.objects.filter((object) => object.type !== type)
    const baseZ = kept.reduce((max, object) => Math.max(max, object.z), -1) + 1
    return [...kept, ...objects.map((object, i) => ({ ...object, z: baseZ + i }))]
  })
}

export type TextPatch = Partial<
  Pick<TextObject, 'text' | 'fontFamily' | 'fontWeight' | 'fontSize' | 'letterSpacing' | 'fill' | 'align' | 'outline'>
>

/** 選択した Text の属性を変える。同じ属性の連続した変更(入力中など)は1つの履歴にまとめる */
export function updateTexts(document: DocumentModel, ids: readonly string[], patch: TextPatch): Command | null {
  const idSet = new Set(ids)
  return objectsCommand(
    'テキストの変更',
    document,
    (layer) => mapSelected(layer, idSet, (object) => (object.type === 'text' ? { ...object, ...patch } : object)),
    `text:${Object.keys(patch).sort().join(',')}:${ids.join(',')}`
  )
}

// 計算誤差の端数を残さないよう 1/1000 pt に丸める
const round = (value: number): number => Math.round(value * 1000) / 1000

/** ページ上の移動量を、オブジェクトのローカル座標での移動量に直す */
function toLocalDelta(transform: Matrix, dx: number, dy: number): [number, number] {
  const [a, b, c, d] = transform
  const det = a * d - b * c
  if (det === 0) return [dx, dy]
  return [(d * dx - c * dy) / det, (a * dy - b * dx) / det]
}

function shiftNode(node: PathNode, dx: number, dy: number): PathNode {
  return {
    ...node,
    x: round(node.x + dx),
    y: round(node.y + dy),
    ...(node.in ? { in: [round(node.in[0] + dx), round(node.in[1] + dy)] as [number, number] } : {}),
    ...(node.out ? { out: [round(node.out[0] + dx), round(node.out[1] + dy)] as [number, number] } : {})
  }
}

function translateObject(object: DocObject, dx: number, dy: number): DocObject {
  // Path は頂点を動かす(変換行列は単位のまま保つ)。画像とテキストは変換行列の平行移動成分を動かす
  if (object.type !== 'path') {
    const [a, b, c, d, e, f] = object.transform
    return { ...object, transform: [a, b, c, d, round(e + dx), round(f + dy)] }
  }
  const [lx, ly] = toLocalDelta(object.transform, dx, dy)
  return { ...object, nodes: object.nodes.map((node) => shiftNode(node, lx, ly)) }
}

/** 選択したオブジェクトを (dx, dy) pt だけ平行移動する */
export function moveObjects(document: DocumentModel, ids: readonly string[], dx: number, dy: number): Command | null {
  const idSet = new Set(ids)
  return objectsCommand(
    'オブジェクトの移動',
    document,
    (layer) => mapSelected(layer, idSet, (object) => translateObject(object, dx, dy)),
    `move:${ids.join(',')}`
  )
}

/** 水平または垂直な2頂点の線か。'h' | 'v' を返し、それ以外は null */
export function lineAxis(path: PathObject): 'h' | 'v' | null {
  if (path.closed || path.nodes.length !== 2) return null
  const [p, q] = path.nodes
  if (p.in || p.out || q.in || q.out) return null
  if (p.y === q.y) return 'h'
  if (p.x === q.x) return 'v'
  return null
}

function moveNodeOf(path: PathObject, index: number, dx: number, dy: number): PathObject {
  const [lx, ly] = toLocalDelta(path.transform, dx, dy)
  const axis = lineAxis(path)
  if (!axis) {
    return { ...path, nodes: path.nodes.map((node, i) => (i === index ? shiftNode(node, lx, ly) : node)) }
  }
  // 水平・垂直を保つ: 線に沿う成分は端点だけ、直交する成分は線全体を動かす
  const along: [number, number] = axis === 'h' ? [lx, 0] : [0, ly]
  const across: [number, number] = axis === 'h' ? [0, ly] : [lx, 0]
  return {
    ...path,
    nodes: path.nodes.map((node, i) =>
      shiftNode(node, across[0] + (i === index ? along[0] : 0), across[1] + (i === index ? along[1] : 0))
    )
  }
}

/** Path の頂点を (dx, dy) pt だけ動かす。水平・垂直の線はその向きを保つ */
export function moveNode(
  document: DocumentModel,
  objectId: string,
  index: number,
  dx: number,
  dy: number
): Command | null {
  return objectsCommand(
    '頂点の移動',
    document,
    (layer) =>
      mapSelected(layer, new Set([objectId]), (object) =>
        object.type === 'path' && index >= 0 && index < object.nodes.length ? moveNodeOf(object, index, dx, dy) : object
      ),
    `move-node:${objectId}:${index}`
  )
}

export function deleteObjects(document: DocumentModel, ids: readonly string[]): Command | null {
  const idSet = new Set(ids)
  return objectsCommand('オブジェクトの削除', document, (layer) =>
    layer.locked || !layer.objects.some((object) => idSet.has(object.id))
      ? null
      : layer.objects.filter((object) => !idSet.has(object.id))
  )
}

/** 候補を確定レイヤーへ移す。ids を省略すると候補を全件確定する */
export function confirmCandidates(document: DocumentModel, ids?: readonly string[]): Command | null {
  const idSet = ids ? new Set(ids) : null
  const isTarget = (object: DocObject): boolean => !idSet || idSet.has(object.id)
  return objectsCommand(idSet ? '選択した候補の確定' : '候補の全件確定', document, (layer, page) => {
    const moved = page.layers
      .filter((other) => other.kind === 'candidates')
      .flatMap((other) => other.objects.filter(isTarget))
    if (moved.length === 0) return null
    if (layer.kind === 'candidates') return layer.objects.filter((object) => !isTarget(object))
    if (layer.kind !== 'confirmed') return null
    // 確定済みの手前に積む
    const baseZ = layer.objects.reduce((max, object) => Math.max(max, object.z), -1) + 1
    return [...layer.objects, ...moved.map((object, i) => ({ ...object, z: baseZ + i }))]
  })
}

/** 選択したオブジェクトの項目コードや役割を変える。入力中の連続した変更は1つの履歴にまとめる */
export function updateObjects(document: DocumentModel, ids: readonly string[], patch: ObjectPatch): Command | null {
  const idSet = new Set(ids)
  const changed = (object: DocObject): boolean =>
    (patch.fieldCode !== undefined && object.fieldCode !== patch.fieldCode) ||
    (patch.role !== undefined && object.role !== patch.role)
  return objectsCommand(
    patch.role !== undefined ? '役割の変更' : '項目コードの変更',
    document,
    (layer) => {
      if (layer.locked || !layer.objects.some((object) => idSet.has(object.id) && changed(object))) return null
      return layer.objects.map((object) => (idSet.has(object.id) && changed(object) ? { ...object, ...patch } : object))
    },
    `object:${Object.keys(patch).sort().join(',')}:${ids.join(',')}`
  )
}

/**
 * 印字された項目コードを見つけて、コードの Text と右隣の記入欄に項目コードを割り当てる(fieldCodes.ts)。
 * 変更がなければ command は null。
 */
export function assignFieldCodes(
  document: DocumentModel,
  boundsOf: (object: DocObject) => Rect,
  newId?: () => string
): { command: Command | null; summary: FieldCodeSummary } {
  const plans = new Map(document.pages.map((page) => [page.id, planFieldCodes(page, boundsOf, newId)]))
  const summary: FieldCodeSummary = { codes: 0, tagged: 0, cells: 0 }
  for (const plan of plans.values()) {
    summary.codes += plan.summary.codes
    summary.tagged += plan.summary.tagged
    summary.cells += plan.summary.cells
  }
  const command = objectsCommand('項目コードの割り当て', document, (layer, page) => {
    const plan = plans.get(page.id)!
    const added = plan.additions.get(layer.id) ?? []
    if (added.length === 0 && !layer.objects.some((object) => plan.patches.has(object.id))) return null
    const baseZ = layer.objects.reduce((max, object) => Math.max(max, object.z), -1) + 1
    return [
      ...layer.objects.map((object) => {
        const patch = plan.patches.get(object.id)
        return patch ? { ...object, ...patch } : object
      }),
      ...added.map((object, i) => ({ ...object, z: baseZ + i }))
    ]
  })
  return { command, summary }
}

/**
 * 修正ファイルの計画(corrections.ts)を適用する。置換・追加・削除を1つの履歴にまとめる。
 * 追加は対象ページの候補レイヤーの手前に積む。変更がなければ null。
 */
export function applyCorrections(document: DocumentModel, plan: CorrectionPlan): Command | null {
  return objectsCommand('修正の取り込み', document, (layer, page) => {
    if (page.id !== plan.pageId || layer.locked) return null
    const additions = layer.kind === 'candidates' ? plan.additions : []
    const affected = layer.objects.some((object) => plan.replacements.has(object.id) || plan.deletions.has(object.id))
    if (!affected && additions.length === 0) return null
    const kept = layer.objects
      .filter((object) => !plan.deletions.has(object.id))
      .map((object) => plan.replacements.get(object.id) ?? object)
    const baseZ = kept.reduce((max, object) => Math.max(max, object.z), -1) + 1
    return [...kept, ...additions.map((object, i) => ({ ...object, z: baseZ + i }))]
  })
}
