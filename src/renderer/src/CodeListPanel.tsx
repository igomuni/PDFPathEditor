import { useEffect, useMemo, useRef, useState } from 'react'
import type { Page } from '../../shared/model'
import { isComplete, untaggedObjects, type CodeEntry } from './codes'
import { store } from './store'

interface Props {
  page: Page
  entries: CodeEntry[]
  /** 選択中のオブジェクトが持つ項目コード */
  activeCodes: ReadonlySet<string>
  untaggedMode: boolean
  /** 選択したオブジェクトが画面の外にあれば、見える位置へ動かす */
  onReveal(ids: readonly string[]): void
}

/**
 * 項目コードの一覧。行を押すと、そのコードのオブジェクト(印字・記入欄・ラベル)をまとめて選択し、表示位置を合わせる。
 * 印字か記入欄が欠けているコードと、まだコードが付いていない Text・記入欄を確かめられる。
 */
export function CodeListPanel({ page, entries, activeCodes, untaggedMode, onReveal }: Props) {
  const [onlyIncomplete, setOnlyIncomplete] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const incomplete = useMemo(() => entries.filter((entry) => !isComplete(entry)), [entries])
  const untagged = useMemo(() => untaggedObjects(page), [page])
  const untaggedTexts = untagged.filter((object) => object.type === 'text').length
  const shown = onlyIncomplete ? incomplete : entries

  // キャンバスで選択したら、そのコードの行が見えるところまで動かす
  const firstActive = entries.find((entry) => activeCodes.has(entry.code))?.code
  useEffect(() => {
    if (firstActive) listRef.current?.querySelector('button.active')?.scrollIntoView({ block: 'nearest' })
  }, [firstActive])

  const pick = (ids: readonly string[], target: HTMLElement): void => {
    store.select(ids)
    onReveal(ids)
    // フォーカスが残るとキャンバスのキー操作(矢印など)がボタンに取られる
    target.blur()
  }

  return (
    <section className="code-list">
      <div className="filters">
        <div className="kinds">
          <button className={`chip${onlyIncomplete ? '' : ' active'}`} onClick={() => setOnlyIncomplete(false)}>
            すべて {entries.length}
          </button>
          <button
            className={`chip${onlyIncomplete ? ' active' : ''}`}
            onClick={() => setOnlyIncomplete(true)}
            title="印字か記入欄が見つかっていないコードだけを出す"
          >
            ▲ 不足あり {incomplete.length}
          </button>
        </div>
        <div className="bulk">
          <span className="hint" title="項目コードが付いていない Text と記入欄">
            未付与: Text {untaggedTexts} / 記入欄 {untagged.length - untaggedTexts}
          </span>
          <button onClick={(e) => pick(untagged.map((object) => object.id), e.currentTarget)} disabled={untagged.length === 0} title="項目コードが付いていない Text と記入欄をすべて選択する">
            選択
          </button>
          <label title="項目コードが付いていない Text と記入欄をキャンバスで強調する (⇧⌘G)">
            <input
              type="checkbox"
              checked={untaggedMode}
              onChange={(e) => {
                store.setUntaggedMode(e.target.checked)
                e.currentTarget.blur()
              }}
            />
            強調
          </label>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="hint empty-note">
          まだありません。罫線と文字を検出してから「項目コードを割り当て」を実行するか、オブジェクトを選んで右のパネルの「コード」に入力してください。
        </p>
      ) : (
        <>
          <div className="code-header">
            <span className="code">コード</span>
            <span className="flag">印字</span>
            <span className="flag">記入欄</span>
            <span className="count">件数</span>
          </div>
          <ul ref={listRef}>
            {shown.map((entry) => (
              <li key={entry.code}>
                <button
                  className={activeCodes.has(entry.code) ? 'active' : undefined}
                  onClick={(e) => pick(entry.ids, e.currentTarget)}
                  title={`${entry.printed ? '印字あり' : '印字なし'} / ${entry.cell ? '記入欄あり' : '記入欄なし'}`}
                >
                  <span className="code">{entry.code}</span>
                  <span className={`flag${entry.printed ? '' : ' missing'}`}>{entry.printed ? '○' : '▲'}</span>
                  <span className={`flag${entry.cell ? '' : ' missing'}`}>{entry.cell ? '○' : '▲'}</span>
                  <span className="count">{entry.ids.length}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
