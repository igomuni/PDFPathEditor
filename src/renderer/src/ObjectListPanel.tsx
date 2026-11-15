import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DocObject, ObjectRole, Page } from '../../shared/model'
import { setLayerVisible, setObjectsVisible } from './commands'
import {
  ALL_KINDS,
  buildRows,
  describeObject,
  filteredIds,
  isFiltering,
  isVisible,
  NO_FILTER,
  visibleRange,
  type ObjectFilter,
  type ObjectKind
} from './objectList'
import { ROLE_LABELS } from './TagPanel'
import { store, type Selection } from './store'

const ROW_HEIGHT = 22
const KIND_LABELS: Record<ObjectKind, { short: string; name: string }> = {
  path: { short: 'P', name: 'Path' },
  text: { short: 'T', name: 'Text' },
  image: { short: 'I', name: 'Image' }
}

interface Props {
  page: Page
  selection: Selection
  /** オブジェクトの位置までキャンバスを動かす */
  onReveal(object: DocObject): void
}

/** レイヤーとオブジェクトの一覧。表示/非表示の切り替え、絞り込み、選択ができる */
export function ObjectList({ page, selection, onReveal }: Props) {
  const [filter, setFilter] = useState<ObjectFilter>(NO_FILTER)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 一覧で選んだ直後は、選択に合わせたスクロールをしない(押した行が動かないように)
  const selectedHere = useRef(false)

  const rows = useMemo(() => buildRows(page, filter, collapsed), [page, filter, collapsed])
  const selected = useMemo(() => new Set(selection.ids), [selection.ids])
  const filtering = isFiltering(filter)
  const targets = useMemo(() => filteredIds(page, filter), [page, filter])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setHeight(el.clientHeight))
    observer.observe(el)
    setHeight(el.clientHeight)
    return () => observer.disconnect()
  }, [])

  // キャンバスで選択したら、その行が見えるところまでスクロールする
  useEffect(() => {
    if (selectedHere.current) {
      selectedHere.current = false
      return
    }
    const el = scrollRef.current
    const first = selection.ids[0]
    if (!el || !first) return
    const index = rows.findIndex((row) => row.kind === 'object' && row.object.id === first)
    if (index < 0) return
    const top = index * ROW_HEIGHT
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2)
    }
    // rows は選択のたびに作り直さないので、依存には入れない(絞り込みを変えたときに勝手に動かさない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.ids])

  const execute = (build: (document: NonNullable<ReturnType<typeof store.getState>['document']>) => Parameters<typeof store.execute>[0]): void => {
    const document = store.getState().document
    if (document) store.execute(build(document))
  }

  const setVisible = (ids: readonly string[], visible: boolean): void => {
    execute((document) => setObjectsVisible(document, ids, visible))
    // 非表示にしたものは選択から外す
    if (!visible) {
      const hidden = new Set(ids)
      const current = store.getState().selection
      if (current.ids.some((id) => hidden.has(id))) store.select(current.ids.filter((id) => !hidden.has(id)))
    }
  }

  const selectObject = (object: DocObject, layerLocked: boolean, layerVisible: boolean, additive: boolean): void => {
    // 非表示・ロック中のものは選択できない(キャンバスと同じ)
    if (layerLocked || !layerVisible || !isVisible(object)) return
    selectedHere.current = true
    const current = store.getState().selection.ids
    if (!additive) store.select([object.id])
    else if (current.includes(object.id)) store.select(current.filter((id) => id !== object.id))
    else store.select([...current, object.id])
    onReveal(object)
  }

  const toggleKind = (kind: ObjectKind): void => {
    const types = new Set(filter.types)
    if (types.has(kind)) types.delete(kind)
    else types.add(kind)
    setFilter({ ...filter, types })
  }

  const [start, end] = visibleRange(scrollTop, height, ROW_HEIGHT, rows.length)

  return (
    <section className="object-list">
      <h2>オブジェクト</h2>
      <div className="filters">
        <div className="kinds">
          {ALL_KINDS.map((kind) => (
            <button
              key={kind}
              className={filter.types.has(kind) ? 'chip active' : 'chip'}
              onClick={(e) => {
                toggleKind(kind)
                e.currentTarget.blur()
              }}
              title={`${KIND_LABELS[kind].name} を一覧に出す`}
            >
              {KIND_LABELS[kind].name}
            </button>
          ))}
        </div>
        <select
          value={filter.role}
          onChange={(e) => {
            setFilter({ ...filter, role: e.target.value as ObjectFilter['role'] })
            e.currentTarget.blur()
          }}
          title="役割で絞り込む"
        >
          <option value="all">役割: すべて</option>
          {(Object.keys(ROLE_LABELS) as ObjectRole[]).map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
        <select
          value={filter.code}
          onChange={(e) => {
            setFilter({ ...filter, code: e.target.value as ObjectFilter['code'] })
            e.currentTarget.blur()
          }}
          title="項目コードの有無で絞り込む"
        >
          <option value="all">項目コード: すべて</option>
          <option value="with">項目コードあり</option>
          <option value="without">項目コードなし</option>
        </select>
        <input
          type="text"
          value={filter.query}
          placeholder="文字列・項目コードで検索"
          onChange={(e) => setFilter({ ...filter, query: e.target.value })}
          spellCheck={false}
        />
        <div className="bulk">
          <span className="hint">{filtering ? `絞り込み ${targets.length} 件` : `全 ${targets.length} 件`}</span>
          <button onClick={() => setVisible(targets, true)} disabled={targets.length === 0} title="一覧に出ているオブジェクトをまとめて表示する">
            表示
          </button>
          <button onClick={() => setVisible(targets, false)} disabled={targets.length === 0} title="一覧に出ているオブジェクトをまとめて非表示にする">
            非表示
          </button>
          {filtering && (
            <button onClick={() => setFilter(NO_FILTER)} title="絞り込みを解除する">
              解除
            </button>
          )}
        </div>
      </div>
      <div className="rows" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {rows.slice(start, end).map((row, i) => {
            const top = (start + i) * ROW_HEIGHT
            if (row.kind === 'layer') {
              const { layer } = row
              return (
                <div key={layer.id} className="row layer-row" style={{ top, height: ROW_HEIGHT }} data-layer-id={layer.id}>
                  <button
                    className="eye"
                    onClick={() => execute(() => setLayerVisible(layer, !layer.visible))}
                    title={layer.visible ? 'レイヤーを非表示にする' : 'レイヤーを表示する'}
                    aria-pressed={layer.visible}
                  >
                    {layer.visible ? '●' : '○'}
                  </button>
                  <button
                    className="twisty"
                    onClick={() => {
                      const next = new Set(collapsed)
                      if (next.has(layer.id)) next.delete(layer.id)
                      else next.add(layer.id)
                      setCollapsed(next)
                    }}
                    title={row.collapsed ? '開く' : '折りたたむ'}
                  >
                    {row.collapsed ? '▸' : '▾'}
                  </button>
                  <span className="content">{layer.name}</span>
                  {layer.locked && <span className="badge" title="ロック中(編集できません)">ロック</span>}
                  <span className="count">{row.shown === row.total ? row.total : `${row.shown}/${row.total}`}</span>
                </div>
              )
            }
            const { object, layer } = row
            const visible = isVisible(object)
            const className = ['row', 'object-row', selected.has(object.id) ? 'selected' : '', visible && layer.visible ? '' : 'hidden']
              .filter(Boolean)
              .join(' ')
            return (
              <div
                key={object.id}
                className={className}
                style={{ top, height: ROW_HEIGHT }}
                data-object-row={object.id}
                onMouseDown={(e) => {
                  if ((e.target as Element).closest('button')) return
                  selectObject(object, layer.locked, layer.visible, e.shiftKey)
                }}
              >
                <button
                  className="eye"
                  onClick={() => setVisible([object.id], !visible)}
                  disabled={layer.locked}
                  title={layer.locked ? 'ロック中のレイヤーです(レイヤーの表示切替を使ってください)' : visible ? '非表示にする' : '表示する'}
                  aria-pressed={visible}
                >
                  {visible ? '●' : '○'}
                </button>
                <span className={`kind kind-${object.type}`} title={KIND_LABELS[object.type].name}>
                  {KIND_LABELS[object.type].short}
                </span>
                <span className="content" title={describeObject(object)}>
                  {describeObject(object)}
                </span>
                {object.fieldCode !== null && <span className="badge code">{object.fieldCode}</span>}
                <span className="role">{ROLE_LABELS[object.role]}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
