import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { DocObject, Page } from '../../shared/model'
import {
  centerPage,
  CSS_PX_PER_PT,
  fitPage,
  matrixToSvg,
  pageSize,
  panBy,
  pdfToSvgMatrix,
  svgToPdf,
  viewportToSvg,
  zoomAt,
  type Point,
  type View
} from './coords'

export interface CanvasHandle {
  zoomIn(): void
  zoomOut(): void
  zoomFit(): void
  zoom100(): void
}

export interface CanvasStatus {
  /** 100% = 96px/inch 相当 */
  zoomPercent: number
  /** カーソル位置(PDF座標、pt)。キャンバス外は null */
  cursorPdf: Point | null
}

interface Props {
  page: Page
  onStatus(status: CanvasStatus): void
}

const ZOOM_STEP = Math.SQRT2
const WHEEL_ZOOM_SENSITIVITY = 0.01
// ラスターの1画素がこの CSS px 以上になったら補間せず画素をそのまま見せる
const PIXELATE_THRESHOLD = 3

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

function ObjectView({ object, scale }: { object: DocObject; scale: number }) {
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

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas({ page, onStatus }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const [cursorPdf, setCursorPdf] = useState<Point | null>(null)
  const fittedPageId = useRef<string | null>(null)
  const drag = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)

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
    zoom100: () => size && setView(centerPage(page.mediaBox, size, CSS_PX_PER_PT))
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
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      const mid = { x: (containerRef.current?.clientWidth ?? 0) / 2, y: (containerRef.current?.clientHeight ?? 0) / 2 }
      const el = containerRef.current
      const viewport = el ? { width: el.clientWidth, height: el.clientHeight } : null
      if (e.code === 'Space') {
        e.preventDefault()
        setSpaceHeld(true)
      } else if (e.key === '+' || e.key === '=') {
        setView((v) => v && zoomAt(v, mid, v.scale * ZOOM_STEP))
      } else if (e.key === '-') {
        setView((v) => v && zoomAt(v, mid, v.scale / ZOOM_STEP))
      } else if (e.key === '1' && viewport) {
        setView(centerPage(page.mediaBox, viewport, CSS_PX_PER_PT))
      } else if (e.key === '5' && viewport) {
        setView(fitPage(page.mediaBox, viewport))
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    const onBlur = (): void => setSpaceHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [page.mediaBox])

  const zoomPercent = view ? (view.scale / CSS_PX_PER_PT) * 100 : 100
  useEffect(() => {
    onStatus({ zoomPercent, cursorPdf })
  }, [zoomPercent, cursorPdf, onStatus])

  const localPoint = (e: React.PointerEvent): Point => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // 中ボタンドラッグ、または Space+左ドラッグでパン
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
      setPanning(true)
    }
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
    if (view) setCursorPdf(svgToPdf(page.mediaBox, viewportToSvg(view, localPoint(e))))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId === e.pointerId) {
      drag.current = null
      setPanning(false)
    }
  }

  const { width: pageWidth, height: pageHeight } = pageSize(page.mediaBox)
  const cursor = panning ? 'grabbing' : spaceHeld ? 'grab' : 'default'

  return (
    <div
      ref={containerRef}
      className="canvas"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => setCursorPdf(null)}
    >
      {size && view && (
        <svg
          width={size.width}
          height={size.height}
          viewBox={`${view.x} ${view.y} ${size.width / view.scale} ${size.height / view.scale}`}
        >
          <rect className="page-shadow" x={3 / view.scale} y={3 / view.scale} width={pageWidth} height={pageHeight} />
          <rect className="page-paper" x={0} y={0} width={pageWidth} height={pageHeight} />
          {/* ここから内側はPDF座標(pt、左下原点) */}
          <g transform={matrixToSvg(pdfToSvgMatrix(page.mediaBox))}>
            {page.layers.map(
              (layer) =>
                layer.visible && (
                  <g key={layer.id} opacity={layer.opacity} data-layer-kind={layer.kind}>
                    {[...layer.objects]
                      .sort((a, b) => a.z - b.z)
                      .map((object) => (
                        <ObjectView key={object.id} object={object} scale={view.scale} />
                      ))}
                  </g>
                )
            )}
          </g>
          <rect className="page-border" x={0} y={0} width={pageWidth} height={pageHeight} />
        </svg>
      )}
    </div>
  )
})
