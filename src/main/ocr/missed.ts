// 読み落としの拾い直し(design.md §3-47)のうち、読んだ字を受け付けるかどうかの判定。

// 拾い直しで受け付ける字: ひらがな・カタカナ(長音を含む)・漢字・々・数字・丸数字と、括弧や演算の記号
export const MISSED_ALLOWED = /^[\u3040-\u30ff\u3400-\u9fff\u3005\u2460-\u2473\u3251-\u325f\u32b1-\u32bf0-9０-９（）｛｝「」・〜×+＋※★☆]+$/u

/**
 * 読み落としを読んだ結果を整える。1〜2字だけを受け付け、OCR が半角や別の字で返す記号を、印字に近い字にそろえる。
 * 受け付けないものは null。
 */
export function normalizeMissedText(raw: string): string | null {
  const text = raw.replace(/\s+/g, '')
  const count = [...text].length
  if (count < 1 || count > 2) return null
  const map: Record<string, string> = { '~': '〜', '∼': '〜', '～': '〜', x: '×', X: '×', '+': '+', '*': '※', '･': '・', '.': '・', '·': '・', '(': '（', ')': '）', '{': '（', '}': '）', '｛': '（', '｝': '）' }
  // 波括弧は、細い丸括弧の読み違いなので丸括弧にする(本物の波括弧は図形として扱う。§3-60)
  const normalized = [...text].map((char) => map[char] ?? char).join('')
  // かな・漢字・数字と、様式に出てくる記号だけを受け付ける。英字や「|」「■」「'」などは、罫線や図形のかけらを読んだものが多い
  return MISSED_ALLOWED.test(normalized) ? normalized : null
}

/**
 * インクのまとまりが、塗りつぶした星(★)らしい形か。外接矩形がほぼ正方形で、その 3 割ほどが塗られている。
 * (正五角形の星は、外接矩形の約 33% を占める。)ここでは候補を絞るだけで、採用は描いた字形との重なりで決める。
 */
export function isStarShape(width: number, height: number, ink: number, minSize: number, maxSize: number): boolean {
  if (width < minSize || height < minSize || width > maxSize || height > maxSize) return false
  const aspect = width / height
  const fill = ink / (width * height)
  return aspect >= 0.85 && aspect <= 1.25 && fill >= 0.24 && fill <= 0.42
}

// 大きすぎるとみなす、ページの文字の大きさの中央値に対する比と、背景に合わないインクの割合
const OVERSIZE_RATIO = 2
const OVERSIZE_MIN_EXCESS = 0.5

/**
 * 大きすぎて、背景とも合っていない候補か。ページのふつうの文字の 2 倍を超える大きさで、
 * 描いたインクの半分以上が背景に対応しないもの。表題のような本当に大きい文字は、背景と合うので残る。
 * excess は、大きい候補のときだけ計算する(描いて比べるので重い)。
 */
export function isOversizedMisfit(fontSize: number, medianSize: number, excess: () => number): boolean {
  return medianSize > 0 && fontSize > OVERSIZE_RATIO * medianSize && excess() > OVERSIZE_MIN_EXCESS
}
