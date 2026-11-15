import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DocObject, ImageObject, Layer, Page, PathObject, Rect, TextObject } from '../../shared/model'
import { confirmCandidates, deleteObjects, moveNode, moveObjects } from './commands'
import {
  applyMatrix,
  centerPage,
  CSS_PX_PER_PT,
  fitPage,
  matrixToSvg,
  objectBounds,
  pageSize,
  panBy,
  pathData,
  pdfToSvg,
  pdfToSvgMatrix,
  rectsIntersect,
  svgToPdf,
  viewportToSvg,
  zoomAt,
  type Point,
  type View
} from './coords'
import { isVisible, revealRect } from './objectList'
import { store, type Selection } from './store'
import { isVertical, verticalChars } from '../../shared/vertical'
import { cssFontFamily, textLocalBox } from './textMetrics'

export interface CanvasHandle {
  zoomIn(): void
  zoomOut(): void
  zoomFit(): void
  zoom100(): void
  /** rect(PDF座標)が画面の外にあれば、中央に来るよう表示位置を動かす */
  reveal(rect: Rect): void
  /** 表示している範囲の中心(PDF座標)。まだ表示していなければ null */
  viewCenter(): Point | null
}

export interface CanvasStatus {
  /** 100% = 96px/inch 相当 */
  zoomPercent: number
  /** カーソル位置(PDF座標、pt)。キャンバス外は null */
  cursorPdf: Point | null
}

interface Props {
  page: Page
  selection: Selection
  /** 背景を赤、Path をシアンで乗算合成する(一致=黒、背景のみ=赤、Pathのみ=シアン) */
  diffMode: boolean
  /** 項目コードが付いていないテキストと記入欄を強調する */
  untaggedMode: boolean
  /** 選択中のオブジェクトが持つ項目コード。同じコードのオブジェクトを強調する */
  activeCodes: ReadonlySet<string>
  /** 矢印キー1回の移動量(pt)。背景ラスターの1画素 */
  nudgeStep: number
  onStatus(status: CanvasStatus): void
}

const ZOOM_STEP = Math.SQRT2
const WHEEL_ZOOM_SENSITIVITY = 0.01
// ラスターの1画素がこの CSS px 以上になったら補間せず画素をそのまま見せる
const PIXELATE_THRESHOLD = 3
// 候補レイヤーは背景と見分けられるよう、モデルの色ではなく固定の色で描く(表示だけの上書き)
const CANDIDATE_COLOR = '#e6007e'
const DIFF_BACKGROUND_COLOR = '#ff0000'
const DIFF_PATH_COLOR = '#00ffff'
const SELECTION_COLOR = '#1e7bff'
// 線も塗りもないオブジェクト(記入欄の範囲)を画面で見せるための色
const GUIDE_COLOR = '#0a9d58'
// 細い線でもクリックできるようにする当たり判定の最小幅(CSS px)
const HIT_WIDTH_PX = 8
const NODE_SIZE_PX = 8
// これ未満のドラッグはクリックとみなす(CSS px)
const CLICK_SLOP_PX = 3

const ARROW_DIRECTIONS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  // PDF座標は y が上向き
  ArrowUp: [0, 1],
  ArrowDown: [0, -1]
}

/** assets の画像を読み込んで Blob URL にする */
function useAssetUrl(asset: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let revoked = false
    let objectUrl: string | null = null
    void window.api.readAsset(asset).then((bytes) => {
      if (revoked) return
      objectUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
      setUrl(objectUrl)
    })
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setUrl(null)
    }
  }, [asset])
  return url
}

function ImageView({ object, scale }: { object: ImageObject; scale: number }) {
  const url = useAssetUrl(object.asset)
  if (!url) return null
  const pxPerImagePixel = (Math.abs(object.transform[0]) / object.pixelWidth) * scale
  return (
    <g transform={matrixToSvg(object.transform)} data-object-id={object.id}>
      {/* 単位正方形(y上向き)に、上下を戻して画像を置く */}
      <image
        href={url}
        x={0}
        y={0}
        width={1}
        height={1}
        preserveAspectRatio="none"
        transform="matrix(1 0 0 -1 0 1)"
        style={{ imageRendering: pxPerImagePixel >= PIXELATE_THRESHOLD ? 'pixelated' : 'auto' }}
      />
    </g>
  )
}

