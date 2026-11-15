// 矢印(吹き出しの細い線 + 先端の三角形)の検出の確認。
//   node scripts/e2e/arrows.mjs <プロジェクトフォルダ> [スクリーンショットの出力先フォルダ]
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const source = process.argv[2]
const shots = process.argv[3] ? resolve(process.argv[3]) : null
if (!source) {
  console.error('使い方: node scripts/e2e/arrows.mjs <プロジェクトフォルダ> [スクリーンショットの出力先]')
  process.exit(2)
}
if (shots) mkdirSync(shots, { recursive: true })
const project = join(mkdtempSync(join(tmpdir(), 'pdfpe-arrows-')), 'project')
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
  const press = (label) => app.evaluate(`[...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  await press('罫線を検出')
  await app.waitIdle()
  await app.sleep(500)
  const info = await app.info()
  const count = Number(info.match(/矢印 (\d+) 個/)?.[1] ?? -1)
  check('罫線の検出で矢印も見つかる', count > 0, info)

  // 保存して、ページのファイルから矢印の Path を読む
  await press('保存')
  await app.waitIdle()
  await app.sleep(500)
  const pagesDir = join(project, 'pages')
  const page = JSON.parse(readFileSync(join(pagesDir, readdirSync(pagesDir).find((name) => name.endsWith('.json'))), 'utf8'))
  const objects = page.layers.find((layer) => layer.kind === 'candidates').objects
  const arrows = objects.filter((object) => object.meta?.source === 'arrow-detect')
  const heads = arrows.filter((object) => object.closed)
  const shafts = arrows.filter((object) => !object.closed)
  for (const head of heads) {
    const shaft = shafts.find((candidate) => candidate.meta.arrow === head.meta.arrow)
    console.log(`     三角形 ${head.nodes.map((n) => `(${n.x}, ${n.y})`).join(' ')} / 軸 ${shaft.nodes.map((n) => `(${n.x}, ${n.y})`).join(' → ')} 線幅 ${shaft.strokeWidth}`)
  }
  check('三角形は塗りだけの閉じた Path、軸は線だけの開いた Path', heads.length === count && shafts.length === count && heads.every((h) => h.fill && h.stroke === null && h.nodes.length === 3) && shafts.every((s) => s.fill === null && s.stroke && s.nodes.length >= 2))
  // 軸と重なる罫線の候補が残っていない
  const onShaft = (p, shaft) =>
    shaft.nodes.slice(1).some((q, i) => {
      const s = shaft.nodes[i]
      const [dx, dy] = [q.x - s.x, q.y - s.y]
      const u = Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / (dx * dx + dy * dy || 1)))
      return Math.hypot(p.x - (s.x + u * dx), p.y - (s.y + u * dy)) <= 1.2
    })
  const doubled = objects.filter((object) => object.type === 'path' && object.role === 'frame' && object.nodes.length === 2 && shafts.some((shaft) => object.nodes.every((node) => onShaft(node, shaft))))
  check('軸と重なる罫線の候補が残っていない', doubled.length === 0, `${doubled.length} 本`)
  check('画面に三角形が塗りで描かれる', (await app.evaluate(`[...document.querySelectorAll('g[data-layer-kind=candidates] path')].filter((p) => p.getAttribute('fill') && p.getAttribute('fill') !== 'none' && p.getAttribute('fill') !== 'transparent').length`)) >= count)

  // もう一度検出しても増えない
  await press('罫線を検出')
  await app.waitIdle()
  await app.sleep(500)
  check('検出し直しても矢印が二重にならない', Number((await app.info()).match(/矢印 (\d+) 個/)?.[1]) === count)
  if (shots) await app.screenshot(join(shots, 'arrows.png'))
  check('エラーが出ていない', (await app.error()) === '' && app.consoleErrors.length === 0, `${await app.error()} ${app.consoleErrors.join(' / ')}`)
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
