// 様式ID(様式番号の印字)の Text を見つける(design.md §3-54)。
// 「様式ID」という見出しの右隣にある、英数字の並びを様式ID とみなす。
import type { Page, Rect, TextObject } from '../../shared/model.ts'

const compact = (text: string): string => text.normalize('NFKC').replace(/\s+/g, '')
const LABEL = /様式ID/i
const VALUE = /^[A-Z0-9-]{4,}$/i

/** 様式ID にあたる Text のID(編集できるレイヤーのもの) */
export function findFormIdTexts(page: Page, boundsOf: (object: TextObject) => Rect): string[] {
  const texts = page.layers
    .filter((layer) => !layer.locked)
    .flatMap((layer) => layer.objects)
    .flatMap((object) => (object.type === 'text' ? [{ object, text: compact(object.text), box: boundsOf(object) }] : []))
  const found = new Set<string>()
  for (const label of texts) {
    if (!LABEL.test(label.text)) continue
    // 見出しと値が1つの Text になっているとき
    const rest = label.text.replace(LABEL, '').replace(/^[::]/, '')
    if (VALUE.test(rest)) {
      found.add(label.object.id)
      continue
    }
    if (rest !== '') continue
    // 同じ行の右にある、いちばん近い Text
    const height = label.box[3] - label.box[1]
    const next = texts
      .filter((other) => {
        const middle = (other.box[1] + other.box[3]) / 2
        return other !== label && middle > label.box[1] && middle < label.box[3] && other.box[0] >= label.box[2] - height && other.box[0] - label.box[2] < height * 12
      })
      .sort((p, q) => p.box[0] - q.box[0])[0]
    if (next && VALUE.test(next.text)) found.add(next.object.id)
  }
  return [...found]
}