function PathView({
  object,
  color,
  scale,
  diffMode
}: {
  object: PathObject
  color: string | null
  scale: number
  diffMode: boolean
}) {
  const d = pathData(object.nodes, object.closed)
  // 線も塗りもない Path(記入欄の範囲)は出力に描かれない。画面では細い破線で示し、差分表示では出さない
  const invisible = object.fill === null && object.stroke === null
  return (
    <g transform={matrixToSvg(object.transform)} data-object-id={object.id}>
      {invisible ? (
        !diffMode && <path className="guide-outline" d={d} stroke={GUIDE_COLOR} />
      ) : (
        <path
          d={d}
          fill={object.fill === null ? 'none' : (color ?? object.fill)}
          stroke={object.stroke === null ? 'none' : (color ?? object.stroke)}
          strokeWidth={object.strokeWidth}
          strokeDasharray={object.dash?.join(' ')}
          strokeLinecap={object.lineCap}
        />
      )}
      {/* 当たり判定用の見えない太い線 */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.max(object.strokeWidth, HIT_WIDTH_PX / scale)}
        pointerEvents="stroke"
      />
    </g>
  )
}

function TextView({ object, color }: { object: TextObject; color: string | null }) {
  if (isVertical(object)) {
    // 縦書き: 1字ずつ中央揃えで下へ積む。括弧や長音は、フォントの縦書き用の字形(vert)に切り替える
    const [x0, y0, x1, y1] = textLocalBox(object)
    return (
      <g transform={matrixToSvg(object.transform)} data-object-id={object.id}>
        <text
          transform="scale(1 -1)"
          fontFamily={cssFontFamily(object.fontFamily)}
          fontWeight={object.fontWeight}
          fontSize={object.fontSize}
          textAnchor="middle"
          fill={color ?? object.fill}
          pointerEvents="none"
          style={{ whiteSpace: 'pre', fontFeatureSettings: '"vert"' }}
        >
          {verticalChars(object).map((item, i) => (
            <tspan key={i} x={0} y={item.baseline}>
              {item.char}
            </tspan>
          ))}
        </text>
        {/* 字の線ではなく外形全体をクリックできるようにする */}
        <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="transparent" stroke="none" />
      </g>
    )
  }
  return (
    <g transform={matrixToSvg(object.transform)} data-object-id={object.id}>
      {/* ローカル座標は y 上向きなので、文字が裏返らないよう上下を戻す */}
      <text
        transform="scale(1 -1)"
        x={0}
        y={0}
        fontFamily={cssFontFamily(object.fontFamily)}
        fontWeight={object.fontWeight}
        fontSize={object.fontSize}
        letterSpacing={object.letterSpacing}
        textAnchor={object.align === 'left' ? 'start' : object.align === 'center' ? 'middle' : 'end'}
        fill={color ?? object.fill}
        // 字の線ではなく外形全体をクリックできるようにする
        pointerEvents="bounding-box"
        style={{ whiteSpace: 'pre' }}
      >
        {object.text}
      </text>
    </g>
  )
}

function LayerView({ layer, scale, diffMode }: { layer: Layer; scale: number; diffMode: boolean }) {
  const pathColor = diffMode ? DIFF_PATH_COLOR : layer.kind === 'candidates' ? CANDIDATE_COLOR : null
  const isBackground = layer.kind === 'background'
  return (
    <g
      opacity={diffMode ? 1 : layer.opacity}
      pointerEvents={layer.locked ? 'none' : undefined}
      style={diffMode && !isBackground ? { mixBlendMode: 'multiply' } : undefined}
      data-layer-kind={layer.kind}
    >
      {layer.objects
        .filter(isVisible)
        .sort((a, b) => a.z - b.z)
        .map((object) =>
          object.type === 'path' ? (
            <PathView key={object.id} object={object} color={pathColor} scale={scale} diffMode={diffMode} />
          ) : object.type === 'text' ? (
            <TextView key={object.id} object={object} color={pathColor} />
          ) : (
            <ImageView key={object.id} object={object} scale={scale} />
          )
        )}
    </g>
  )
}

/** オブジェクトの外形を半透明の矩形で塗って強調する(同じ項目コード、未付与) */
function HighlightOverlay({ objects, className, scale }: { objects: DocObject[]; className: string; scale: number }) {
  // 細い線でも見えるよう、画面上で少し広げる
  const pad = 2 / scale
  return (
    <g pointerEvents="none">
      {objects.map((object) => {
        const [x0, y0, x1, y1] = objectBounds(object)
        return (
          <rect key={object.id} className={className} x={x0 - pad} y={y0 - pad} width={x1 - x0 + pad * 2} height={y1 - y0 + pad * 2} />
        )
      })}
    </g>
  )
}

