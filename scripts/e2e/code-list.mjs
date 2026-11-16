// 左パネルのタブと、項目コードの一覧の確認。
//   node scripts/e2e/code-list.mjs <項目コードを割り当て済みのプロジェクトフォルダ> [スクリーンショットの出力先フォルダ]
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const source = process.argv[2]
const shots = process.argv[3] ? resolve(process.argv[3]) : null
if (!source) {
  console.error('使い方: node scripts/e2e/code-list.mjs <プロジェクトフォルダ> [スクリーンショットの出力先]')
  process.exit(2)
}
if (shots) mkdirSync(shots, { recursive: true })
const project = join(mkdtempSync(join(tmpdir(), 'pdfpe-codes-')), 'project')
cpSync(resolve(source), project, { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const app = await launch({ env: { E2E_PROJECT: project, E2E_MESSAGE: '1' } })
try {
  await app.click('プロジェクトを開く')
  await app.waitIdle()
  await app.waitLoaded()
  const tabs = () => app.evaluate(`[...document.querySelectorAll('.sidebar .tabs button')].map((b) => b.textContent.trim() + (b.classList.contains('active') ? '*' : '')).join(' | ')`)
  const shownBodies = () => app.evaluate(`[...document.querySelectorAll('.sidebar .tab-body')].map((b) => !b.hidden && b.getBoundingClientRect().height > 50).join(',')`)
  const tab = (label) => app.evaluate(`[...document.querySelectorAll('.sidebar .tabs button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`)
  const rows = () => app.evaluate(`document.querySelectorAll('.code-list li').length`)

  check('左パネルに4つのタブがあり、最初はオブジェクトの一覧', /^ページ \d+ \| オブジェクト\* \| コード \d+ \| Shape \d+$/.test(await tabs()) && (await shownBodies()) === 'false,true,false,false', await tabs())
  check('右パネルに項目コードの一覧がない', !(await app.evaluate(`!!document.querySelector('.panel .code-list')`)))

  await tab('ページ')
  await app.sleep(200)
  check('ページのタブに切り替わる', (await shownBodies()) === 'true,false,false,false' && (await app.evaluate(`document.querySelectorAll('.page-tree .page-row').length`)) > 0)
  if (shots) await app.screenshot(join(shots, 'tab-pages.png'))

  await tab('コード')
  await app.sleep(200)
  const total = Number((await tabs()).match(/コード (\d+)\*/)?.[1] ?? -1)
  check('項目コードのタブに、コードの数だけ行が出る', (await shownBodies()) === 'false,false,true,false' && total > 0 && (await rows()) === total, `${total} 件`)

  // 行を押すと、そのコードのオブジェクトが選択される
  const picked = await app.evaluate(`(() => { const b = document.querySelectorAll('.code-list li button')[4]; b.click(); return b.querySelector('.code').textContent + ':' + b.querySelector('.count').textContent })()`)
  await app.sleep(300)
  const [code, count] = picked.split(':')
  const status = await app.statusBar()
  check('行を押すと、そのコードのオブジェクトが選択される', Number(count) > 1 ? status.includes(`選択 ${count} 件`) : status.includes(`[${code}]`), `${picked} / ${status.slice(0, 80)}`)
  check('選択したコードの行が強調される', (await app.evaluate(`[...document.querySelectorAll('.code-list li button.active .code')].map((c) => c.textContent).join(',')`)) === code)
  check('キャンバスに同じコードの選択の枠が出る', (await app.evaluate(`document.querySelectorAll('.selection-outline').length`)) >= Number(count))
  if (shots) await app.screenshot(join(shots, 'tab-codes.png'))

  // 不足ありだけに絞る
  const incomplete = Number((await app.evaluate(`[...document.querySelectorAll('.code-list .chip')][1].textContent`)).match(/(\d+)/)[1])
  await app.evaluate(`[...document.querySelectorAll('.code-list .chip')][1].click()`)
  await app.sleep(200)
  check('不足ありのコードだけに絞れる', (await rows()) === incomplete && (await app.evaluate(`[...document.querySelectorAll('.code-list li')].every((li) => li.querySelector('.flag.missing'))`)), `${incomplete} 件`)
  await app.evaluate(`[...document.querySelectorAll('.code-list .chip')][0].click()`)

  // 未付与をまとめて選択する
  const untagged = (await app.evaluate(`document.querySelector('.code-list .bulk .hint').textContent`)).match(/Text (\d+) \/ 記入欄 (\d+)/)
  const untaggedTotal = Number(untagged[1]) + Number(untagged[2])
  await app.evaluate(`[...document.querySelectorAll('.code-list .bulk button')].find((b) => b.textContent.trim() === '選択').click()`)
  await app.sleep(300)
  check('未付与の Text と記入欄をまとめて選択できる', untaggedTotal > 0 && (await app.statusBar()).includes(`選択 ${untaggedTotal} 件`), `Text ${untagged[1]} / 記入欄 ${untagged[2]}`)
  await app.evaluate(`document.querySelector('.code-list .bulk input[type=checkbox]').click()`)
  await app.sleep(200)
  check('未付与の強調を切り替えられる', (await app.evaluate(`document.querySelectorAll('.highlight-untagged').length`)) === untaggedTotal)

  // 一覧の下のほうのコードを選ぶと、その行まで動く
  await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await app.evaluate(`document.querySelector('.code-list ul').scrollTop = 0`)
  await app.evaluate(`[...document.querySelectorAll('.code-list li button')].at(-1).click()`)
  await app.sleep(200)
  await app.evaluate(`document.querySelector('.code-list ul').scrollTop = 0`)
  await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await app.sleep(200)
  await app.evaluate(`[...document.querySelectorAll('.code-list li button')].at(-1).click()`)
  await app.sleep(300)
  const visible = await app.evaluate(`(() => { const ul = document.querySelector('.code-list ul').getBoundingClientRect(); const b = document.querySelector('.code-list li button.active').getBoundingClientRect(); return b.top >= ul.top - 1 && b.bottom <= ul.bottom + 1 })()`)
  check('選択したコードの行が見える位置まで動く', visible)
  check('コンソールエラーがない', app.consoleErrors.length === 0, app.consoleErrors.join(' / '))
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
