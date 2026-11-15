// キャンバスの上での文字列の編集、Text の分離・結合、右クリックのメニューの確認。
//   node scripts/e2e/text-edit.mjs <プロジェクトフォルダ>
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const source = process.argv[2]
if (!source) {
  console.error('使い方: node scripts/e2e/text-edit.mjs <プロジェクトフォルダ>')
  process.exit(2)
}
const project = join(mkdtempSync(join(tmpdir(), 'pdfpe-textedit-')), 'project')
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
  const candidates = async () => Number(((await app.statusBar()).match(/候補 (\d+) 件/) ?? [0, -1])[1])
  const boxes = () =>
    app.evaluate(`[...document.querySelectorAll('rect.selection-outline')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }).sort((a, b) => a.x - b.x)`)
  const press = (label) =>
    app.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  const undo = () => app.evaluate(`document.querySelector('button[title^="元に戻す"]').click()`)
  const editorExists = () => app.evaluate(`!!document.querySelector('.text-editor input')`)
  const typeInEditor = (value) =>
    app.evaluate(`(() => { const el = document.querySelector('.text-editor input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const key = (keyName, extra = '') =>
    app.evaluate(`document.querySelector('.text-editor input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(keyName)}, bubbles: true${extra} }))`)
  const doubleClick = async (x, y) => {
    await app.mouse('mousePressed', x, y)
    await app.mouse('mouseReleased', x, y)
    await app.mouse('mousePressed', x, y, { clickCount: 2 })
    await app.mouse('mouseReleased', x, y, { clickCount: 2 })
    await app.sleep(250)
  }
  const rightClick = async (x, y) => {
    await app.mouse('mousePressed', x, y, { button: 'right', buttons: 2 })
    await app.mouse('mouseReleased', x, y, { button: 'right', buttons: 0 })
    await app.sleep(250)
  }
  const menuLabels = () => app.evaluate(`[...document.querySelectorAll('.context-menu > ul > li > button')].map((b) => b.querySelector('.label').textContent + (b.disabled ? '(不可)' : ''))`)
  const menuClick = (label) =>
    app.evaluate(`[...document.querySelectorAll('.context-menu button')].find((b) => b.querySelector('.label').textContent === ${JSON.stringify(label)}).click()`)

  const before = await candidates()
  await press('テキストを追加')
  await app.sleep(300)
  const [start] = await boxes()
  const grab = { x: start.x + start.w / 2, y: start.y + start.h / 2 }

  // ダブルクリックで編集を始め、Enter で確定する
  await doubleClick(grab.x, grab.y)
  check('ダブルクリックで、その場に入力欄が出る', await editorExists())
  await typeInEditor('収入金額等')
  await key('Enter')
  await app.sleep(250)
  check('Enter で文字列が確定する', /テキスト「収入金額等」/.test(await app.statusBar()) && !(await editorExists()), (await app.statusBar()).slice(0, 90))
  const [whole] = await boxes()

  // Esc は取り消し
  await press('その場で編集')
  await app.sleep(250)
  await typeInEditor('別の文字')
  await key('Escape')
  await app.sleep(250)
  check('Esc で編集を取り消せる', /テキスト「収入金額等」/.test(await app.statusBar()) && !(await editorExists()))

  // 選択した範囲で3つに分ける
  await press('その場で編集')
  await app.sleep(250)
  await app.evaluate(`document.querySelector('.text-editor input').setSelectionRange(2, 4)`)
  await press('選択範囲で分離')
  await app.sleep(300)
  const parts = await boxes()
  check('選択した範囲で3つに分かれる', (await candidates()) === before + 3 && /選択 3 件/.test(await app.statusBar()), await app.statusBar())
  check(
    '分けた後も字の位置が変わらない',
    parts.length === 3 && near(parts[0].x, whole.x) && near(parts[2].x + parts[2].w, whole.x + whole.w) && near(parts[1].x, parts[0].x + parts[0].w, 2),
    parts.map((p) => `${p.x.toFixed(1)}+${p.w.toFixed(1)}`).join(' / ') + ` (元 ${whole.x.toFixed(1)}+${whole.w.toFixed(1)})`
  )

  // 結合すると元の1つに戻る
  await press('結合')
  await app.sleep(300)
  const [merged] = await boxes()
  check('結合で1つに戻る', (await candidates()) === before + 1 && /テキスト「収入金額等」/.test(await app.statusBar()), (await app.statusBar()).slice(0, 90))
  check('結合した後の位置と幅が元と同じ', near(merged.x, whole.x) && near(merged.w, whole.w), `${merged.x.toFixed(1)}+${merged.w.toFixed(1)}`)

  // 1字ずつに分ける。Undo 1回で戻る
  await press('1字ずつに分離')
  await app.sleep(300)
  check('1字ずつに分かれる', (await candidates()) === before + 5 && /選択 5 件/.test(await app.statusBar()))
  await undo()
  await app.sleep(250)
  check('分離を Undo 1回で戻せる', (await candidates()) === before + 1)

  // 右クリック: オブジェクトの上
  const [target] = await boxes()
  await rightClick(target.x + target.w / 2, target.y + target.h / 2)
  const labels = (await menuLabels()) ?? []
  check('右クリックでメニューが出る', labels.includes('文字列を編集') && labels.includes('複製') && labels.includes('役割') && labels.includes('テキストを結合(不可)'), labels.join(', '))
  await menuClick('複製')
  await app.sleep(300)
  check('メニューから複製できる(メニューは閉じる)', (await candidates()) === before + 2 && !(await app.evaluate(`!!document.querySelector('.context-menu')`)))
  await rightClick(target.x + target.w / 2, target.y + target.h / 2)
  await menuClick('様式ID')
  await app.sleep(250)
  await rightClick(target.x + target.w / 2, target.y + target.h / 2)
  const checked = await app.evaluate(`[...document.querySelectorAll('.context-menu .submenu button')].filter((b) => b.querySelector('.check').textContent !== '').map((b) => b.querySelector('.label').textContent).join(',')`)
  check('メニューから役割を変えられる', checked === '様式ID', checked)
  await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await app.sleep(200)
  check('Esc でメニューが閉じる', !(await app.evaluate(`!!document.querySelector('.context-menu')`)))

  // 右クリック: 何もない場所
  await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await app.sleep(200)
  const corner = await app.evaluate(`(() => { const r = document.querySelector('.canvas').getBoundingClientRect(); return { x: r.x + 8, y: r.y + 8 } })()`)
  await rightClick(corner.x, corner.y)
  const emptyLabels = (await menuLabels()) ?? []
  check('何もない場所では、追加と表示の項目だけが出る', emptyLabels[0] === 'テキストをここに追加' && !emptyLabels.includes('複製'), emptyLabels.join(', '))
  const count = await candidates()
  await menuClick('テキストをここに追加')
  await app.sleep(300)
  const [placed] = await boxes()
  check('右クリックした場所にテキストを追加できる', (await candidates()) === count + 1 && placed && near(placed.x, corner.x, 3), placed ? `x ${placed.x.toFixed(1)} (クリック ${corner.x.toFixed(1)})` : '')
  check('コンソールエラーがない', app.consoleErrors.length === 0, app.consoleErrors.join(' / '))
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
