import type { DocObject, ObjectRole } from '../../shared/model'
import { updateObjects } from './commands'
import type { ObjectPatch } from './fieldCodes'
import { store } from './store'

export const ROLE_LABELS: Record<ObjectRole, string> = {
  background: '背景',
  frame: '枠・罫線',
  label: 'ラベル',
  inputCell: '記入欄',
  fieldCode: '項目コードの印字',
  qr: 'QRコード',
  formId: '様式ID',
  other: 'その他'
}

/** 選択中の全オブジェクトで同じ値ならその値、違えば undefined */
function common<T>(values: T[]): T | undefined {
  return values.every((value) => value === values[0]) ? values[0] : undefined
}

/** 選択したオブジェクトの項目コードと役割を編集する */
export function TagSection({ objects, codes }: { objects: DocObject[]; codes: string[] }) {
  const ids = objects.map((object) => object.id)
  const apply = (patch: ObjectPatch): void => {
    const document = store.getState().document
    if (document) store.execute(updateObjects(document, ids, patch))
  }
  const fieldCode = common(objects.map((object) => object.fieldCode))
  const role = common(objects.map((object) => object.role))

  return (
    <section>
      <h2>項目コード{objects.length > 1 ? `(${objects.length} 件)` : ''}</h2>
      <label>
        <span>コード</span>
        <input
          type="text"
          list="field-codes"
          value={fieldCode ?? ''}
          placeholder={fieldCode === undefined ? '混在' : '未付与'}
          onChange={(e) => apply({ fieldCode: e.target.value.trim() || null })}
          onBlur={() => store.sealHistory()}
          spellCheck={false}
        />
        <button onClick={() => apply({ fieldCode: null })} disabled={fieldCode === null} title="項目コードを外す">
          解除
        </button>
      </label>
      <datalist id="field-codes">
        {codes.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>
      <label>
        <span>役割</span>
        <select value={role ?? ''} onChange={(e) => apply({ role: e.target.value as ObjectRole })}>
          {role === undefined && <option value="">混在</option>}
          {(Object.keys(ROLE_LABELS) as ObjectRole[])
            .filter((value) => value !== 'background' || role === 'background')
            .map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
        </select>
      </label>
    </section>
  )
}
