// プロジェクトフォルダ(design.md §5.1)の作成・読み書き
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { utilityProcess } from 'electron'
import type { ImportOptions, RasterizeReply, RasterizeRequest, RasterizeResult } from '../shared/ipc'
import { DOCUMENT_VERSION, type DocumentModel, type Layer, type LayerKind } from '../shared/model'

const DOCUMENT_FILE = 'document.json'
const SUBDIRS = ['source', 'assets', 'fonts', 'exports'] as const
const POINTS_PER_INCH = 72

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

function runRasterizer(request: RasterizeRequest): Promise<RasterizeResult> {
  return new Promise((resolvePromise, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'rasterize-worker.js'), [], {
      serviceName: 'PDF Rasterizer'
    })
    let settled = false
    child.once('message', (reply: RasterizeReply) => {
      settled = true
      child.kill()
      if (reply.ok) resolvePromise(reply.result)
      else reject(new Error(reply.error))
    })
    child.once('exit', (code) => {
      if (!settled) reject(new Error(`ラスタライズ処理が異常終了しました(code ${code})`))
    })
    child.once('spawn', () => child.postMessage(request))
  })
}

function newLayer(kind: LayerKind, name: string, locked: boolean): Layer {
  return { id: `layer-${randomUUID()}`, kind, name, locked, visible: true, opacity: 1, objects: [] }
}

async function assertEmptyOrMissing(dir: string): Promise<void> {
  const entries = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[]
    throw err
  })
  if (entries.filter((name) => name !== '.DS_Store').length > 0) {
    throw new Error(`作成先のフォルダが空ではありません: ${dir}`)
  }
}

export async function importPdf(
  pdfPath: string,
  projectDir: string,
  options: ImportOptions
): Promise<DocumentModel> {
  const { pageNumber, dpi } = options
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error('ページ番号が不正です')
  if (!Number.isFinite(dpi) || dpi < 36 || dpi > 1200) throw new Error('dpi は 36〜1200 で指定してください')

  await assertEmptyOrMissing(projectDir)
  try {
    return await buildProject(pdfPath, projectDir, pageNumber, dpi)
  } catch (err) {
    // 失敗したら作りかけを残さない。作成先は空だと確認済みなので、消すのは今回作ったものだけ
    for (const name of [...SUBDIRS, DOCUMENT_FILE, `${DOCUMENT_FILE}.tmp`]) {
      await rm(join(projectDir, name), { recursive: true, force: true })
    }
    await rmdir(projectDir).catch(() => {})
    throw err
  }
}

async function buildProject(
  pdfPath: string,
  projectDir: string,
  pageNumber: number,
  dpi: number
): Promise<DocumentModel> {
  for (const sub of SUBDIRS) await mkdir(join(projectDir, sub), { recursive: true })

  // 元PDFは無変更でコピーし、読み取り専用にする。復号済みPDFは保存しない
  const originalFileName = basename(pdfPath)
  const sourceRel = `source/${originalFileName}`
  const sourceAbs = join(projectDir, sourceRel)
  await copyFile(pdfPath, sourceAbs)
  await chmod(sourceAbs, 0o444)
  const [sha256, originalSha256, sourceStat] = await Promise.all([
    sha256File(sourceAbs),
    sha256File(pdfPath),
    stat(sourceAbs)
  ])
  if (sha256 !== originalSha256) throw new Error('元PDFのコピーでハッシュが一致しませんでした')

  const assetRel = `assets/page-${String(pageNumber).padStart(4, '0')}-background-${dpi}dpi.png`
  const raster = await runRasterizer({
    pdfPath: sourceAbs,
    pageNumber,
    dpi,
    outPngPath: join(projectDir, assetRel)
  })

  // 画像の左上をページの左上に合わせて配置する
  const [x0, , , y1] = raster.mediaBox
  const widthPt = (raster.pixelWidth * POINTS_PER_INCH) / dpi
  const heightPt = (raster.pixelHeight * POINTS_PER_INCH) / dpi
  const background = newLayer('background', '背景ラスター', true)
  background.objects.push({
    id: `obj-${randomUUID()}`,
    type: 'image',
    role: 'background',
    fieldCode: null,
    transform: [widthPt, 0, 0, heightPt, x0, y1 - heightPt],
    z: 0,
    tags: [],
    meta: { dpi, sourcePageNumber: pageNumber },
    asset: assetRel,
    pixelWidth: raster.pixelWidth,
    pixelHeight: raster.pixelHeight
  })

  const document: DocumentModel = {
    version: DOCUMENT_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      file: sourceRel,
      originalFileName,
      sha256,
      byteLength: sourceStat.size,
      pageCount: raster.pageCount,
      encrypted: raster.encryptFilter !== null,
      encryptFilter: raster.encryptFilter,
      permissions: raster.permissions
    },
    pages: [
      {
        id: `page-${randomUUID()}`,
        sourcePageNumber: pageNumber,
        mediaBox: raster.mediaBox,
        layers: [
          background,
          newLayer('candidates', '自動抽出の候補', false),
          newLayer('confirmed', '確定オブジェクト', false),
          newLayer('diff', '差分オーバーレイ', true)
        ]
      }
    ]
  }
  await saveDocument(projectDir, document)
  return document
}

export async function loadDocument(projectDir: string): Promise<DocumentModel> {
  const text = await readFile(join(projectDir, DOCUMENT_FILE), 'utf8').catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw new Error(`${DOCUMENT_FILE} がありません: ${projectDir}`)
      throw err
    }
  )
  const document = JSON.parse(text) as DocumentModel
  if (document.version !== DOCUMENT_VERSION) {
    throw new Error(`未対応の document.json バージョンです: ${String(document.version)}`)
  }
  return document
}

export async function saveDocument(projectDir: string, document: DocumentModel): Promise<void> {
  const target = join(projectDir, DOCUMENT_FILE)
  const temp = `${target}.tmp`
  await writeFile(temp, JSON.stringify(document, null, 2) + '\n', 'utf8')
  await rename(temp, target)
}

export async function readAsset(projectDir: string, assetRel: string): Promise<Uint8Array> {
  const assetsRoot = resolve(projectDir, 'assets')
  const abs = resolve(projectDir, assetRel)
  if (!abs.startsWith(assetsRoot + sep)) throw new Error(`assets 外のパスは読めません: ${assetRel}`)
  return readFile(abs)
}
