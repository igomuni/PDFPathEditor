// 修正ファイルの検証と、適用の計画。ドキュメントの変更は commands.ts のコマンドが行う。
import { CORRECTIONS_VERSION, type TextSettings } from '../../shared/corrections.ts'
import { DEFAULT_FONT_FAMILY, DEFAULT_FONT_WEIGHT } from '../../shared/fonts.ts'
import type { DocObject, ObjectRole, Page, Rect, TextObject } from '../../shared/model.ts'

export const MAX_OPERATIONS = 5000
const ROLES: readonly ObjectRole[] = ['frame', 'label', 'inputCell', 'fieldCode', 'qr', 'formId', 'other']
const ALIGNS: readonly TextObject['align'][] = ['left', 'center', 'right']
const COLOR = /^#[0-9a-fA-F]{6}$/
const MAX_TEXT_LENGTH = 500

/** 枠に合わせた Text の配置 */
export interface TextFit {
  fontSize: number
  letterSpacing: number
  x: number
  y: number
}

/** 文字のインクが box に収まるよう、サイズ・位置・字間を決める。フォントを測れないときは null */
export type FitText = (text: string, fontFamily: string, fontWeight: number, box: Rect) => TextFit | null

export interface RejectedOperation {
  /** operations の中の位置(0始まり) */
  index: number
  reason: string
}

