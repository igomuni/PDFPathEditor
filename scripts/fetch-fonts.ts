// 同梱フォント(SIL OFL)を resources/fonts/ にダウンロードする。`pnpm fonts` で実行。
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_FONTS } from '../src/shared/fonts.ts'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'fonts')
await mkdir(outDir, { recursive: true })

for (const font of BUNDLED_FONTS) {
  const target = join(outDir, font.file)
  const existing = await stat(target).catch(() => null)
  if (existing && existing.size > 0) {
    console.log(`あり    ${font.file}`)
    continue
  }
  const response = await fetch(font.url)
  if (!response.ok) throw new Error(`${font.file}: HTTP ${response.status} (${font.url})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  // OpenType の先頭は 'OTTO'(CFF)か 0x00010000(TrueType)
  const magic = String.fromCharCode(...bytes.subarray(0, 4))
  if (magic !== 'OTTO' && magic !== '\u0000\u0001\u0000\u0000') throw new Error(`${font.file}: フォントファイルではありません`)
  await writeFile(`${target}.part`, bytes)
  await rename(`${target}.part`, target)
  console.log(`取得    ${font.file} (${(bytes.length / 1e6).toFixed(1)} MB, ${font.license})`)
}
