// QRコードの検出、様式ID の役割付け、範囲の切り出し、Image の出力の確認。
//   node scripts/e2e/qr-image.mjs <文字を検出済みのプロジェクトフォルダ> [スクリーンショットの出力先フォルダ]
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const source = process.argv[2]
const shots = process.argv[3] ? resolve(process.argv[3]) : null
if (!source) {
  console.error('使い方: node scripts/e2e/qr-image.mjs <プロジェクトフォルダ> [スクリーンショットの出力先]')
  process.exit(2)
}
if (shots) mkdirSync(shots, { recursive: true })
const project = join(mkdtempSync(join(tmpdir(), 'pdfpe-qr-')), 'project')
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
  const counts = async () => {
    const m = (await app.statusBar()).match(/候補 (\d+) 件 \/ 確定 (\d+) 件/)
    return { candidates: Number(m[1]), confirmed: Number(m[2]) }
  }
  const press = (label) => app.evaluate(`[...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  const images = () =>
    app.evaluate(`[...document.querySelectorAll('g[data-layer-kind]:not([data-layer-kind=background]) g[data-object-id] image')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })`)
  const before = await counts()

  // QRコードと様式ID
  await press('QR・様式ID')
  await app.waitIdle()
  await app.sleep(600)
  const info = await app.info()
  const found = await images()
  check('QRコードを1個見つけ、Image の候補になる', /QRコード 1 個/.test(info) && (await counts()).candidates === before.candidates + 1 && found.length === 1, info)
  check('切り出した範囲がほぼ正方形', found.length === 1 && Math.abs(found[0].w - found[0].h) < 2 && found[0].w > 10, found.map((r) => `${r.w.toFixed(1)}×${r.h.toFixed(1)}`).join(','))
  check('様式ID の Text に役割が付く', /様式ID 1 件/.test(info), info)
  if (shots) await app.screenshot(join(shots, 'qr-detected.png'))

  // 確定して出力すると、PDF と SVG に画像が入る
  await press('選択を確定')
  await app.sleep(300)
  check('QR を確定できる', (await counts()).confirmed >= before.confirmed + 1)
  await press('出力')
  await app.waitIdle()
  const exportInfo = await app.info()
  const exportsDir = join(project, 'exports')
  const pageDir = existsSync(exportsDir) ? readdirSync(exportsDir).map((name) => join(exportsDir, name)).find((dir) => existsSync(join(dir, 'output.json'))) : null
  const svgFile = pageDir ? readdirSync(pageDir).find((name) => name.endsWith('.svg')) : null
  const svg = svgFile ? readFileSync(join(pageDir, svgFile), 'utf8') : ''
  const json = pageDir ? JSON.parse(readFileSync(join(pageDir, 'output.json'), 'utf8')) : null
  check('SVG に QR の画像が埋め込まれる', /<image [^>]*data-role="qr"[^>]*href="data:image\/png;base64,/.test(svg), exportInfo.slice(0, 160))
  const exported = json?.pages[0].objects ?? []
  check('JSON に QR(image)と様式ID(formId)が出る', exported.some((o) => o.type === 'image' && o.role === 'qr') && exported.some((o) => o.type === 'text' && o.role === 'formId'), exported.filter((o) => o.role === 'formId').map((o) => o.text).join(','))
  const pdf = pageDir ? readFileSync(join(pageDir, 'output.pdf')).toString('latin1') : ''
  check('PDF に画像が入る', /\/Subtype \/Image/.test(pdf))

  // もう一度検出しても、確定済みの QR は増えない
  const middle = await counts()
  await press('QR・様式ID')
  await app.waitIdle()
  await app.sleep(600)
  check('確定済みの QR は、検出し直しても増えない', (await counts()).candidates === middle.candidates && /確定済み/.test(await app.info()), await app.info())

  // 範囲を指定して切り出す
  await press('画像を切り出す')
  await app.sleep(200)
  check('切り出しのモードに入る', (await app.evaluate(`document.querySelector('.canvas').style.cursor`)) === 'crosshair')
  const canvas = await app.evaluate(`(() => { const r = document.querySelector('.canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  const from = { x: canvas.x + canvas.w / 2 - 40, y: canvas.y + canvas.h / 2 - 30 }
  await app.mouse('mousePressed', from.x, from.y)
  for (let i = 1; i <= 6; i++) await app.mouse('mouseMoved', from.x + (80 * i) / 6, from.y + (60 * i) / 6)
  await app.mouse('mouseReleased', from.x + 80, from.y + 60)
  await app.waitIdle()
  await app.sleep(600)
  const cropped = (await images()).find((r) => Math.abs(r.w - 80) < 3 && Math.abs(r.h - 60) < 3)
  check('ドラッグした範囲が Image になる', (await counts()).candidates === middle.candidates + 1 && !!cropped && Math.abs(cropped.x - from.x) < 2 && Math.abs(cropped.y - from.y) < 2, cropped ? `${cropped.w.toFixed(1)}×${cropped.h.toFixed(1)}` : JSON.stringify(await images()))
  check('切り出したらモードを抜け、Image が選択される', (await app.evaluate(`document.querySelector('.canvas').style.cursor`)) !== 'crosshair' && (await app.evaluate(`document.querySelectorAll('rect.selection-outline').length`)) === 1)
  if (shots) await app.screenshot(join(shots, 'qr-cropped.png'))
  check('エラーが出ていない', (await app.error()) === '' && app.consoleErrors.length === 0, `${await app.error()} ${app.consoleErrors.join(' / ')}`)
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
