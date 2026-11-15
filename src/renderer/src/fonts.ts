// main から取得済みフォントを読み込み、画面(SVG / canvas)で使えるようにする。
import { useEffect, useState } from 'react'
import type { FontFace as FontInfo } from '../../shared/fonts'

export interface FontState {
  /** 読み込みが済んで使えるフォント */
  fonts: FontInfo[]
  loaded: boolean
}

export function useFonts(): FontState {
  const [state, setState] = useState<FontState>({ fonts: [], loaded: false })
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const available = await window.api.listFonts()
      const ready: FontInfo[] = []
      for (const font of available) {
        try {
          const bytes = await window.api.readFont(font.file)
          const face = new FontFace(font.family, bytes as Uint8Array<ArrayBuffer>, { weight: String(font.weight) })
          await face.load()
          document.fonts.add(face)
          ready.push(font)
        } catch (err) {
          console.error(`フォントを読み込めません: ${font.file}`, err)
        }
      }
      if (!cancelled) setState({ fonts: ready, loaded: true })
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return state
}
