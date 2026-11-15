// 実アプリの自動確認用。ビルド済みアプリを起動し、DevTools プロトコルで画面を操作する。
// 使い方は scripts/e2e/README.md。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * アプリを起動して操作用のハンドルを返す。
 * env には E2E_PROJECT などダイアログの応答を渡す(stub.cjs を参照)。
 * userDataDir を省くと一時フォルダを使う(利用者の設定や「最近使ったプロジェクト」を汚さない)。
 */
export async function launch({ env = {}, userDataDir = mkdtempSync(join(tmpdir(), 'pdfpe-e2e-')), port = 9333 } = {}) {
  const electron = join(repo, 'node_modules/.bin/electron')
  const child = spawn(electron, ['-r', join(repo, 'scripts/e2e/stub.cjs'), `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '.'], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: 'ignore'
  })
  let target
  for (let i = 0; i < 100 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')
    } catch {}
    if (!target) await sleep(200)
  }
  if (!target) {
    child.kill()
    throw new Error('アプリのウィンドウが見つかりません(先に pnpm build が必要です)')
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  const consoleErrors = []
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id) pending.get(msg.id)?.(msg)
    else if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 400))
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
    }
  }
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  /** 画面の中で式を評価して値を返す */
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
  await send('Runtime.enable')
  await sleep(800)

  const app = {
    evaluate,
    consoleErrors,
    sleep,
    /** 表示が label で始まるボタンを押す */
    click: (label) =>
      evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`),
    /** ラベルが label のチェックボックスを切り替える */
    toggle: (label) =>
      evaluate(`[...document.querySelectorAll('label')].find((l) => l.textContent.trim() === ${JSON.stringify(label)}).querySelector('input').click()`),
    /** 「…中」の表示が消えるまで待つ */
    async waitIdle() {
      await sleep(400)
      for (let i = 0; i < 1200; i++) {
        if (!(await evaluate(`!!document.querySelector('.busy')`))) break
        await sleep(100)
      }
    },
    /** 背景が表示されるか、エラーが出るまで待つ */
    async waitLoaded() {
      for (let i = 0; i < 150; i++) {
        if (await evaluate(`!!document.querySelector('svg image') || !!document.querySelector('.error')`)) break
        await sleep(200)
      }
      await sleep(400)
    },
    title: () => evaluate('document.title'),
    statusBar: () => evaluate(`document.querySelector('.statusbar').innerText.replace(/\\n/g, ' | ')`),
    info: () => evaluate(`(document.querySelector('.info')?.innerText ?? '').replace(/\\n閉じる/, '')`),
    error: () => evaluate(`(document.querySelector('.error')?.innerText ?? '').replace(/\\n閉じる/, '')`),
    async screenshot(file) {
      writeFileSync(file, Buffer.from((await send('Page.captureScreenshot')).result.data, 'base64'))
    },
    mouse: (type, x, y, extra = {}) =>
      send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }),
    async close() {
      ws.close()
      child.kill()
      await sleep(500)
    }
  }
  return app
}
