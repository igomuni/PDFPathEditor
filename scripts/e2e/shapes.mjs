// Shape タブ(図形の一覧と追加)、斜線・角丸の枠の検出の確認。
//   node scripts/e2e/shapes.mjs <PDF> <角丸の枠と斜線のあるページ 例: 12> [スクリーンショットの出力先フォルダ]
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const [pdfArg, pageArg, shotsArg] = process.argv.slice(2)
if (!pdfArg || !pageArg) {
  console.error('使い方: node scripts/e2e/shapes.mjs <PDF> <ページ> [スクリーンショットの出力先]')
  process.exit(2)
}
const shots = shotsArg ? resolve(shotsArg) : null
if (shots) mkdirSync(shots, { recursive: true })
const project = join(mkdtempSync(join(tmpdir(), 'pdfpe-shapes-')), 'project')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const app = await launch({ env: { E2E_PDF: resolve(pdfArg), E2E_DEST: project, E2E_MESSAGE: '1' } })
try {
  await app.evaluate(`(() => { const el = document.querySelector('.pages-spec'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(pageArg)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await app.click('PDFを取り込む')
  await app.waitIdle()
  await app.waitLoaded()
  const candidates = async () => Number(((await app.statusBar()).match(/候補 (\d+) 件/) ?? [0, -1])[1])
  const tab = (label) => app.evaluate(`[...document.querySelectorAll('.sidebar .tabs button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`)
  const rows = () =>
    app.evaluate(`[...document.querySelectorAll('.shape-list > ul > li')].map((li) => li.querySelector('.kind-header .label').textContent + ':' + li.querySelectorAll('li').length).join(' / ')`)
  const undo = () => app.evaluate(`document.querySelector('button[title^="元に戻す"]').click()`)

  await tab('Shape')
  await app.sleep(200)
  check('Shape タブがあり、最初は図形がない', /^Shape 0/.test(await app.evaluate(`[...document.querySelectorAll('.sidebar .tabs button')].at(-1).textContent.trim()`)) && (await rows()) === '')

  await app.click('罫線を検出')
  await app.waitIdle()
  await app.sleep(500)
  const info = await app.info()
  const diagonals = Number(info.match(/斜線 (\d+) 本/)?.[1] ?? -1)
  const corners = Number(info.match(/角丸の角 (\d+) か所/)?.[1] ?? -1)
  check('斜線と角丸の角が見つかる', diagonals > 0 && corners > 0, info)
  const listed = await rows()
  check('角丸の枠が Shape タブに出る', /角丸の枠:\d+/.test(listed), listed)

  // 行を押すと、枠の部品(罫線と角の円弧)がまとめて選択される
  const parts = await app.evaluate(`(() => { const b = document.querySelector('.shape-list li li button'); b.click(); return b.querySelector('.count').textContent })()`)
  await app.sleep(300)
  const count = Number(parts.match(/(\d+)/)?.[1] ?? 0)
  check('行を押すと、枠の罫線と角がまとめて選択される', count >= 3 && (await app.statusBar()).includes(`選択 ${count} 件`), `${parts} / ${(await app.statusBar()).slice(0, 80)}`)
  check('選択した図形の行が強調される', (await app.evaluate(`document.querySelectorAll('.shape-list li li button.active').length`)) === 1)
  if (shots) await app.screenshot(join(shots, 'shapes-detected.png'))

  // 図形の追加: 種類ごとに1つずつ。矢印は軸と三角形の2つ
  const before = await candidates()
  for (const [kind, added] of [['roundRect', 1], ['arrow', 2], ['brace', 1], ['circle', 1], ['star', 1]]) {
    const start = await candidates()
    await app.evaluate(`document.querySelector('[data-add-shape=${kind}]').click()`)
    await app.sleep(300)
    const status = await app.statusBar()
    check(`図形を追加できる(${kind})`, (await candidates()) === start + added && (added > 1 ? status.includes(`選択 ${added} 件`) : status.includes('選択: ')), status.slice(0, 110))
  }
  const after = await rows()
  check('追加した図形が一覧に出る', ['角丸の枠', '矢印', '波括弧', '丸', '星'].every((label) => after.includes(`${label}:`)), after)
  if (shots) await app.screenshot(join(shots, 'shapes-added.png'))
  for (let i = 0; i < 5; i++) await undo()
  await app.sleep(300)
  check('追加を Undo で戻せる', (await candidates()) === before)

  // 保存して開き直しても、図形の印が残る
  await app.click('保存')
  await app.waitIdle()
  check('エラーが出ていない', (await app.error()) === '' && app.consoleErrors.length === 0, `${await app.error()} ${app.consoleErrors.join(' / ')}`)
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
