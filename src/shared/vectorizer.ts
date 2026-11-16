// Path化(Vectorizer)の差し替え口。方式を変えるときは Vectorizer を実装して登録する。
import type { Matrix, PathObject } from './model.ts'

export interface GrayRaster {
  width: number
  height: number
  /** 行優先。0 = 黒、255 = 白 */
  data: Uint8Array
}

export interface VectorizerInput {
  raster: GrayRaster
  /** 画素座標(左上原点、y下向き、px)→ PDF座標(pt、左下原点)の行列 */
  pixelToPdf: Matrix
}

/** 安定IDとZ順は呼び出し側で振る */
export type PathDraft = Omit<PathObject, 'id' | 'z'>

export interface Vectorizer {
  readonly id: string
  readonly label: string
  /** 候補を返すだけ。確定は人が行う */
  vectorize(input: VectorizerInput): PathDraft[]
}

export const DEFAULT_VECTORIZER_ID = 'line-detector'

/** 矢印の検出で作った Path の meta.source。罫線を検出し直すと入れ替える */
export const ARROW_SOURCE = 'arrow-detect'

/** 波括弧の検出で作った Path の meta.source。罫線を検出し直すと入れ替える */
export const BRACE_SOURCE = 'brace-detect'
