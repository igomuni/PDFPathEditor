// 実アプリの通し確認: プロジェクトを開く → 罫線検出 → 項目コード割り当て → 全件確定 → 出力。
// プロジェクトはコピーしてから使う(元のフォルダは変更しない)。
//   node scripts/e2e/smoke.mjs <プロジェクトフォルダ>
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const source = process.argv[2]
if (!source) {
  console.error('使い方: node scripts/e2e/smoke.mjs <プロジェクトフォルダ>')
  process.exit(2)
}
const project = join(mkdtempSync(join(tmpdir(), 'pdfpe-smoke-')), 'project')
cpSync(resolve(source), project, { recursive: true })

const app = await launch({ env: { E2E_PROJECT: project } })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
try {
  await app.click('プロジェクトを開く')
  await app.waitIdle()
  await app.waitLoaded()
  check('プロジェクトを開ける', (await app.error()) === '', await app.statusBar())

  await app.click('罫線を検出')
  await app.waitIdle()
  const afterLines = await app.statusBar()
  check('罫線を検出できる', /候補 [1-9]\d* 件/.test(afterLines), afterLines)

  await app.click('項目コードを割り当て')
  await app.sleep(500)
  check('項目コードの割り当てが動く', (await app.info()) !== '', await app.info())

  await app.click('全件確定')
  await app.sleep(500)
  const afterConfirm = await app.statusBar()
  check('全件確定できる', /候補 0 件/.test(afterConfirm), afterConfirm)

  await app.click('出力')
  await app.waitIdle()
  const exported = await app.info()
  check('出力と検証が動く', /再現率/.test(exported) && (await app.error()) === '', exported.replace(project, '<project>'))

  check('コンソールエラーがない', app.consoleErrors.length === 0, app.consoleErrors.join(' / '))
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
