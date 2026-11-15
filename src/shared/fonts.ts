// 使えるフォントの一覧。Text オブジェクトは family と weight でフォントを指す。
// 同梱フォントは再配布・埋め込みができるもの(SIL OFL)に限り、`pnpm fonts` で取得する(Git管理外)。
// MS ゴシック / MS 明朝のような再配布できないフォントは、将来 OS やプロジェクトの fonts/ から読む想定。

export interface FontFace {
  family: string
  weight: number
  /** resources/fonts/ または プロジェクトの fonts/ にあるファイル名 */
  file: string
  generic: 'sans-serif' | 'serif'
}

export interface DownloadableFont extends FontFace {
  url: string
  license: string
}

const NOTO_CJK = 'https://raw.githubusercontent.com/notofonts/noto-cjk/main'

export const BUNDLED_FONTS: DownloadableFont[] = [
  {
    family: 'Noto Sans JP',
    weight: 400,
    file: 'NotoSansJP-Regular.otf',
    generic: 'sans-serif',
    url: `${NOTO_CJK}/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf`,
    license: 'SIL Open Font License 1.1'
  },
  {
    family: 'Noto Sans JP',
    weight: 700,
    file: 'NotoSansJP-Bold.otf',
    generic: 'sans-serif',
    url: `${NOTO_CJK}/Sans/SubsetOTF/JP/NotoSansJP-Bold.otf`,
    license: 'SIL Open Font License 1.1'
  },
  {
    family: 'Noto Serif JP',
    weight: 400,
    file: 'NotoSerifJP-Regular.otf',
    generic: 'serif',
    url: `${NOTO_CJK}/Serif/SubsetOTF/JP/NotoSerifJP-Regular.otf`,
    license: 'SIL Open Font License 1.1'
  },
  {
    family: 'Noto Serif JP',
    weight: 700,
    file: 'NotoSerifJP-Bold.otf',
    generic: 'serif',
    url: `${NOTO_CJK}/Serif/SubsetOTF/JP/NotoSerifJP-Bold.otf`,
    license: 'SIL Open Font License 1.1'
  }
]

export const DEFAULT_FONT_FAMILY = 'Noto Sans JP'
export const DEFAULT_FONT_WEIGHT = 400
