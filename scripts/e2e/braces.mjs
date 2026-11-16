// 波括弧の検出の確認。
//   node scripts/e2e/braces.mjs <PDF> <波括弧のあるページ 例: 13> [スクリーンショットの出力先フォルダ]
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const [pdfArg, pageArg, shotsArg] = process.argv.slice(2)
if (!pdfArg || !pageArg) {
  console.error('使い方: node scripts/e2e/braces.mjs <PDF> <ページ> [スクリーンショットの出力先]')
  process.exit(2)
}
const shots = shotsArg ? resolve(shotsArg) : null
if (shots) mkdirSync(shots, { recursive: true })
const project = join(mkdtempSync(join(tmpdir(), 'pdfpe-braces-')), 'project')
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
  await app.click('罫線を検出')
  await app.waitIdle()
  await app.sleep(500)
  const info = await app.info()
  const count = Number(info.match(/波括弧 (\d+) 個/)?.[1] ?? -1)
  check('罫線の検出で波括弧が見つかる', count > 0, info)

  await app.click('保存')
  await app.waitIdle()
  await app.sleep(500)
  const pagesDir = join(project, 'pages')
  const page = JSON.parse(readFileSync(join(pagesDir, readdirSync(pagesDir).find((name) => name.endsWith('.json'))), 'utf8'))
  const objects = page.layers.find((layer) => layer.kind === 'candidates').objects
  const braces = objects.filter((object) => object.meta?.source === 'brace-detect')
  for (const brace of braces) {
    const [hook, top, , tip, , bottom] = brace.nodes
    console.log(`     ${tip.x > top.x ? '｝' : '｛'} 縦の線 x ${top.x} / ${top.y} 〜 ${bottom.y}(高さ ${(top.y - bottom.y).toFixed(1)}pt) かぎ ${(hook.x - top.x).toFixed(2)} 突起 ${(tip.x - top.x).toFixed(2)} 線幅 ${brace.strokeWidth}`)
  }
  check('波括弧は7頂点の折れ線で、図形の印が付く', braces.length === count && braces.every((brace) => brace.nodes.length === 7 && !brace.closed && brace.meta.shape?.kind === 'brace'))
  // 縦の線と重なる罫線の候補が残っていない
  const doubled = objects.filter(
    (object) =>
      object.type === 'path' &&
      object.role === 'frame' &&
      object.nodes.length === 2 &&
      braces.some((brace) => object.nodes.every((node) => Math.abs(node.x - brace.nodes[1].x) < 1 && node.y <= brace.nodes[1].y + 1 && node.y >= brace.nodes[5].y - 1))
  )
  check('縦の線と重なる罫線の候補が残っていない', doubled.length === 0, `${doubled.length} 本`)

  await app.evaluate(`[...document.querySelectorAll('.sidebar .tabs button')].find((b) => b.textContent.trim().startsWith('Shape')).click()`)
  await app.sleep(200)
  const listed = await app.evaluate(`[...document.querySelectorAll('.shape-list > ul > li')].map((li) => li.querySelector('.kind-header .label').textContent + ':' + li.querySelectorAll('li').length).join(' / ')`)
  check('Shape タブに波括弧が出る', listed.includes(`波括弧:${count}`), listed)
  if (shots) await app.screenshot(join(shots, 'braces.png'))
  check('エラーが出ていない', (await app.error()) === '' && app.consoleErrors.length === 0, `${await app.error()} ${app.consoleErrors.join(' / ')}`)
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
