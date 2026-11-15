import { useMemo } from 'react'
import type { DocObject, ObjectRole, Page } from '../../shared/model'
import { updateObjects } from './commands'
import type { ObjectPatch } from './fieldCodes'
import { store } from './store'

const ROLE_LABELS: Record<ObjectRole, string> = {
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

export interface CodeEntry {
  code: string
  ids: string[]
  /** 項目コードの印字(role=fieldCode)があるか */
  printed: boolean
  /** 記入欄(role=inputCell)があるか */
  cell: boolean
}

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

/** 付与済みの項目コードの一覧。行を押すと、そのコードのオブジェクトをまとめて選択する */
export function CodeList({ entries, activeCodes }: { entries: CodeEntry[]; activeCodes: ReadonlySet<string> }) {
  const incomplete = useMemo(() => entries.filter((entry) => !entry.printed || !entry.cell).length, [entries])
  return (
    <section className="code-list">
      <h2>項目コード一覧({entries.length})</h2>
      {entries.length === 0 ? (
        <p className="hint">
          まだありません。罫線と文字を検出してから「項目コードを割り当て」を実行するか、オブジェクトを選んで上の欄に入力してください。
        </p>
      ) : (
        <>
          {incomplete > 0 && <p className="hint">▲ は印字か記入欄が見つかっていないコード({incomplete} 件)</p>}
          <ul>
            {entries.map((entry) => (
              <li key={entry.code}>
                <button
                  className={activeCodes.has(entry.code) ? 'active' : undefined}
                  onClick={(e) => {
                    store.select(entry.ids)
                    // フォーカスが残るとキャンバスのキー操作(矢印など)がボタンに取られる
                    e.currentTarget.blur()
                  }}
                  title={`${entry.printed ? '印字あり' : '印字なし'} / ${entry.cell ? '記入欄あり' : '記入欄なし'}`}
                >
                  <span className="code">{entry.code}</span>
                  <span className="count">{entry.ids.length} 件</span>
                  <span className="mark">{entry.printed && entry.cell ? '' : '▲'}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
