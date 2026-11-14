import type { DocObject, DocumentModel, Layer } from '../../shared/model'
import type { Command } from './history'

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

/** レイヤーの中身を丸ごと入れ替える(候補の再抽出など) */
export function setLayerObjects(layer: Layer, objects: DocObject[], label: string): Command {
  const before = layer.objects
  return {
    label,
    apply: (document) => updateLayer(document, layer.id, { objects }),
    revert: (document) => updateLayer(document, layer.id, { objects: before })
  }
}
