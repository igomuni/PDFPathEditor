// 縦書きの Text(Q-01)の確認: OCR での自動まとめ、パネルでの切り替え、修正ファイル、出力。
//   node scripts/e2e/vertical-text.mjs <PDF> [スクリーンショットの出力先フォルダ]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const [pdfArg, shots] = process.argv.slice(2)
if (!pdfArg) {
  console.error('使い方: node scripts/e2e/vertical-text.mjs <PDF> [スクリーンショットの出力先]')
  process.exit(2)
}
const work = mkdtempSync(join(tmpdir(), 'pdfpe-vertical-'))
const project = join(work, 'project')
const corrections = join(work, 'corrections.json')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const pageOf = () => {
  const manifest = readJson(join(project, 'document.json'))
  return { manifest, page: readJson(join(project, manifest.pages[0].file)) }
}
const textsOf = (page) => page.layers.flatMap((layer) => layer.objects).filter((object) => object.type === 'text')

const app = await launch({ env: { E2E_PDF: resolve(pdfArg), E2E_DEST: project, E2E_JSON: corrections, E2E_MESSAGE: '1' } })
try {
  await app.click('PDFを取り込む')
  await app.waitIdle()
  await app.waitLoaded()
  await app.click('罫線を検出')
  await app.waitIdle()
  await app.click('文字を検出')
  await app.waitIdle()
  await app.click('保存')
  await app.waitIdle()
  await app.sleep(500)
  check('取り込み・検出・保存ができる', (await app.error()) === '', await app.statusBar())

  // 1. OCR の後処理で、縦に並ぶ1字が縦書きの Text にまとまる
  let { page } = pageOf()
  const vertical = textsOf(page).filter((text) => text.writingMode === 'vertical')
  console.log('     縦書きにまとめた Text:', vertical.map((text) => `${text.text}(${text.fontSize}pt, 字間 ${text.letterSpacing})`).join(' / '))
  check('縦に並ぶ1字の Text が縦書きにまとまる', vertical.length > 0 && vertical.every((text) => [...text.text].length >= 2))
  // 枠の読み直し: 背景と合っていない枠・読み落としのある枠を、列・行に分けて読み直した候補がある
  const reread = textsOf(page).filter((text) => text.meta.reread)
  console.log('     読み直した Text:', reread.map((text) => `${text.text}${text.writingMode === 'vertical' ? '(縦)' : ''}`).join(' / '))
  check('枠の読み直しで、縦書きと横書きの候補ができる', reread.some((text) => text.meta.reread === 'vertical' && text.writingMode === 'vertical') && reread.some((text) => text.meta.reread === 'horizontal'), `${reread.length} 件`)
  // 読み落としの拾い直し: 星(★)は形から Text にする
  const picked = textsOf(page).filter((text) => text.meta.missed)
  const starTexts = picked.filter((text) => text.text === '★')
  console.log('     拾い直した Text:', picked.map((text) => text.text).join(' '))
  check('星(★)を Text として拾う', starTexts.length === 1, starTexts.map((text) => `${text.fontSize}pt (${text.transform[4]}, ${text.transform[5]})`).join(' / '))
  // 丸囲みの文字: ①〜㊿ とカタカナは1つの Text、51 以上は数字の Text と丸の Path
  const objects = page.layers.flatMap((layer) => layer.objects)
  const circledTexts = objects.filter((object) => object.type === 'text' && object.meta.circled !== undefined)
  const circles = objects.filter((object) => object.type === 'path' && object.meta.source === 'ocr-circle')
  const single = circledTexts.filter((text) => /^[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf\u32d0-\u32fe]$/u.test(text.text))
  const large = circledTexts.filter((text) => /^\d\d$/.test(text.text))
  console.log('     丸囲み:', circledTexts.map((text) => text.text).join(' '))
  check('丸囲みの文字を Text として検出する', single.length >= 20, `1文字 ${single.length} 件`)
  check(
    '51 以上の丸数字は、数字の Text と丸の Path になる',
    large.length > 0 && large.length === circles.length && large.every((text) => Number(text.text) >= 51) && circles.every((path) => path.closed && path.nodes.length === 4 && path.nodes[0].out),
    `数字 ${large.length} 件 / 丸 ${circles.length} 件`
  )
  const drawn = await app.evaluate(`document.querySelectorAll('svg text tspan').length`)
  check('縦書きの Text が1字ずつ描かれる', drawn === vertical.reduce((sum, text) => sum + [...text.text].length, 0), `tspan ${drawn} 個`)
  if (shots) await app.screenshot(join(shots, 'vertical-detected.png'))

  // 罫線を検出し直しても丸は残り、文字を検出し直しても丸は増えない
  const circlesOnCanvas = () => app.evaluate(`document.querySelectorAll('svg [data-layer-kind=candidates] path[d*="C"]').length`)
  const circleCount = await circlesOnCanvas()
  await app.click('罫線を検出')
  await app.waitIdle()
  check('罫線を検出し直しても、丸数字の丸は残る', circleCount > 0 && (await circlesOnCanvas()) === circleCount, `${circleCount} → ${await circlesOnCanvas()}`)
  await app.evaluate(`document.querySelector('button[title^="元に戻す"]').click()`)
  await app.sleep(300)

  // 2. パネルで横書きの Text を縦書きに切り替え、Undo で戻す
  const horizontal = textsOf(page).find((text) => text.writingMode !== 'vertical' && [...text.text].length >= 3)
  await app.evaluate(`(() => { const el = document.querySelector('.object-list input[type=text]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(horizontal.text)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await app.sleep(300)
  await app.evaluate(`document.querySelector('.object-list .object-row').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await app.sleep(300)
  const before = await app.evaluate(`document.querySelectorAll('svg text tspan').length`)
  await app.evaluate(`(() => { const el = document.querySelector('select[data-field=writingMode]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'vertical'); el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await app.sleep(300)
  const after = await app.evaluate(`document.querySelectorAll('svg text tspan').length`)
  check('パネルで縦書きに切り替えられる', after === before + [...horizontal.text].length, `「${horizontal.text}」 tspan ${before} → ${after}`)
  await app.evaluate(`document.querySelector('button[title^="元に戻す"]').click()`)
  await app.sleep(300)
  check('Undo で横書きに戻る', (await app.evaluate(`document.querySelectorAll('svg text tspan').length`)) === before)

  // 3. 修正ファイルで縦書きの Text を追加する(枠に合わせて配置)
  writeFileSync(
    corrections,
    JSON.stringify({
      version: 1,
      operations: [
        { op: 'add', text: { text: '（単位は円）', writingMode: 'vertical', fitBox: [20, 600, 27, 660] } },
        { op: 'add', text: { text: '縦', writingMode: 'sideways', x: 1, y: 2, fontSize: 3 } }
      ]
    })
  )
  await app.click('修正を取り込む')
  await app.waitIdle()
  const dialog = await app.evaluate(`document.querySelector('.modal')?.innerText.replace(/\\n+/g, ' / ') ?? ''`)
  check('修正ファイルの縦書きを受け付け、不正な値は飛ばす', /追加\t1 件/.test(dialog) && /適用できない\t1 件/.test(dialog) && /writingMode/.test(dialog), dialog.slice(0, 160))
  await app.evaluate(`document.querySelector('.modal button.primary').click()`)
  await app.sleep(400)
  await app.click('保存')
  await app.waitIdle()
  await app.sleep(500)
  page = pageOf().page
  const added = textsOf(page).find((text) => text.text === '（単位は円）')
  const length = added ? 6 * added.fontSize + 5 * added.letterSpacing : 0
  check(
    '枠に合わせた縦書きの配置になる',
    !!added && added.writingMode === 'vertical' && Math.abs(added.transform[4] - 23.5) < 0.01 && added.fontSize > 5 && added.fontSize < 9 && length > 55 && length < 66,
    added ? `${added.fontSize}pt 字間 ${added.letterSpacing} 原点 (${added.transform[4]}, ${added.transform[5]}) 長さ ${length.toFixed(1)}` : 'なし'
  )

  // 4. 出力: PDF / SVG / JSON に縦書きが入り、検証が動く
  await app.click('全件確定')
  await app.sleep(400)
  await app.click('出力')
  await app.waitIdle()
  const info = await app.info()
  const dir = join(project, 'exports', pageOf().manifest.pages[0].id)
  const svg = readFileSync(join(dir, 'page-0002.svg'), 'utf8')
  const json = readJson(join(dir, 'output.json'))
  check('出力と検証が動く', /再現率/.test(info) && (await app.error()) === '', info.replace(project, '<project>').slice(-90))
  check('SVG に縦書きの Text が入る', (svg.match(/data-writing-mode="vertical"/g) ?? []).length === vertical.length + 1 && /font-feature-settings: 'vert'/.test(svg))
  check('JSON に writingMode が入る', json.pages[0].objects.filter((object) => object.writingMode === 'vertical').length === vertical.length + 1)

  // 5. 確認用データも縦書きを扱える
  await app.click('確認用データ')
  await app.waitIdle()
  const review = readJson(join(dir, 'review', 'page-0002-review.json'))
  check('確認用データに縦書きが入る', (await app.error()) === '' && review.texts.filter((text) => text.writingMode === 'vertical').length === vertical.length + 1, (await app.info()).replace(project, '<project>').slice(-110))
  if (shots) await app.screenshot(join(shots, 'vertical-final.png'))
  check('コンソールエラーがない', app.consoleErrors.length === 0, app.consoleErrors.join(' / '))
  console.log('     出力先:', dir)
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