/** 選択中のオブジェクトの輪郭と頂点ハンドル。大きさは画面上で一定にする */
function SelectionOverlay({ objects, selection, scale }: { objects: DocObject[]; selection: Selection; scale: number }) {
  const half = NODE_SIZE_PX / scale / 2
  return (
    <g>
      {objects.map((object) => {
        if (object.type === 'text') {
          // 外形の枠と、基準点(ベースライン上)の印
          const [x0, y0, x1, y1] = textLocalBox(object)
          return (
            <g key={object.id} transform={matrixToSvg(object.transform)}>
              <rect className="selection-outline" x={x0} y={y0} width={x1 - x0} height={y1 - y0} stroke={SELECTION_COLOR} />
              {isVertical(object) ? (
                // 縦書きの基準線は、文字の中央を通る縦の線
                <line className="selection-outline" x1={0} y1={y0} x2={0} y2={y1} stroke={SELECTION_COLOR} strokeDasharray="2 2" />
              ) : (
                <line className="selection-outline" x1={x0} y1={0} x2={x1} y2={0} stroke={SELECTION_COLOR} strokeDasharray="2 2" />
              )}
            </g>
          )
        }
        if (object.type !== 'path') return null
        return (
          <g key={object.id}>
            <path
              className="selection-outline"
              d={pathData(object.nodes, object.closed)}
              transform={matrixToSvg(object.transform)}
              stroke={SELECTION_COLOR}
            />
            {object.nodes.map((node, index) => {
              const p = applyMatrix(object.transform, node)
              const active = selection.node?.objectId === object.id && selection.node.index === index
              return (
                <rect
                  key={index}
                  className="node-handle"
                  x={p.x - half}
                  y={p.y - half}
                  width={half * 2}
                  height={half * 2}
                  fill={active ? SELECTION_COLOR : '#ffffff'}
                  stroke={SELECTION_COLOR}
                  data-node-object-id={object.id}
                  data-node-index={index}
                />
              )
            })}
          </g>
        )
      })}
    </g>
  )
}

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(
  { page, selection, diffMode, untaggedMode, activeCodes, nudgeStep, onStatus },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const [cursorPdf, setCursorPdf] = useState<Point | null>(null)
  /** 範囲選択の矩形(ビューポート上のCSS px) */
  const [marquee, setMarquee] = useState<{ from: Point; to: Point } | null>(null)
  const fittedPageId = useRef<string | null>(null)
  const drag = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)

  // 選択・編集できるのは、表示中でロックされていないレイヤーのオブジェクトだけ
  const editableObjects = useMemo(
    () =>
      page.layers
        .filter((layer) => layer.visible && !layer.locked)
        .flatMap((layer) => layer.objects)
        .filter(isVisible),
    [page.layers]
  )
  const selectedObjects = useMemo(() => {
    const ids = new Set(selection.ids)
    return editableObjects.filter((object) => ids.has(object.id))
  }, [editableObjects, selection.ids])

  // 選択と同じ項目コードを持つ、選択していないオブジェクト
  const relatedObjects = useMemo(() => {
    if (activeCodes.size === 0) return []
    const ids = new Set(selection.ids)
    return editableObjects.filter(
      (object) => object.fieldCode !== null && activeCodes.has(object.fieldCode) && !ids.has(object.id)
    )
  }, [editableObjects, activeCodes, selection.ids])
  // 罫線は隣の項目と共有するので、未付与の強調はテキストと記入欄だけにする
  const untaggedObjects = useMemo(
    () =>
      untaggedMode
        ? editableObjects.filter(
            (object) => object.fieldCode === null && (object.type === 'text' || object.role === 'inputCell')
          )
        : [],
    [editableObjects, untaggedMode]
  )

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  // ページを開いた直後は全体表示にする
  useLayoutEffect(() => {
    if (!size || size.width === 0 || size.height === 0) return
    if (fittedPageId.current === page.id) return
    fittedPageId.current = page.id
    setView(fitPage(page.mediaBox, size))
  }, [page.id, page.mediaBox, size])

  const center = (): Point => ({ x: (size?.width ?? 0) / 2, y: (size?.height ?? 0) / 2 })

  useImperativeHandle(ref, () => ({
    zoomIn: () => setView((v) => v && zoomAt(v, center(), v.scale * ZOOM_STEP)),
    zoomOut: () => setView((v) => v && zoomAt(v, center(), v.scale / ZOOM_STEP)),
    zoomFit: () => size && setView(fitPage(page.mediaBox, size)),
    zoom100: () => size && setView(centerPage(page.mediaBox, size, CSS_PX_PER_PT)),
    viewCenter: () => (view && size ? toPdf(view, { x: size.width / 2, y: size.height / 2 }) : null),
    reveal: (rect) => {
      if (!size) return
      const [x0, y0, x1, y1] = rect
      const a = pdfToSvg(page.mediaBox, { x: x0, y: y1 })
      const b = pdfToSvg(page.mediaBox, { x: x1, y: y0 })
      setView((v) => v && revealRect(v, size, [a.x, a.y, b.x, b.y]))
    }
  }))

  // wheel は preventDefault が要るので passive: false で直接登録する
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/⌘+ホイール、トラックパッドのピンチ(ctrlKey 付きで届く)
        const factor = Math.exp(-e.deltaY * unit * WHEEL_ZOOM_SENSITIVITY)
        setView((v) => v && zoomAt(v, anchor, v.scale * factor))
      } else if (e.shiftKey && e.deltaX === 0) {
        setView((v) => v && panBy(v, e.deltaY * unit, 0))
      } else {
        setView((v) => v && panBy(v, e.deltaX * unit, e.deltaY * unit))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const isEditable = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

    /** 選択に対するキー操作。処理したら true */
    const editKey = (e: KeyboardEvent): boolean => {
      const document = store.getState().document
      if (!document) return false
      const direction = ARROW_DIRECTIONS[e.key]
      if (direction && selection.ids.length > 0) {
        // 矢印: ラスター1画素 / Shift: 10倍 / Alt: 1/10
        const step = nudgeStep * (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1)
        const dx = direction[0] * step
        const dy = direction[1] * step
        store.execute(
          selection.node
            ? moveNode(document, selection.node.objectId, selection.node.index, dx, dy)
            : moveObjects(document, selection.ids, dx, dy)
        )
        return true
      }
      if (e.altKey) return false
      if (e.key === 'Enter' && selection.ids.length > 0) {
        store.execute(confirmCandidates(document, selection.ids))
        return true
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.ids.length > 0) {
        store.execute(deleteObjects(document, selection.ids))
        return true
      }
      if (e.key === 'Escape' && selection.ids.length > 0) {
        // 頂点の選択 → オブジェクトの選択の順に解除する
        store.select(selection.node ? selection.ids : [])
        return true
      }
      return false
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      // ダイアログを開いている間は、キャンバスのキー操作(Enter で確定など)をしない
      if (window.document.querySelector('.modal-backdrop')) return
      if (isEditable(e.target) || e.metaKey || e.ctrlKey) return
      if (editKey(e)) {
        e.preventDefault()
        return
      }
      if (e.altKey) return
      const el = containerRef.current
      if (!el) return
      const viewport = { width: el.clientWidth, height: el.clientHeight }
      const mid = { x: viewport.width / 2, y: viewport.height / 2 }
      if (e.code === 'Space') {
        e.preventDefault()
        setSpaceHeld(true)
      } else if (e.key === '+' || e.key === '=') {
        setView((v) => v && zoomAt(v, mid, v.scale * ZOOM_STEP))
      } else if (e.key === '-') {
        setView((v) => v && zoomAt(v, mid, v.scale / ZOOM_STEP))
      } else if (e.key === '1') {
        setView(centerPage(page.mediaBox, viewport, CSS_PX_PER_PT))
      } else if (e.key === '5') {
        setView(fitPage(page.mediaBox, viewport))
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpaceHeld(false)
      // 矢印キーを離したら、そこまでの移動を1つの履歴として区切る
      if (ARROW_DIRECTIONS[e.key]) store.sealHistory()
    }
    const onBlur = (): void => {
      setSpaceHeld(false)
      store.sealHistory()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [page.mediaBox, selection, nudgeStep])

  const zoomPercent = view ? (view.scale / CSS_PX_PER_PT) * 100 : 100
  useEffect(() => {
    onStatus({ zoomPercent, cursorPdf })
  }, [zoomPercent, cursorPdf, onStatus])

  const localPoint = (e: React.PointerEvent): Point => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const toPdf = (v: View, p: Point): Point => svgToPdf(page.mediaBox, viewportToSvg(v, p))

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // 中ボタンドラッグ、または Space+左ドラッグでパン
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
      setPanning(true)
      return
    }
    if (e.button !== 0) return
    store.sealHistory()
    const target = e.target as Element
    const nodeEl = target.closest<SVGElement>('[data-node-index]')
    if (nodeEl) {
      const objectId = nodeEl.dataset.nodeObjectId!
      store.select(selection.ids.includes(objectId) ? selection.ids : [objectId], {
        objectId,
        index: Number(nodeEl.dataset.nodeIndex)
      })
      return
    }
    const objectId = target.closest<SVGElement>('[data-object-id]')?.dataset.objectId
    if (objectId && editableObjects.some((object) => object.id === objectId)) {
      if (!e.shiftKey) store.select([objectId])
      else if (selection.ids.includes(objectId)) store.select(selection.ids.filter((id) => id !== objectId))
      else store.select([...selection.ids, objectId])
      return
    }
    // 何もない場所: 範囲選択を始める(動かさずに離せば選択解除)
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = localPoint(e)
    setMarquee({ from: p, to: p })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (d && d.pointerId === e.pointerId) {
      const dx = e.clientX - d.lastX
      const dy = e.clientY - d.lastY
      d.lastX = e.clientX
      d.lastY = e.clientY
      setView((v) => v && panBy(v, -dx, -dy))
    }
    const p = localPoint(e)
    if (marquee) setMarquee({ from: marquee.from, to: p })
    if (view) setCursorPdf(toPdf(view, p))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId === e.pointerId) {
      drag.current = null
      setPanning(false)
    }
    if (marquee && view) {
      const { from, to } = marquee
      setMarquee(null)
      const base = e.shiftKey ? selection.ids : []
      if (Math.hypot(to.x - from.x, to.y - from.y) < CLICK_SLOP_PX) {
        store.select(base)
        return
      }
      const a = toPdf(view, from)
      const b = toPdf(view, to)
      const rect: Rect = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
      const hit = editableObjects.filter((object) => rectsIntersect(objectBounds(object), rect)).map((object) => object.id)
      store.select([...new Set([...base, ...hit])])
    }
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId === e.pointerId) {
      drag.current = null
      setPanning(false)
    }
    setMarquee(null)
  }

  const { width: pageWidth, height: pageHeight } = pageSize(page.mediaBox)
  const cursor = panning ? 'grabbing' : spaceHeld ? 'grab' : 'default'
  const background = page.layers.filter((layer) => layer.kind === 'background')
  const foreground = page.layers.filter((layer) => layer.kind !== 'background')

  return (
    <div
      ref={containerRef}
      className="canvas"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => setCursorPdf(null)}
    >
      {size && view && (
        <svg
          width={size.width}
          height={size.height}
          viewBox={`${view.x} ${view.y} ${size.width / view.scale} ${size.height / view.scale}`}
        >
          <rect className="page-shadow" x={3 / view.scale} y={3 / view.scale} width={pageWidth} height={pageHeight} />
          {/* isolate: 差分表示の合成をページの中だけに閉じる */}
          <g style={{ isolation: 'isolate' }}>
            <rect className="page-paper" x={0} y={0} width={pageWidth} height={pageHeight} />
            {/* ここから内側はPDF座標(pt、左下原点) */}
            <g transform={matrixToSvg(pdfToSvgMatrix(page.mediaBox))}>
              {background.map(
                (layer) => layer.visible && <LayerView key={layer.id} layer={layer} scale={view.scale} diffMode={diffMode} />
              )}
            </g>
            {diffMode && (
              // スクリーン合成で背景のインクを赤にする(白は白のまま)
              <rect
                x={0}
                y={0}
                width={pageWidth}
                height={pageHeight}
                fill={DIFF_BACKGROUND_COLOR}
                pointerEvents="none"
                style={{ mixBlendMode: 'screen' }}
              />
            )}
            <g transform={matrixToSvg(pdfToSvgMatrix(page.mediaBox))}>
              {foreground.map(
                (layer) => layer.visible && <LayerView key={layer.id} layer={layer} scale={view.scale} diffMode={diffMode} />
              )}
            </g>
          </g>
          <rect className="page-border" x={0} y={0} width={pageWidth} height={pageHeight} />
          <g transform={matrixToSvg(pdfToSvgMatrix(page.mediaBox))}>
            <HighlightOverlay objects={untaggedObjects} className="highlight-untagged" scale={view.scale} />
            <HighlightOverlay objects={relatedObjects} className="highlight-related" scale={view.scale} />
            <SelectionOverlay objects={selectedObjects} selection={selection} scale={view.scale} />
          </g>
          {marquee && (
            <rect
              className="marquee"
              x={view.x + Math.min(marquee.from.x, marquee.to.x) / view.scale}
              y={view.y + Math.min(marquee.from.y, marquee.to.y) / view.scale}
              width={Math.abs(marquee.to.x - marquee.from.x) / view.scale}
              height={Math.abs(marquee.to.y - marquee.from.y) / view.scale}
            />
          )}
        </svg>
      )}
    </div>
  )
})
