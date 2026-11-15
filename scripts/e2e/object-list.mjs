// オブジェクト一覧(A-01)の確認: 一覧の表示、選択と移動、表示/非表示、絞り込み、保存して開き直し、出力への影響なし。
//   node scripts/e2e/object-list.mjs <プロジェクトフォルダ> [スクリーンショットの出力先フォルダ]
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const [source, shots] = process.argv.slice(2)
if (!source) {
  console.error('使い方: node scripts/e2e/object-list.mjs <プロジェクトフォルダ> [スクリーンショットの出力先]')
  process.exit(2)
}
const work = mkdtempSync(join(tmpdir(), 'pdfpe-object-list-'))
const project = join(work, 'project')
cpSync(resolve(source), project, { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const open = async (app) => {
  await app.click('プロジェクトを開く')
  await app.waitIdle()
  await app.waitLoaded()
}
const count = (app, selector) => app.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
const layerRows = (app) => app.evaluate(`[...document.querySelectorAll('.object-list .layer-row')].map((r) => r.querySelector('.content').textContent + ' ' + r.querySelector('.count').textContent).join(' | ')`)
const metrics = (info) => (info.match(/p\.\d+: .*$/) ?? [''])[0]

let app = await launch({ env: { E2E_PROJECT: project, E2E_MESSAGE: '1' } })
try {
  await open(app)
  // 背景レイヤーの行は一覧の末尾にあり、スクロールするまで描かれない
  check('一覧にレイヤーが並ぶ', /確定オブジェクト \d+ \| 自動抽出の候補 \d+/.test(await layerRows(app)), await layerRows(app))
  const drawn = await count(app, '.object-list .object-row')
  check('表示している行だけを描く(仮想スクロール)', drawn > 5 && drawn < 120, `${drawn} 行`)
  const texts = await count(app, 'svg [data-layer-kind=candidates] text')
  const paths = await count(app, 'svg [data-layer-kind=candidates] [data-object-id]')

  // 行を押すと選択される
  await app.evaluate(`document.querySelectorAll('.object-list .object-row')[3].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await app.sleep(200)
  check('行を押すと選択される', /選択: /.test(await app.statusBar()) && (await count(app, '.object-list .object-row.selected')) === 1, (await app.statusBar()).slice(0, 110))

  // 1件を非表示にする → キャンバスから消え、選択も外れる
  await app.evaluate(`document.querySelector('.object-list .object-row.selected .eye').click()`)
  await app.sleep(200)
  check('非表示にするとキャンバスから消え、選択が外れる', (await count(app, 'svg [data-layer-kind=candidates] [data-object-id]')) === paths - 1 && !/選択/.test(await app.statusBar()))
  await app.evaluate(`document.querySelector('button[title^="元に戻す"]').click()`)
  await app.sleep(200)
  check('Undo で表示に戻る', (await count(app, 'svg [data-layer-kind=candidates] [data-object-id]')) === paths)

  // Text だけに絞り込んで、まとめて非表示
  await app.click('Path')
  await app.click('Image')
  await app.sleep(200)
  check('種別で絞り込める', /絞り込み \d+ 件/.test(await app.evaluate(`document.querySelector('.object-list .bulk .hint').textContent`)), await layerRows(app))
  await app.evaluate(`[...document.querySelectorAll('.object-list .bulk button')].find((b) => b.textContent.trim() === '非表示').click()`)
  await app.sleep(300)
  check('絞り込んだ Text をまとめて非表示にできる', (await count(app, 'svg [data-layer-kind=candidates] text')) === 0 && texts > 0, `Text ${texts} → 0`)
  if (shots) await app.screenshot(join(shots, 'object-list-text-hidden.png'))

  // 文字列で検索
  await app.click('解除')
  await app.evaluate(`(() => { const el = document.querySelector('.object-list input[type=text]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'G44'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await app.sleep(200)
  const found = await app.evaluate(`[...document.querySelectorAll('.object-list .object-row .content')].map((c) => c.textContent).join(',')`)
  check('文字列で検索できる', found.split(',').includes('G44'), found)
  await app.click('解除')

  // 非表示のまま出力しても、件数と数値は変わらない
  await app.click('全件確定')
  await app.sleep(400)
  await app.click('出力')
  await app.waitIdle()
  const hiddenExport = metrics(await app.info())
  await app.click('保存')
  await app.waitIdle()
  await app.sleep(500)
  check('保存できる', !(await app.title()).startsWith('●'), await app.title())
} finally {
  await app.close()
}

const saved = JSON.parse(readFileSync(join(project, 'document.json'), 'utf8'))
const all = saved.pages[0].layers.flatMap((layer) => layer.objects)
const hiddenCount = all.filter((object) => object.visible === false).length
check('非表示の状態が document.json に保存される', hiddenCount > 0 && all.filter((o) => o.type === 'text' && o.visible !== false).length <= 1, `非表示 ${hiddenCount} 件`)
const exported = JSON.parse(readFileSync(join(project, 'exports/output.json'), 'utf8'))
check('JSON 出力に visible を含めず、非表示のものも出力する', exported.pages[0].objects.length >= hiddenCount && exported.pages[0].objects.every((object) => !('visible' in object)), `出力 ${exported.pages[0].objects.length} 件`)

// 開き直して、非表示が残っていること。全部表示に戻して出力し、数値が同じこと
app = await launch({ env: { E2E_PROJECT: project, E2E_MESSAGE: '1' } })
try {
  await open(app)
  check('開き直しても非表示が残る', (await count(app, 'svg [data-layer-kind=confirmed] text')) <= 1)
  const before = JSON.parse(readFileSync(join(project, 'exports/verify.json'), 'utf8')).pages[0].metrics
  await app.evaluate(`[...document.querySelectorAll('.object-list .bulk button')].find((b) => b.textContent.trim() === '表示').click()`)
  await app.sleep(300)
  check('まとめて表示に戻せる', (await count(app, 'svg [data-layer-kind=confirmed] text')) > 100)
  await app.click('出力')
  await app.waitIdle()
  const after = JSON.parse(readFileSync(join(project, 'exports/verify.json'), 'utf8')).pages[0].metrics
  check('表示/非表示で出力の数値が変わらない', before.recall === after.recall && before.excess === after.excess && before.outputInk === after.outputInk, `再現率 ${before.recall.toFixed(4)} / ${after.recall.toFixed(4)}`)
  if (shots) await app.screenshot(join(shots, 'object-list.png'))
  check('コンソールエラーがない', app.consoleErrors.length === 0, app.consoleErrors.join(' / '))
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
