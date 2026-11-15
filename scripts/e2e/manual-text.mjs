// テキストの追加・複製・削除の確認。
//   node scripts/e2e/manual-text.mjs <プロジェクトフォルダ>
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launch } from './driver.mjs'

const source = process.argv[2]
if (!source) {
  console.error('使い方: node scripts/e2e/manual-text.mjs <プロジェクトフォルダ>')
  process.exit(2)
}
const project = join(mkdtempSync(join(tmpdir(), 'pdfpe-manual-')), 'project')
cpSync(resolve(source), project, { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const candidates = async (app) => Number(((await app.statusBar()).match(/候補 (\d+) 件/) ?? [0, -1])[1])
const exact = (app, label) =>
  app.evaluate(`[...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
const selectedTransform = (app) => app.evaluate(`document.querySelector('.selection-outline')?.parentElement.getAttribute('transform') ?? ''`)

const app = await launch({ env: { E2E_PROJECT: project, E2E_MESSAGE: '1' } })
try {
  await app.click('プロジェクトを開く')
  await app.waitIdle()
  await app.waitLoaded()
  const before = await candidates(app)
  check('複製と削除は、選択がないと押せない', await app.evaluate(`[...document.querySelectorAll('.toolbar button')].filter((b) => ['複製', '削除'].includes(b.textContent.trim())).every((b) => b.disabled)`))

  // 追加: 候補が1件増え、追加した Text が選択されて、パネルで編集できる
  await exact(app, 'テキストを追加')
  await app.sleep(300)
  check('テキストを追加できる', (await candidates(app)) === before + 1 && /テキスト「テキスト」/.test(await app.statusBar()), (await app.statusBar()).slice(0, 110))
  await app.evaluate(`(() => { const el = document.querySelector('.panel input[type=text]:not([list])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '還付される税金'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })()`)
  await app.sleep(300)
  check('追加した Text の文字列をパネルで直せる', /テキスト「還付される税金」/.test(await app.statusBar()))
  const original = await selectedTransform(app)

  // 複製: 1件増え、複製したほうが選択され、位置がずれている
  await exact(app, '複製')
  await app.sleep(300)
  const copied = await selectedTransform(app)
  check('複製できる(複製したほうを選択し、ずらして置く)', (await candidates(app)) === before + 2 && /テキスト「還付される税金」/.test(await app.statusBar()) && copied !== '' && copied !== original, `${original} → ${copied}`)

  // 削除: 選択した複製だけが消える
  await exact(app, '削除')
  await app.sleep(300)
  check('削除できる', (await candidates(app)) === before + 1 && !/選択/.test(await app.statusBar()))

  // Undo: 削除 → 複製 → 文字列 → 追加 の順に戻る
  const undo = () => app.evaluate(`document.querySelector('button[title^="元に戻す"]').click()`)
  await undo()
  await app.sleep(200)
  check('削除を Undo で戻せる', (await candidates(app)) === before + 2)
  await undo()
  await undo()
  await undo()
  await app.sleep(300)
  check('追加まで Undo で戻せる', (await candidates(app)) === before, `${await candidates(app)} 件`)
  check('コンソールエラーがない', app.consoleErrors.length === 0, app.consoleErrors.join(' / '))
} finally {
  await app.close()
}
process.exit(failures.length === 0 ? 0 : 1)
