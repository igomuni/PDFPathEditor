// マウスドラッグでの移動の確認。
//   node scripts/e2e/drag-move.mjs <プロジェクトフォルダ>
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const source = process.argv[2]
if (!source) {
  console.error('使い方: node scripts/e2e/drag-move.mjs <プロジェクトフォルダ>')
  process.exit(2)
}
const project = join(mkdtempSync(join(tmpdir(), 'pdfpe-drag-')), 'project')
cpSync(resolve(source), project, { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance

const app = await launch({ env: { E2E_PROJECT: project, E2E_MESSAGE: '1' } })
try {
  await app.click('プロジェクトを開く')
  await app.waitIdle()
  await app.waitLoaded()
  const box = () =>
    app.evaluate(`(() => { const r = document.querySelector('rect.selection-outline')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null })()`)
  const undo = () => app.evaluate(`document.querySelector('button[title^="元に戻す"]').click()`)
  const drag = async (from, to, extra = {}) => {
    await app.mouse('mousePressed', from.x, from.y)
    for (let i = 1; i <= 8; i++) {
      await app.mouse('mouseMoved', from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8, extra)
    }
    await app.mouse('mouseReleased', to.x, to.y, extra)
    await app.sleep(250)
  }

  // 追加した Text は表示の中央にあり、選択されている
  await app.evaluate(`[...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.trim() === 'テキストを追加').click()`)
  await app.sleep(300)
  const start = await box()
  check('追加した Text が選択されている', start !== null)
  const grab = { x: start.x + start.w / 2, y: start.y + start.h / 2 }

  // ドラッグ: 画面上で (60, 35) 動く
  await drag(grab, { x: grab.x + 60, y: grab.y + 35 })
  const moved = await box()
  check('ドラッグで動く', near(moved.x - start.x, 60) && near(moved.y - start.y, 35), `(${(moved.x - start.x).toFixed(1)}, ${(moved.y - start.y).toFixed(1)})`)

  // 1回のドラッグは1つの履歴
  await undo()
  await app.sleep(250)
  const back = await box()
  check('ドラッグ1回を Undo 1回で戻せる', near(back.x, start.x, 0.2) && near(back.y, start.y, 0.2), `(${(back.x - start.x).toFixed(2)}, ${(back.y - start.y).toFixed(2)})`)

  // Shift: 動きの大きいほうの軸に固定
  await drag(grab, { x: grab.x + 50, y: grab.y + 12 }, { modifiers: 8 })
  const constrained = await box()
  check('Shift で水平に固定される', near(constrained.x - start.x, 50) && near(constrained.y, start.y, 0.2), `(${(constrained.x - start.x).toFixed(1)}, ${(constrained.y - start.y).toFixed(1)})`)
  await undo()
  await app.sleep(250)

  // 動かさずに離すと、移動しない(履歴も増えない)
  await drag(grab, { x: grab.x + 1, y: grab.y + 1 })
  const still = await box()
  check('小さな動きはクリックとして扱う', near(still.x, start.x, 0.2) && near(still.y, start.y, 0.2))

  // 選択していないものをつかむと、それを選択して動かす
  await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await app.sleep(200)
  check('Esc で選択を解除できる', (await box()) === null)
  await drag(grab, { x: grab.x - 30, y: grab.y - 20 })
  const regrab = await box()
  check('選択していないものをつかんで動かせる', regrab !== null && near(regrab.x - start.x, -30) && near(regrab.y - start.y, -20), regrab ? `(${(regrab.x - start.x).toFixed(1)}, ${(regrab.y - start.y).toFixed(1)})` : '選択なし')
  check('コンソールエラーがない', app.consoleErrors.length === 0, app.consoleErrors.join(' / '))
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
