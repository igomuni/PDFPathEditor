import { useMemo } from 'react'
import type { Page } from '../../shared/model'
import { collectShapes, SHAPE_KINDS, SHAPE_LABELS, type ShapeKind } from '../../shared/shapes'
import { objectBounds } from './coords'
import { store, type Selection } from './store'

interface Props {
  page: Page
  selection: Selection
  /** 図形を、表示している範囲の中央に追加する */
  onAdd(kind: ShapeKind): void
  /** 選択したオブジェクトが画面の外にあれば、見える位置へ動かす */
  onReveal(ids: readonly string[]): void
}

const ICONS: Record<ShapeKind, string> = { roundRect: '▢', arrow: '→', brace: '｛', circle: '○', star: '★' }

/**
 * 図形(角丸の枠、矢印、波括弧、丸、星)の一覧と追加。
 * 図形は Path / Text のままで、同じ印(meta.shape)を持つものを1つの図形としてまとめて扱う。
 */
export function ShapePanel({ page, selection, onAdd, onReveal }: Props) {
  const shapes = useMemo(() => collectShapes(page, objectBounds), [page])
  const selected = useMemo(() => new Set(selection.ids), [selection.ids])
  return (
    <section className="shape-list">
      <div className="filters">
        <div className="kinds" title="図形を、表示している範囲の中央に追加する">
          {SHAPE_KINDS.map((kind) => (
            <button
              key={kind}
              className="chip active"
              onClick={(e) => {
                onAdd(kind)
                e.currentTarget.blur()
              }}
              title={`${SHAPE_LABELS[kind]}を追加`}
              data-add-shape={kind}
            >
              {ICONS[kind]}
            </button>
          ))}
        </div>
        <p className="hint">上のボタンで図形を追加。行を押すと、その図形の部品をまとめて選択します。</p>
      </div>
      {shapes.length === 0 ? (
        <p className="hint empty-note">図形はまだありません。矢印と角丸の枠は「罫線を検出」、星と波括弧と丸数字の丸は「文字を検出」で見つかります。</p>
      ) : (
        <ul>
          {SHAPE_KINDS.map((kind) => {
            const group = shapes.filter((shape) => shape.kind === kind)
            if (group.length === 0) return null
            return (
              <li key={kind}>
                <div className="kind-header">
                  <span className="icon">{ICONS[kind]}</span>
                  <span className="label">{SHAPE_LABELS[kind]}</span>
                  <button
                    onClick={(e) => {
                      const ids = group.flatMap((shape) => shape.ids)
                      store.select(ids)
                      onReveal(ids)
                      e.currentTarget.blur()
                    }}
                    title="この種類の図形をすべて選択する"
                  >
                    {group.length} 個
                  </button>
                </div>
                <ul>
                  {group.map((shape, index) => (
                    <li key={shape.group}>
                      <button
                        className={shape.ids.some((id) => selected.has(id)) ? 'active' : undefined}
                        onClick={(e) => {
                          store.select(shape.ids)
                          onReveal(shape.ids)
                          // フォーカスが残るとキャンバスのキー操作(矢印など)がボタンに取られる
                          e.currentTarget.blur()
                        }}
                      >
                        <span className="label">
                          {SHAPE_LABELS[kind]} {index + 1}
                          {shape.detail && kind !== 'star' ? `「${shape.detail}」` : ''}
                        </span>
                        <span className="count">{shape.ids.length > 1 ? `部品 ${shape.ids.length}` : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
