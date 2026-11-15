// プロジェクト構成 v2(A-02)の確認: 旧形式の移行、複数ページ・複数PDFの取り込み、ページ単位の保存。
//   node scripts/e2e/project-v2.mjs <version 1 のプロジェクト> <PDF> [2つ目のPDF]
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const [v1Project, pdf, secondPdf] = process.argv.slice(2).map((arg) => resolve(arg))
if (!v1Project || !pdf) {
  console.error('使い方: node scripts/e2e/project-v2.mjs <version 1 のプロジェクト> <PDF> [2つ目のPDF]')
  process.exit(2)
}
const work = mkdtempSync(join(tmpdir(), 'pdfpe-v2-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const counts = async (app) => ((await app.statusBar()).match(/候補 \d+ 件 \/ 確定 \d+ 件/) ?? ['?'])[0]
const open = async (app) => {
  await app.click('プロジェクトを開く')
  await app.waitIdle()
  await app.waitLoaded()
}
const pageOptions = (app) => app.evaluate(`[...document.querySelectorAll('.page-select option')].map((o) => o.textContent).join(' | ')`)
const selectPage = (app, index) =>
  app.evaluate(`(() => { const el = document.querySelector('.page-select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, el.options[${index}].value); el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
const setPages = (app, spec) =>
  app.evaluate(`(() => { const el = document.querySelector('.pages-spec'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(spec)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)

// ---- 1. 旧形式(version 1)のプロジェクトを開いて保存すると、新しい構成になる
const migrated = join(work, 'migrated')
cpSync(v1Project, migrated, { recursive: true })
const v1 = readJson(join(migrated, 'document.json'))
check('確認に使うプロジェクトが version 1', v1.version === 1)
let app = await launch({ env: { E2E_PROJECT: migrated, E2E_MESSAGE: '1' } })
let before = ''
try {
  await open(app)
  before = await counts(app)
  check('旧形式を開ける(未保存として扱う)', (await app.error()) === '' && (await app.title()).startsWith('●'), `${await app.title()} / ${before}`)
  await app.click('保存')
  await app.waitIdle()
  await app.sleep(500)
  check('保存できる', !(await app.title()).startsWith('●') && (await app.error()) === '', await app.error())
} finally {
  await app.close()
}
const manifest = readJson(join(migrated, 'document.json'))
check('document.json が目次になる', manifest.version === 2 && manifest.sources.length === 1 && manifest.pages.length === 1 && !('layers' in manifest.pages[0]))
check('ページのファイルができる', existsSync(join(migrated, manifest.pages[0].file)) && readJson(join(migrated, manifest.pages[0].file)).layers.length === 3)
check('元の document.json を document.v1.json に残す', existsSync(join(migrated, 'document.v1.json')) && readJson(join(migrated, 'document.v1.json')).version === 1)
app = await launch({ env: { E2E_PROJECT: migrated } })
try {
  await open(app)
  check('開き直して件数が変わらない', (await counts(app)) === before && !(await app.title()).startsWith('●'), `${before} → ${await counts(app)}`)
  await app.click('出力')
  await app.waitIdle()
  const dir = join(migrated, 'exports', manifest.pages[0].id)
  check('出力はページごとのフォルダに出る', existsSync(join(dir, 'output.pdf')) && existsSync(join(dir, 'verify.json')), (await app.info()).replace(migrated, '<project>').slice(0, 160))
  if (existsSync(join(v1Project, 'exports/verify.json'))) {
    const a = readJson(join(v1Project, 'exports/verify.json')).pages[0].metrics
    const b = readJson(join(dir, 'verify.json')).pages[0].metrics
    check('移行の前後で出力の数値が同じ', a.recall === b.recall && a.excess === b.excess, `再現率 ${a.recall.toFixed(4)} / ${b.recall.toFixed(4)}`)
  }
  check('コンソールエラーがない(移行)', app.consoleErrors.length === 0, app.consoleErrors.join(' / '))
} finally {
  await app.close()
}

// ---- 2. 複数ページの取り込みと、PDF の追加
const fresh = join(work, 'fresh')
app = await launch({ env: { E2E_PDF: pdf, E2E_DEST: fresh, E2E_PROJECT: fresh } })
try {
  await setPages(app, '2-3')
  await app.click('PDFを取り込む')
  await app.waitIdle()
  await app.waitLoaded()
  check('2ページを取り込める', (await app.error()) === '' && (await pageOptions(app)).split(' | ').length === 2, await pageOptions(app))

  await setPages(app, '4,2')
  await app.click('PDFを追加')
  await app.waitIdle()
  await app.waitLoaded()
  const info = await app.info()
  check('同じPDFのページを追加でき、取り込み済みは飛ばす', /p\.4 を追加/.test(info) && /p\.2 は飛ばしました/.test(info), info)
  let m = readJson(join(fresh, 'document.json'))
  check('同じPDFは元PDFを共有する', m.sources.length === 1 && m.pages.length === 3 && readdirSync(join(fresh, 'source')).length === 1)

  // 範囲外のページは取り込まず、作りかけのファイルを残さない
  await setPages(app, '99')
  await app.click('PDFを追加')
  await app.waitIdle()
  check('範囲外のページはエラーにして、作りかけを残さない', /範囲外/.test(await app.error()) && readdirSync(join(fresh, 'assets')).length === 3 && readJson(join(fresh, 'document.json')).pages.length === 3, await app.error())
  await app.evaluate(`document.querySelector('.error button')?.click()`)
  await app.sleep(200)

  // 1ページだけ変更して保存 → 他のページのファイルは書き換えない
  await selectPage(app, 0)
  await app.sleep(500)
  const files = m.pages.map((ref) => join(fresh, ref.file))
  const mtimes = files.map((file) => statSync(file).mtimeMs)
  await app.sleep(1100)
  await app.click('罫線を検出')
  await app.waitIdle()
  const edited = await counts(app)
  await app.click('保存')
  await app.waitIdle()
  await app.sleep(500)
  const after = files.map((file) => statSync(file).mtimeMs)
  check('変更したページだけを書く', after[0] > mtimes[0] && after[1] === mtimes[1] && after[2] === mtimes[2], edited)

  // ページを切り替えると、そのページの内容になる
  await selectPage(app, 1)
  await app.sleep(600)
  check('ページを切り替えられる', /候補 0 件/.test(await counts(app)) && /p\.3\//.test(await app.statusBar()), (await app.statusBar()).slice(0, 90))
  // 別のページの操作を Undo すると、そのページへ戻る
  await app.evaluate(`document.querySelector('button[title^="元に戻す"]').click()`)
  await app.sleep(600)
  check('別のページの操作を Undo すると、そのページへ切り替わる', /p\.2\//.test(await app.statusBar()) && /候補 0 件/.test(await counts(app)), (await app.statusBar()).slice(0, 90))
  check('コンソールエラーがない(取り込み)', app.consoleErrors.length === 0, app.consoleErrors.join(' / '))
} finally {
  await app.close()
}

// ---- 3. 別のPDFを追加する
if (secondPdf) {
  app = await launch({ env: { E2E_PROJECT: fresh, E2E_PDF: secondPdf } })
  try {
    await open(app)
    await setPages(app, '1')
    await app.click('PDFを追加')
    await app.waitIdle()
    await app.waitLoaded()
    const m = readJson(join(fresh, 'document.json'))
    check('別のPDFを追加できる', (await app.error()) === '' && m.sources.length === 2 && m.pages.length === 4 && readdirSync(join(fresh, 'source')).length === 2, (await app.info()) || (await app.error()))
    check('追加したページへ切り替わる', /p\.1\/1/.test(await app.statusBar()), (await app.statusBar()).slice(0, 100))
    check('コンソールエラーがない(別のPDF)', app.consoleErrors.length === 0, app.consoleErrors.join(' / '))
  } finally {
    await app.close()
  }
  app = await launch({ env: { E2E_PROJECT: fresh } })
  try {
    await open(app)
    check('開き直して4ページある', (await pageOptions(app)).split(' | ').length === 4, await pageOptions(app))
  } finally {
    await app.close()
  }
}
process.exit(failures.length === 0 ? 0 : 1)
