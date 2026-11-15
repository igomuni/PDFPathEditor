// OCR の後処理: 縦に並ぶ1字の Text を、1つの縦書きの Text にまとめる(design.md §3-43)。
// 「収」「入」「金」「額」「等」のように、縦書きの見出しは1字ずつ別の行として読まれることが多い。
import type { TextDraft } from '../../shared/ocr.ts'
import { VERTICAL_BASELINE } from '../../shared/vertical.ts'

/**
 * まとめる対象にする文字(かな・漢字・括弧)。数字や記号は、縦に並んでいても別々の項目のことが多い。
 * 長音「ー」と中点「・」は、記入欄の区切りとして単独で印字されることがあるので除く。
 * (文字はコード番号で書く: ひらがな・カタカナ U+3040〜30FA / 30FD〜30FF、漢字 U+3400〜9FFF、全角の括弧)
 */
const VERTICAL_CHAR = /^[\u3040-\u30fa\u30fd-\u30ff\u3400-\u9fff\uff08\uff09()]$/u

// 左右の中心のずれの許容量(em)
const MAX_CENTER_OFFSET = 0.35
// サイズの比の許容範囲
const MAX_SIZE_RATIO = 1.33
// 上下の字の間隔の上限(em)。均等割り付けの見出しは間隔が広い
const MAX_GAP = 6
// 字の重なりの許容量(em)
const MAX_OVERLAP = 0.3
// 送りのばらつきの許容量(em)。そろっていなければ、1つの Text にすると位置がずれるのでまとめない
const MAX_PITCH_DEVIATION = 0.3

interface Item {
  draft: TextDraft
  index: number
  size: number
  /** 左右の中心 */
  centerX: number
  /** 仮想ボディの上辺と下辺(PDF座標、y上向き) */
  top: number
  bottom: number
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits

/**
 * 縦に並ぶ1字の Text をまとめる。まとめたものは1字目のあった位置に置き、他の Text の順番は変えない。
 * blocked(x, yBottom, yTop) は、その x で yBottom〜yTop の間に横の罫線があるときに true を返す
 * (罫線をまたぐ文字は別の枠の項目なのでまとめない)。
 */
export function mergeVerticalRuns(drafts: readonly TextDraft[], blocked: (x: number, yBottom: number, yTop: number) => boolean): TextDraft[] {
  const items: Item[] = []
  drafts.forEach((draft, index) => {
    if (draft.writingMode === 'vertical' || !VERTICAL_CHAR.test(draft.text)) return
    const [a, b, c, d, x, y] = draft.transform
    if (a !== 1 || b !== 0 || c !== 0 || d !== 1) return
    const size = draft.fontSize
    items.push({ draft, index, size, centerX: x + size / 2, top: y + VERTICAL_BASELINE * size, bottom: y - (1 - VERTICAL_BASELINE) * size })
  })
  // 上にあるものから順に、真下の字をつないでいく
  items.sort((p, q) => q.top - p.top)
  const used = new Set<Item>()
  const merged = new Map<number, TextDraft>()
  const removed = new Set<number>()

  for (const head of items) {
    if (used.has(head)) continue
    const chain = [head]
    for (;;) {
      const last = chain.at(-1)!
      let next: Item | null = null
      for (const candidate of items) {
        if (used.has(candidate) || chain.includes(candidate) || candidate.top >= last.top) continue
        const size = Math.max(last.size, candidate.size)
        const gap = last.bottom - candidate.top
        if (Math.abs(candidate.centerX - head.centerX) > MAX_CENTER_OFFSET * size) continue
        if (size / Math.min(last.size, candidate.size) > MAX_SIZE_RATIO) continue
        if (gap < -MAX_OVERLAP * size || gap > MAX_GAP * size) continue
        if (gap > 0 && blocked(head.centerX, candidate.top, last.bottom)) continue
        if (!next || candidate.top > next.top) next = candidate
      }
      if (!next) break
      chain.push(next)
    }
    // 送りがそろうところまでに縮める(「事業」のあとに離れて「等」が続く、のような並びは前半だけをまとめる)
    let size = 0
    let pitch = 0
    while (chain.length >= 2) {
      size = median(chain.map((item) => item.size))
      pitch = (chain[0].top - chain.at(-1)!.top) / (chain.length - 1)
      const steps = chain.slice(1).map((item, i) => chain[i].top - item.top)
      if (steps.every((step) => Math.abs(step - pitch) <= MAX_PITCH_DEVIATION * size)) break
      chain.pop()
    }
    if (chain.length < 2) continue

    for (const item of chain) used.add(item)
    const first = chain[0]
    // 仮想ボディの中心で位置を決め直す(サイズを中央値にそろえるため)
    const firstCenterY = (first.top + first.bottom) / 2
    merged.set(first.index, {
      ...first.draft,
      text: chain.map((item) => item.draft.text).join(''),
      fontSize: round(size, 2),
      letterSpacing: round(pitch - size, 2),
      align: 'left',
      writingMode: 'vertical',
      transform: [1, 0, 0, 1, round(median(chain.map((item) => item.centerX)), 3), round(firstCenterY + size / 2, 3)],
      meta: {
        ...first.draft.meta,
        confidence: Math.min(...chain.map((item) => Number(item.draft.meta.confidence ?? 1))),
        mergedVertical: chain.length
      }
    })
    for (const item of chain.slice(1)) removed.add(item.index)
  }
  return drafts.flatMap((draft, index) => (removed.has(index) ? [] : [merged.get(index) ?? draft]))
}
