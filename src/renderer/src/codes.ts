// 項目コードの一覧(design.md §3-53)。
import type { DocObject, Page } from '../../shared/model.ts'

export interface CodeEntry {
  code: string
  ids: string[]
  /** 項目コードの印字(role=fieldCode)があるか */
  printed: boolean
  /** 記入欄(role=inputCell)があるか */
  cell: boolean
}

/** 印字と記入欄がそろっているか */
export const isComplete = (entry: CodeEntry): boolean => entry.printed && entry.cell

/** 編集できるレイヤーのオブジェクトを項目コードごとにまとめる(コード順) */
export function collectCodes(page: Page): CodeEntry[] {
  const entries = new Map<string, CodeEntry>()
  for (const layer of page.layers) {
    if (layer.locked) continue
    for (const object of layer.objects) {
      if (object.fieldCode === null) continue
      let entry = entries.get(object.fieldCode)
      if (!entry) entries.set(object.fieldCode, (entry = { code: object.fieldCode, ids: [], printed: false, cell: false }))
      entry.ids.push(object.id)
      if (object.role === 'fieldCode') entry.printed = true
      if (object.role === 'inputCell') entry.cell = true
    }
  }
  return [...entries.values()].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
}

/** 項目コードの付与の対象(Text と記入欄)。罫線は隣の項目と共有するので対象にしない */
export const isTaggable = (object: DocObject): boolean => object.type === 'text' || object.role === 'inputCell'

/** 項目コードが付いていない Text と記入欄(編集できるレイヤーの、表示しているもの) */
export function untaggedObjects(page: Page): DocObject[] {
  return page.layers
    .filter((layer) => layer.visible && !layer.locked)
    .flatMap((layer) => layer.objects)
    .filter((object) => object.visible !== false && object.fieldCode === null && isTaggable(object))
}
