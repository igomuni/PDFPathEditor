// PDF の指定したページをすべて取り込み、ページごとに 検出 → 確定 → 出力と検証 → 確認用データ を行って、数値を一覧にする。
//   node scripts/e2e/all-pages.mjs <PDF> <作るプロジェクトフォルダ(まだないもの)> <ページ指定 例: 1-32> [結果の JSON]
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { launch } from './driver.mjs'

const [pdfArg, destArg, pages, outArg] = process.argv.slice(2)
if (!pdfArg || !destArg || !pages) {
  console.error('使い方: node scripts/e2e/all-pages.mjs <PDF> <作るプロジェクトフォルダ> <ページ指定> [結果の JSON]')
  process.exit(2)
}
const project = resolve(destArg)
if (existsSync(project)) {
  console.error(`すでにあります: ${project}`)
  process.exit(2)
}
const out = outArg ? resolve(outArg) : null
const results = []

const app = await launch({ env: { E2E_PDF: resolve(pdfArg), E2E_DEST: project, E2E_MESSAGE: '1' } })
try {
  /** 「…中」の表示が消えるまで待つ(検出は1ページで数分かかることがある) */
  const idle = async () => {
    await app.sleep(500)
    for (let i = 0; i < 9000; i++) {
      if (!(await app.evaluate(`!!document.querySelector('.busy')`))) break
      await app.sleep(200)
    }
    await app.sleep(300)
  }
  const press = async (label) => {
    await app.evaluate(`document.querySelector('.error button')?.click()`)
    await app.evaluate(`(() => { const b = [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (b && !b.disabled) b.click() })()`)
    await idle()
    return { info: await app.info(), error: await app.error() }
  }
  await app.evaluate(`(() => { const el = document.querySelector('.pages-spec'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(pages)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await app.click('PDFを取り込む')
  await idle()
  await app.waitLoaded()
  const count = await app.evaluate(`document.querySelectorAll('.page-tree .page-row').length`)
  console.log(`${count} ページを取り込みました: ${await app.error()}`)

  const number = (text, pattern) => {
    const m = text.match(pattern)
    return m ? Number(m[1]) : null
  }
  for (let index = 0; index < count; index++) {
    const started = Date.now()
    await app.evaluate(`document.querySelectorAll('.page-tree .page-row')[${index}].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await app.sleep(800)
    await app.waitLoaded()
    const label = await app.evaluate(`document.querySelectorAll('.page-tree .page-row')[${index}].querySelector('.content').textContent`)
    const errors = []
    const step = async (name) => {
      const result = await press(name)
      if (result.error) errors.push(`${name}: ${result.error}`)
      return result.info
    }
    const lines = await step('罫線を検出')
    await step('文字を検出')
    const qr = await step('QR・様式ID')
    const codes = await step('項目コードを割り当て')
    await step('全件確定')
    const exported = await step('出力')
    const review = await step('確認用データ')
    await step('保存')
    const row = {
      page: label,
      rules: number(lines, /罫線 (\d+) 本/),
      arrows: number(lines, /矢印 (\d+) 個/),
      qr: number(qr, /QRコード (\d+) 個/),
      formId: number(qr, /様式ID (\d+) 件/),
      fieldCodes: number(codes, /項目コード (\d+) 件/),
      objects: number(exported, /: (\d+) 件 \//),
      recall: number(exported, /再現率 ([\d.]+)%/),
      excess: number(exported, /過剰率 ([\d.]+)%/),
      mismatch: number(exported, /不一致画素率 ([\d.]+)%/),
      texts: number(review, /テキスト (\d+) 件/),
      uncovered: number(review, /取れていないインク (\d+) か所/),
      misfit: number(review, /背景に合っていないテキスト (\d+) 件/),
      seconds: Math.round((Date.now() - started) / 1000),
      errors
    }
    results.push(row)
    console.log(JSON.stringify(row))
    if (out) writeFileSync(out, JSON.stringify(results, null, 2))
  }
  if (app.consoleErrors.length > 0) console.log('コンソールエラー:', app.consoleErrors.join(' / '))
} finally {
  await app.close()
}
