// 二次利用向けの JSON 出力。確定オブジェクトの一覧と、項目コードごとの索引を持つ。
import type { DocObject, DocumentModel, Rect } from '../../shared/model.ts'
import { exportBounds, exportedObjects, type LayoutText } from './layout.ts'

export const EXPORT_JSON_VERSION = 1

type Attributes<T> = Omit<T, 'z' | 'meta' | 'visible'>

export type ExportedObject = Attributes<DocObject> & {
  /** ページ上の外接矩形 [x0, y0, x1, y1] */
  bounds: Rect
}

export interface ExportedField {
  /** 記入欄(role=inputCell)の範囲 */
  inputCells: { id: string; bounds: Rect }[]
  /** 印字された項目コード(role=fieldCode) */
  printedCodes: { id: string; text: string | null; bounds: Rect }[]
  /** この項目コードを持つ全オブジェクトのID */
  objectIds: string[]
}

export interface ExportJson {
  version: typeof EXPORT_JSON_VERSION
  /** 座標の約束 */
  coordinateSystem: { unit: 'pt'; origin: 'bottom-left'; yAxis: 'up' }
  source: { fileName: string; sha256: string }
  pages: {
    /** 元PDFでのページ番号(1始まり) */
    pageNumber: number
    mediaBox: Rect
    objects: ExportedObject[]
    /** 項目コード → その項目のオブジェクト */
    fields: Record<string, ExportedField>
  }[]
}

export function buildExportJson(document: DocumentModel, layout: LayoutText): ExportJson {
  return {
    version: EXPORT_JSON_VERSION,
    coordinateSystem: { unit: 'pt', origin: 'bottom-left', yAxis: 'up' },
    source: { fileName: document.source.originalFileName, sha256: document.source.sha256 },
    pages: document.pages.map((page) => {
      const fields = new Map<string, ExportedField>()
      const objects = exportedObjects(page).map((object): ExportedObject => {
        const bounds = exportBounds(object, layout)
        if (object.fieldCode !== null) {
          let field = fields.get(object.fieldCode)
          if (!field) fields.set(object.fieldCode, (field = { inputCells: [], printedCodes: [], objectIds: [] }))
          field.objectIds.push(object.id)
          if (object.role === 'inputCell') field.inputCells.push({ id: object.id, bounds })
          if (object.role === 'fieldCode') {
            field.printedCodes.push({ id: object.id, text: object.type === 'text' ? object.text : null, bounds })
          }
        }
        // z は並び順で表し、作業用の meta と画面の表示状態は出さない
        const { z: _z, meta: _meta, visible: _visible, ...attributes } = object
        return { ...attributes, bounds }
      })
      const sorted = [...fields.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))
      return {
        pageNumber: page.sourcePageNumber,
        mediaBox: page.mediaBox,
        objects,
        fields: Object.fromEntries(sorted)
      }
    })
  }
}
