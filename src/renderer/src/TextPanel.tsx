import type { FontFace as FontInfo } from '../../shared/fonts'
import type { TextObject } from '../../shared/model'
import { updateTexts, type TextPatch } from './commands'
import { store } from './store'

interface Props {
  texts: TextObject[]
  fonts: FontInfo[]
}

/** 選択中の全 Text で同じ値ならその値、違えば null */
function common<K extends keyof TextObject>(texts: TextObject[], key: K): TextObject[K] | null {
  return texts.every((text) => text[key] === texts[0][key]) ? texts[0][key] : null
}

/** 選択した Text の文字列・フォント・サイズなどを編集するパネル */
export function TextPanel({ texts, fonts }: Props) {
  const ids = texts.map((text) => text.id)
  const apply = (patch: TextPatch): void => {
    const document = store.getState().document
    if (document) store.execute(updateTexts(document, ids, patch))
  }
  const seal = (): void => store.sealHistory()

  const family = common(texts, 'fontFamily')
  const weight = common(texts, 'fontWeight')
  const size = common(texts, 'fontSize')
  const spacing = common(texts, 'letterSpacing')
  const align = common(texts, 'align')
  const fill = common(texts, 'fill')
  const outline = common(texts, 'outline')
  const confidence = texts.length === 1 ? texts[0].meta.confidence : undefined

  // 取得済みのフォントに加え、選択中の Text が指しているフォントも選択肢に出す
  const families = [...new Set([...fonts.map((font) => font.family), ...texts.map((text) => text.fontFamily)])]
  const weights = [
    ...new Set([...fonts.filter((font) => family === null || font.family === family).map((font) => font.weight), ...texts.map((text) => text.fontWeight)])
  ].sort((a, b) => a - b)
  const missing = family !== null && !fonts.some((font) => font.family === family && (weight === null || font.weight === weight))

  const numberField = (
    label: string,
    value: number | null,
    key: 'fontSize' | 'letterSpacing',
    step: number,
    min: number
  ) => (
    <label>
      <span>{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        value={value ?? ''}
        placeholder={value === null ? '混在' : undefined}
        onChange={(e) => {
          const next = e.target.valueAsNumber
          if (Number.isFinite(next) && next >= min) apply({ [key]: next })
        }}
        onBlur={seal}
      />
      <span className="unit">pt</span>
    </label>
  )

  return (
    <section>
      <h2>テキスト{texts.length > 1 ? `(${texts.length} 件)` : ''}</h2>
      {texts.length === 1 && (
        <label className="stacked">
          <span>文字列</span>
          <input
            type="text"
            value={texts[0].text}
            onChange={(e) => apply({ text: e.target.value })}
            onBlur={seal}
            spellCheck={false}
          />
        </label>
      )}
      <label>
        <span>フォント</span>
        <select value={family ?? ''} onChange={(e) => apply({ fontFamily: e.target.value })}>
          {family === null && <option value="">混在</option>}
          {families.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>太さ</span>
        <select value={weight ?? ''} onChange={(e) => apply({ fontWeight: Number(e.target.value) })}>
          {weight === null && <option value="">混在</option>}
          {weights.map((value) => (
            <option key={value} value={value}>
              {value === 400 ? '標準 (400)' : value === 700 ? '太字 (700)' : value}
            </option>
          ))}
        </select>
      </label>
      {missing && <p className="warning">このフォントは取得されていません。画面では代わりのフォントで表示しています。</p>}
      {numberField('サイズ', size, 'fontSize', 0.1, 0.1)}
      {numberField('字間', spacing, 'letterSpacing', 0.05, -100)}
      <label>
        <span>配置</span>
        <select value={align ?? ''} onChange={(e) => apply({ align: e.target.value as TextObject['align'] })}>
          {align === null && <option value="">混在</option>}
          <option value="left">左</option>
          <option value="center">中央</option>
          <option value="right">右</option>
        </select>
      </label>
      <label>
        <span>色</span>
        <input type="color" value={fill ?? '#000000'} onChange={(e) => apply({ fill: e.target.value })} onBlur={seal} />
      </label>
      <label title="出力時に文字を輪郭のPathとして描く(見た目の再現用)。オフなら実フォントのテキストとして出力する">
        <span>輪郭Path</span>
        <input type="checkbox" checked={outline ?? false} onChange={(e) => apply({ outline: e.target.checked })} />
      </label>
      {typeof confidence === 'number' && <p className="hint">OCR の確信度 {confidence.toFixed(2)}</p>}
    </section>
  )
}