export interface CorrectionPlan {
  pageId: string
  /** 置換後のオブジェクト(ID → 新しい内容) */
  replacements: Map<string, TextObject>
  additions: TextObject[]
  deletions: Set<string>
  rejected: RejectedOperation[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits

/** set の中身を確かめて、型の合ったものだけを取り出す。問題があれば理由を返す */
function readSettings(raw: unknown): TextSettings | string {
  if (!isObject(raw)) return '属性の指定がオブジェクトではありません'
  const out: TextSettings = {}
  const known = new Set(['text', 'fontFamily', 'fontWeight', 'fontSize', 'letterSpacing', 'x', 'y', 'align', 'fill', 'outline', 'role', 'fieldCode', 'fitBox'])
  for (const key of Object.keys(raw)) if (!known.has(key)) return `未対応の属性です: ${key}`
  if (raw.text !== undefined) {
    if (typeof raw.text !== 'string' || raw.text === '' || raw.text.length > MAX_TEXT_LENGTH || /[\r\n]/.test(raw.text)) {
      return 'text は改行を含まない1〜500字の文字列にしてください'
    }
    out.text = raw.text
  }
  if (raw.fontFamily !== undefined) {
    if (typeof raw.fontFamily !== 'string' || raw.fontFamily === '' || raw.fontFamily.length > 100) return 'fontFamily が正しくありません'
    out.fontFamily = raw.fontFamily
  }
  if (raw.fontWeight !== undefined) {
    if (!isNumber(raw.fontWeight) || raw.fontWeight < 100 || raw.fontWeight > 900) return 'fontWeight は 100〜900 にしてください'
    out.fontWeight = raw.fontWeight
  }
  if (raw.fontSize !== undefined) {
    if (!isNumber(raw.fontSize) || raw.fontSize <= 0 || raw.fontSize > 1000) return 'fontSize は 0 より大きい数にしてください'
    out.fontSize = raw.fontSize
  }
  for (const key of ['letterSpacing', 'x', 'y'] as const) {
    if (raw[key] === undefined) continue
    if (!isNumber(raw[key]) || Math.abs(raw[key]) > 100000) return `${key} が数値ではありません`
    out[key] = raw[key]
  }
  if (raw.align !== undefined) {
    if (!ALIGNS.includes(raw.align as TextObject['align'])) return 'align は left / center / right のどれかにしてください'
    out.align = raw.align as TextObject['align']
  }
  if (raw.fill !== undefined) {
    if (typeof raw.fill !== 'string' || !COLOR.test(raw.fill)) return 'fill は #rrggbb の形にしてください'
    out.fill = raw.fill
  }
  if (raw.outline !== undefined) {
    if (typeof raw.outline !== 'boolean') return 'outline は true / false にしてください'
    out.outline = raw.outline
  }
  if (raw.role !== undefined) {
    if (!ROLES.includes(raw.role as ObjectRole)) return `role が正しくありません: ${String(raw.role)}`
    out.role = raw.role as ObjectRole
  }
  if (raw.fieldCode !== undefined) {
    if (raw.fieldCode !== null && (typeof raw.fieldCode !== 'string' || raw.fieldCode === '' || raw.fieldCode.length > 32)) {
      return 'fieldCode は文字列か null にしてください'
    }
    out.fieldCode = raw.fieldCode
  }
  if (raw.fitBox !== undefined) {
    const box = raw.fitBox
    if (!Array.isArray(box) || box.length !== 4 || !box.every(isNumber) || box[2] <= box[0] || box[3] <= box[1]) {
      return 'fitBox は [x0, y0, x1, y1](x0 < x1, y0 < y1)にしてください'
    }
    out.fitBox = [box[0], box[1], box[2], box[3]]
  }
  return out
}

/** 設定を Text に反映する。fitBox があればフォントに合わせて配置を決める */
function applySettings(base: TextObject, settings: TextSettings, fit: FitText): TextObject | string {
  const { x, y, fitBox, ...attributes } = settings
  let next: TextObject = { ...base, ...attributes }
  const [a, b, c, d, e, f] = next.transform
  next = { ...next, transform: [a, b, c, d, x ?? e, y ?? f] }
  if (fitBox) {
    const fitted = fit(next.text, next.fontFamily, next.fontWeight, fitBox)
    if (!fitted) return `フォント「${next.fontFamily}」を測れないので、fitBox に合わせられません`
    next = {
      ...next,
      align: 'left',
      fontSize: round(fitted.fontSize, 2),
      letterSpacing: round(fitted.letterSpacing, 2),
      transform: [1, 0, 0, 1, round(fitted.x, 3), round(fitted.y, 3)]
    }
  }
  return next
}

/**
 * 修正ファイルの内容を確かめ、ページに適用する計画を作る。
 * 適用できない操作は rejected に理由を入れて飛ばす。ファイル全体が読めないときは例外を投げる。
 */
export function planCorrections(
  pages: readonly Page[],
  raw: unknown,
  fit: FitText,
  newId: () => string = () => `obj-${crypto.randomUUID()}`
): CorrectionPlan {
  if (!isObject(raw)) throw new Error('修正ファイルの形式が正しくありません(JSON のオブジェクトではありません)')
  if (raw.version !== CORRECTIONS_VERSION) throw new Error(`未対応の修正ファイルのバージョンです: ${String(raw.version)}`)
  if (!Array.isArray(raw.operations)) throw new Error('修正ファイルに operations(配列)がありません')
  if (raw.operations.length > MAX_OPERATIONS) throw new Error(`操作が多すぎます(${raw.operations.length} 件、上限 ${MAX_OPERATIONS} 件)`)
  const page = raw.page === undefined ? pages[0] : pages.find((candidate) => candidate.sourcePageNumber === raw.page)
  if (!page) throw new Error(`対象のページがありません: ${String(raw.page)}`)

  // 変更できるのは、ロックされていない候補・確定レイヤーのオブジェクトだけ
  const objects = new Map<string, DocObject>()
  for (const layer of page.layers) {
    if (layer.locked || (layer.kind !== 'candidates' && layer.kind !== 'confirmed')) continue
    for (const object of layer.objects) objects.set(object.id, object)
  }
  const plan: CorrectionPlan = { pageId: page.id, replacements: new Map(), additions: [], deletions: new Set(), rejected: [] }
  const touched = new Set<string>()

  raw.operations.forEach((operation: unknown, index: number) => {
    const reject = (reason: string): void => void plan.rejected.push({ index, reason })
    if (!isObject(operation)) return reject('操作がオブジェクトではありません')
    if (operation.op === 'add') {
      const settings = readSettings(operation.text)
      if (typeof settings === 'string') return reject(settings)
      if (settings.text === undefined) return reject('追加には text が必要です')
      if (!settings.fitBox && (settings.x === undefined || settings.y === undefined || settings.fontSize === undefined)) {
        return reject('追加には fitBox か、x・y・fontSize が必要です')
      }
      const base: TextObject = {
        id: newId(),
        type: 'text',
        role: 'label',
        fieldCode: null,
        transform: [1, 0, 0, 1, 0, 0],
        z: 0,
        tags: [],
        meta: { source: 'corrections' },
        text: settings.text,
        fontFamily: DEFAULT_FONT_FAMILY,
        fontWeight: DEFAULT_FONT_WEIGHT,
        fontSize: 10,
        letterSpacing: 0,
        fill: '#000000',
        align: 'left',
        outline: false
      }
      const added = applySettings(base, settings, fit)
      if (typeof added === 'string') return reject(added)
      plan.additions.push(added)
      return
    }
    if (operation.op !== 'replace' && operation.op !== 'delete') return reject(`未対応の操作です: ${String(operation.op)}`)
    if (typeof operation.id !== 'string') return reject('id がありません')
    const target = objects.get(operation.id)
    if (!target) return reject(`対象のオブジェクトがありません: ${operation.id}`)
    if (touched.has(target.id)) return reject(`同じオブジェクトへの操作が重複しています: ${target.id}`)
    if (operation.op === 'delete') {
      touched.add(target.id)
      plan.deletions.add(target.id)
      return
    }
    if (target.type !== 'text') return reject(`置換できるのは Text だけです: ${target.id}`)
    const settings = readSettings(operation.set)
    if (typeof settings === 'string') return reject(settings)
    if (Object.keys(settings).length === 0) return reject('変更する属性がありません')
    const replaced = applySettings(target, settings, fit)
    if (typeof replaced === 'string') return reject(replaced)
    touched.add(target.id)
    plan.replacements.set(target.id, { ...replaced, meta: { ...replaced.meta, corrected: true } })
  })
  return plan
}
