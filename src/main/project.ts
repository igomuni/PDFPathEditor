// プロジェクトフォルダ(design.md §5.1)の作成・読み書き
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { utilityProcess } from 'electron'
import { BUNDLED_FONTS, DEFAULT_FONT_FAMILY, DEFAULT_FONT_WEIGHT, type FontFace } from '../shared/fonts'
import type { ExportResult } from '../shared/export'
import type {
  DetectTarget,
  ExportRequest,
  ImportOptions,
  OcrRequest,
  RasterizeRequest,
  RasterizeResult,
  VectorizeRequest,
  WorkerReply
} from '../shared/ipc'
import { DOCUMENT_VERSION, type DocumentModel, type Layer, type LayerKind, type PathObject, type TextObject } from '../shared/model'
import type { OcrEngineId, OcrEngineInfo, TextDraft } from '../shared/ocr'
import type { PathDraft } from '../shared/vectorizer'

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

/** utility process を起動して1件の処理を任せ、結果を受け取ったら終了させる */
function runWorker<Request, Result>(script: string, serviceName: string, request: Request): Promise<Result> {
  return new Promise((resolvePromise, reject) => {
    const child = utilityProcess.fork(join(__dirname, script), [], { serviceName })
    let settled = false
    child.once('message', (reply: WorkerReply<Result>) => {
      settled = true
      child.kill()
      if (reply.ok) resolvePromise(reply.result)
      else reject(new Error(reply.error))
    })
    child.once('exit', (code) => {
      if (!settled) reject(new Error(`${serviceName} が異常終了しました(code ${code})`))
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
  const raster = await runWorker<RasterizeRequest, RasterizeResult>('rasterize-worker.js', 'PDF Rasterizer', {
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

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

/** `pnpm fonts` で取得したフォントと `pnpm ocr:build` で作ったヘルパーの置き場 */
export interface ResourcePaths {
  fontsDir: string
  visionBinary: string
}

/** 取得済みで使えるフォントの一覧 */
export async function listFonts(resources: ResourcePaths): Promise<FontFace[]> {
  const fonts: FontFace[] = []
  for (const { family, weight, file, generic } of BUNDLED_FONTS) {
    if (await exists(join(resources.fontsDir, file))) fonts.push({ family, weight, file, generic })
  }
  return fonts
}

export async function readFont(resources: ResourcePaths, file: string): Promise<Uint8Array> {
  if (!BUNDLED_FONTS.some((font) => font.file === file)) throw new Error(`未登録のフォントです: ${file}`)
  return readFile(join(resources.fontsDir, file))
}

/** Text が使っているフォントを、埋め込み用にプロジェクトの fonts/ へコピーする */
async function copyUsedFonts(projectDir: string, document: DocumentModel, resources: ResourcePaths): Promise<void> {
  const used = new Set<string>()
  for (const page of document.pages) {
    for (const layer of page.layers) {
      for (const object of layer.objects) {
        if (object.type !== 'text') continue
        const font = BUNDLED_FONTS.find((f) => f.family === object.fontFamily && f.weight === object.fontWeight)
        if (font) used.add(font.file)
      }
    }
  }
  for (const file of used) {
    const source = join(resources.fontsDir, file)
    const target = join(projectDir, 'fonts', file)
    if ((await exists(source)) && !(await exists(target))) {
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
    }
  }
}

export async function saveDocument(
  projectDir: string,
  document: DocumentModel,
  resources?: ResourcePaths
): Promise<void> {
  if (resources) await copyUsedFonts(projectDir, document, resources)
  const target = join(projectDir, DOCUMENT_FILE)
  const temp = `${target}.tmp`
  await writeFile(temp, JSON.stringify(document, null, 2) + '\n', 'utf8')
  await rename(temp, target)
}

function resolveAsset(projectDir: string, assetRel: string): string {
  const assetsRoot = resolve(projectDir, 'assets')
  const abs = resolve(projectDir, assetRel)
  if (!abs.startsWith(assetsRoot + sep)) throw new Error(`assets 外のパスは読めません: ${assetRel}`)
  return abs
}

export async function readAsset(projectDir: string, assetRel: string): Promise<Uint8Array> {
  return readFile(resolveAsset(projectDir, assetRel))
}

/** 背景ラスターから Path 候補を抽出する。安定IDはここで振る */
export async function detectCandidates(
  projectDir: string,
  target: DetectTarget,
  vectorizerId: string
): Promise<PathObject[]> {
  const drafts = await runWorker<VectorizeRequest, PathDraft[]>('vectorize-worker.js', 'Vectorizer', {
    vectorizerId,
    pngPath: resolveAsset(projectDir, target.asset),
    pixelWidth: target.pixelWidth,
    pixelHeight: target.pixelHeight,
    imageTransform: target.transform
  })
  return drafts.map((draft, index) => ({ id: `obj-${randomUUID()}`, ...draft, z: index }))
}

export async function listOcrEngines(resources: ResourcePaths): Promise<OcrEngineInfo[]> {
  const visionReason =
    process.platform !== 'darwin'
      ? 'macOS でのみ使えます'
      : (await exists(resources.visionBinary))
        ? null
        : '`pnpm ocr:build` でヘルパーをビルドしてください'
  return [
    { id: 'vision', label: 'macOS Vision', available: visionReason === null, reason: visionReason },
    { id: 'tesseract', label: 'Tesseract', available: true, reason: null }
  ]
}

/** 背景ラスターを OCR にかけて Text 候補を作る。安定IDはここで振る */
export async function detectText(
  projectDir: string,
  target: DetectTarget,
  engineId: OcrEngineId,
  resources: ResourcePaths
): Promise<TextObject[]> {
  const engine = (await listOcrEngines(resources)).find((info) => info.id === engineId)
  if (!engine) throw new Error(`未登録の OCR エンジンです: ${engineId}`)
  if (!engine.available) throw new Error(`${engine.label} は使えません: ${engine.reason}`)
  const font = BUNDLED_FONTS.find((f) => f.family === DEFAULT_FONT_FAMILY && f.weight === DEFAULT_FONT_WEIGHT)!
  const fontFile = join(resources.fontsDir, font.file)
  if (!(await exists(fontFile))) {
    throw new Error(`フォント ${font.file} がありません。\`pnpm fonts\` で取得してください`)
  }
  const languageData = createRequire(__filename).resolve('@tesseract.js-data/jpn/package.json')
  const drafts = await runWorker<OcrRequest, TextDraft[]>('ocr-worker.js', 'OCR', {
    engineId,
    pngPath: resolveAsset(projectDir, target.asset),
    pixelWidth: target.pixelWidth,
    pixelHeight: target.pixelHeight,
    imageTransform: target.transform,
    fontFile,
    fontFamily: font.family,
    fontWeight: font.weight,
    visionBinary: resources.visionBinary,
    tesseractLangPath: join(dirname(languageData), '4.0.0_best_int')
  })
  return drafts.map((draft, index) => ({ id: `obj-${randomUUID()}`, ...draft, z: index }))
}

/**
 * 確定オブジェクトを exports/ に PDF / SVG / JSON として出力し、背景との差分を検証する。
 * 画面上のドキュメント(未保存の変更を含む)をそのまま出力する。
 */
export async function exportDocument(
  projectDir: string,
  document: DocumentModel,
  resources: ResourcePaths
): Promise<ExportResult> {
  return runWorker<ExportRequest, ExportResult>('export-worker.js', 'Export', {
    projectDir,
    document,
    fontDirs: [join(projectDir, 'fonts'), resources.fontsDir]
  })
}
