// OCR の差し替え口。OCR は候補を出すだけで、文字内容は人が確定する。
import type { TextObject } from './model'

export type OcrEngineId = 'vision' | 'tesseract'

export interface OcrEngineInfo {
  id: OcrEngineId
  label: string
  available: boolean
  /** 使えないときの理由と対処 */
  reason: string | null
}

/** 画素座標(左上原点、y下向き)の矩形 */
export interface PixelBox {
  x: number
  y: number
  width: number
  height: number
}

export interface OcrLine {
  text: string
  /** 0〜1 */
  confidence: number
  box: PixelBox
  /** text の1文字(UTF-16 コード単位ではなく書記素)ごとの位置。分からない文字は null */
  chars: (PixelBox | null)[]
}

/** 安定IDとZ順は呼び出し側で振る */
export type TextDraft = Omit<TextObject, 'id' | 'z'>
