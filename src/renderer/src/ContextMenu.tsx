import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuItem =
  | 'separator'
  | {
      label: string
      /** 右側に出すキーの案内 */
      shortcut?: string
      disabled?: boolean
      /** 今の状態を示す印(役割の選択など) */
      checked?: boolean
      action?: () => void
      /** 子の項目。マウスを乗せると横に開く */
      children?: MenuItem[]
    }

interface Props {
  /** 画面上の位置(CSS px) */
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}

function Items({ items, onClose }: { items: MenuItem[]; onClose(): void }) {
  return (
    <ul role="menu">
      {items.map((item, i) =>
        item === 'separator' ? (
          <li key={i} className="separator" role="separator" />
        ) : (
          <li key={i} className={item.children ? 'has-children' : undefined}>
            <button
              role="menuitem"
              disabled={item.disabled || (!item.action && !item.children)}
              onClick={() => {
                if (!item.action) return
                onClose()
                item.action()
              }}
            >
              <span className="check">{item.checked ? '✓' : ''}</span>
              <span className="label">{item.label}</span>
              <span className="shortcut">{item.children ? '▸' : (item.shortcut ?? '')}</span>
            </button>
            {item.children && !item.disabled && (
              <div className="submenu">
                <Items items={item.children} onClose={onClose} />
              </div>
            )}
          </li>
        )
      )}
    </ul>
  )
}

/** 右クリックのメニュー。外を押す・Esc・ウィンドウの切り替えで閉じる */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  // 画面の端からはみ出さないよう、開いた後で位置を直す
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))
    })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    // capture: キャンバスの処理より先に受ける
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('wheel', onClose, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('wheel', onClose, true)
    }
  }, [onClose])

  return (
    <div ref={ref} className="context-menu" style={position} onContextMenu={(e) => e.preventDefault()}>
      <Items items={items} onClose={onClose} />
    </div>
  )
}
