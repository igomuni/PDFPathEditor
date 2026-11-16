// プロジェクトフォルダ(design.md §5.1)の作成・読み書き
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { utilityProcess } from 'electron'
import { BUNDLED_FONTS, DEFAULT_FONT_FAMILY, DEFAULT_FONT_WEIGHT, type FontFace } from '../shared/fonts'
import type { PickedCorrections, ReviewExportResult } from '../shared/corrections'
import type { ExportResult } from '../shared/export'
import type {
  AddedPages,
  DetectTarget,
  ExportRequest,
  ImageCutDraft,
  ImageCutRequest,
  ImportOptions,
  SavePayload,
  OcrRequest,
  RasterizeRequest,
  RasterizeResult,
  VectorizeRequest,
  WorkerReply
} from '../shared/ipc'
import { QR_SOURCE } from '../shared/ipc'
import {
  DOCUMENT_VERSION,
  type DocumentModel,
  type ImageObject,
  type Rect,
  type Layer,
  type LayerKind,
  type Page,
  type PathObject,
  type ProjectManifest,
  type SourceInfo
} from '../shared/model'
import { fromPageFile, isSafeId, migrateV1, newPageId, newSourceId, pageFileName, parsePageSpec, toManifest, toPageFile } from '../shared/project'
import type { OcrEngineId, OcrEngineInfo, TextDetection, TextDetectionDrafts } from '../shared/ocr'
import type { PathDraft } from '../shared/vectorizer'

const DOCUMENT_FILE = 'document.json'
const SUBDIRS = ['source', 'assets', 'pages', 'fonts', 'exports'] as const
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

function validateDpi(dpi: number): void {
  if (!Number.isFinite(dpi) || dpi < 36 || dpi > 1200) throw new Error('dpi は 36〜1200 で指定してください')
}

const shortId = (): string => randomUUID().slice(0, 8)

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temp, path)
}

/**
 * 元PDFを無変更で source/<sourceId>/ にコピーし、読み取り専用にする。復号済みPDFは保存しない。
 * 同じPDF(SHA-256 が同じ)が取り込み済みなら、それを使う。
 */
async function ensureSource(
  pdfPath: string,
  projectDir: string,
  existing: readonly SourceInfo[]
): Promise<{ source: SourceInfo; isNew: boolean }> {
  const originalSha256 = await sha256File(pdfPath)
  const known = existing.find((source) => source.sha256 === originalSha256)
  if (known) return { source: known, isNew: false }

  const id = newSourceId(shortId())
  const originalFileName = basename(pdfPath)
  const file = `source/${id}/${originalFileName}`
  const abs = join(projectDir, file)
  await mkdir(dirname(abs), { recursive: true })
  await copyFile(pdfPath, abs)
  await chmod(abs, 0o444)
  const [sha256, sourceStat] = await Promise.all([sha256File(abs), stat(abs)])
  if (sha256 !== originalSha256) throw new Error('元PDFのコピーでハッシュが一致しませんでした')
  return {
    // ページ数と暗号化の情報は、最初のページをラスタライズしたときに埋める
    source: { id, file, originalFileName, sha256, byteLength: sourceStat.size, pageCount: 0, encrypted: false, encryptFilter: null, permissions: null },
    isNew: true
  }
}

/** 対象ページを背景ラスターにして、ページごとの処理層(背景・候補・確定)を作る */
async function buildPages(
  projectDir: string,
  source: SourceInfo,
  pageNumbers: readonly number[],
  dpi: number
): Promise<{ source: SourceInfo; pages: Page[] }> {
  const pages: Page[] = []
  let filled = source
  for (const pageNumber of pageNumbers) {
    const pageId = newPageId(pageNumber, shortId())
    const assetRel = `assets/${pageId}/background-${dpi}dpi.png`
    await mkdir(join(projectDir, 'assets', pageId), { recursive: true })
    const raster = await runWorker<RasterizeRequest, RasterizeResult>('rasterize-worker.js', 'PDF Rasterizer', {
      pdfPath: join(projectDir, source.file),
      pageNumber,
      dpi,
      outPngPath: join(projectDir, assetRel)
    })
    filled = {
      ...filled,
      pageCount: raster.pageCount,
      encrypted: raster.encryptFilter !== null,
      encryptFilter: raster.encryptFilter,
      permissions: raster.permissions
    }

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
    pages.push({
      id: pageId,
      sourceId: source.id,
      sourcePageNumber: pageNumber,
      mediaBox: raster.mediaBox,
      layers: [background, newLayer('candidates', '自動抽出の候補', false), newLayer('confirmed', '確定オブジェクト', false)]
    })
  }
  return { source: filled, pages }
}

/** 取り込みに失敗したとき、今回作ったページのファイルと、新しくコピーした元PDFを消す */
async function discardImport(projectDir: string, source: SourceInfo | null, sourceIsNew: boolean): Promise<void> {
  if (!source) return
  // 作りかけのページのアセット(ページIDは今回振ったものなので、フォルダごと消してよい)は buildPages の途中で
  // 止まると特定できないため、目次に載っていないアセットのフォルダを消す
  const manifest = await readManifest(projectDir).catch(() => null)
  const known = new Set((manifest?.pages ?? []).map((page) => page.id))
  for (const name of await readdir(join(projectDir, 'assets')).catch(() => [] as string[])) {
    if (name.startsWith('page-') && !known.has(name)) await rm(join(projectDir, 'assets', name), { recursive: true, force: true })
  }
  if (sourceIsNew) {
    const dir = join(projectDir, 'source', source.id)
    await chmod(join(projectDir, source.file), 0o644).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
}

/** 新しいプロジェクトを作り、PDFの対象ページを取り込む */
export async function importPdf(pdfPath: string, projectDir: string, options: ImportOptions): Promise<DocumentModel> {
  validateDpi(options.dpi)
  const pageNumbers = parsePageSpec(options.pages)
  await assertEmptyOrMissing(projectDir)
  try {
    for (const sub of SUBDIRS) await mkdir(join(projectDir, sub), { recursive: true })
    const { source } = await ensureSource(pdfPath, projectDir, [])
    const built = await buildPages(projectDir, source, pageNumbers, options.dpi)
    const document: DocumentModel = {
      version: DOCUMENT_VERSION,
      createdAt: new Date().toISOString(),
      sources: [built.source],
      pages: built.pages
    }
    await saveDocument(projectDir, { manifest: toManifest(document), pages: document.pages, removedPageIds: [] })
    return document
  } catch (err) {
    // 失敗したら作りかけを残さない。作成先は空だと確認済みなので、消すのは今回作ったものだけ
    for (const name of [...SUBDIRS, DOCUMENT_FILE, `${DOCUMENT_FILE}.tmp`]) {
      const target = join(projectDir, name)
      // 読み取り専用にした元PDFも消せるようにする
      if (name === 'source') {
        for (const dir of await readdir(target).catch(() => [] as string[])) {
          for (const file of await readdir(join(target, dir)).catch(() => [] as string[])) await chmod(join(target, dir, file), 0o644).catch(() => {})
        }
      }
      await rm(target, { recursive: true, force: true })
    }
    await rmdir(projectDir).catch(() => {})
    throw err
  }
}

/**
 * 開いているプロジェクトに、PDFの対象ページを追加する。同じPDFが取り込み済みなら元PDFは共有する。
 * 目次とページのファイルはここで書く(保存済みの状態に足す)。呼ぶ前に、画面の変更は保存しておくこと。
 */
export async function addPdf(projectDir: string, pdfPath: string, options: ImportOptions): Promise<AddedPages> {
  validateDpi(options.dpi)
  const requested = parsePageSpec(options.pages)
  const manifest = await readManifest(projectDir)
  if (!manifest) throw new Error('プロジェクトが新しい形式で保存されていません。先に保存してください')
  let source: SourceInfo | null = null
  let sourceIsNew = false
  try {
    ;({ source, isNew: sourceIsNew } = await ensureSource(pdfPath, projectDir, manifest.sources))
    const sourceId = source.id
    const taken = new Set(manifest.pages.filter((page) => page.sourceId === sourceId).map((page) => page.sourcePageNumber))
    const pageNumbers = requested.filter((pageNumber) => !taken.has(pageNumber))
    if (pageNumbers.length === 0) throw new Error(`指定したページはすべて取り込み済みです: ${requested.join(', ')}`)
    const built = await buildPages(projectDir, source, pageNumbers, options.dpi)
    const sources = sourceIsNew ? [...manifest.sources, built.source] : manifest.sources
    for (const page of built.pages) await writeJson(join(projectDir, pageFileName(page.id)), toPageFile(page))
    const added = toManifest({ version: DOCUMENT_VERSION, createdAt: manifest.createdAt, sources, pages: built.pages })
    await writeJson(join(projectDir, DOCUMENT_FILE), { ...manifest, sources, pages: [...manifest.pages, ...added.pages] })
    return { source: built.source, sourceIsNew, pages: built.pages, skippedPageNumbers: requested.filter((pageNumber) => taken.has(pageNumber)) }
  } catch (err) {
    await discardImport(projectDir, source, sourceIsNew)
    throw err
  }
}

/** 取り込み済みのPDFから、ページを追加する */
export async function addPages(projectDir: string, sourceId: string, options: ImportOptions): Promise<AddedPages> {
  const manifest = await readManifest(projectDir)
  const source = manifest?.sources.find((candidate) => candidate.id === sourceId)
  if (!source) throw new Error(`取り込み済みのPDFが見つかりません: ${sourceId}`)
  const abs = resolve(projectDir, source.file)
  if (!abs.startsWith(resolve(projectDir, 'source') + sep)) throw new Error(`source 外のパスは読めません: ${source.file}`)
  // 同じファイルなので、ハッシュが一致して元PDFは共有される
  return addPdf(projectDir, abs, options)
}

/**
 * ページを削除する(元に戻せない)。ページのファイル、背景ラスター、出力を消し、目次から外す。
 * removeSource が true で、その元PDFを使うページが他になければ、元PDFも消す。
 */
export async function deletePage(projectDir: string, pageId: string, removeSource: boolean): Promise<{ removedSourceId: string | null }> {
  // フォルダごと消すので、IDがフォルダの外を指せないことを先に確かめる(目次のIDも readManifest で検証済み)
  if (!isSafeId(pageId)) throw new Error(`ページIDが正しくありません: ${String(pageId)}`)
  const manifest = await readManifest(projectDir)
  if (!manifest) throw new Error('プロジェクトが新しい形式で保存されていません。先に保存してください')
  const ref = manifest.pages.find((page) => page.id === pageId)
  if (!ref) throw new Error(`ページが見つかりません: ${pageId}`)
  if (manifest.pages.length === 1) throw new Error('最後のページは削除できません')
  const pages = manifest.pages.filter((page) => page.id !== pageId)
  const source = manifest.sources.find((candidate) => candidate.id === ref.sourceId)
  const unused = source !== undefined && !pages.some((page) => page.sourceId === source.id)
  const dropSource = removeSource && unused
  // 先に目次を書く(途中で止まっても、目次にないファイルが残るだけにする)
  await writeJson(join(projectDir, DOCUMENT_FILE), {
    ...manifest,
    pages,
    sources: dropSource ? manifest.sources.filter((candidate) => candidate.id !== source.id) : manifest.sources
  })
  await rm(join(projectDir, pageFileName(pageId)), { force: true })
  // 旧形式から移行したページの背景は assets/ の直下にあるので、ここでは消えない(フォルダ単位で消せるものだけ消す)
  await rm(join(projectDir, 'assets', pageId), { recursive: true, force: true })
  await rm(join(projectDir, 'exports', pageId), { recursive: true, force: true })
  if (dropSource && isSafeId(source.id)) {
    const dir = join(projectDir, 'source', source.id)
    for (const name of await readdir(dir).catch(() => [] as string[])) await chmod(join(dir, name), 0o644).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
  return { removedSourceId: dropSource ? source.id : null }
}

/** 元PDFを使っているページが pageId だけか(削除のとき、元PDFも消すか尋ねるため) */
export async function isLastPageOfSource(projectDir: string, pageId: string): Promise<boolean> {
  const manifest = await readManifest(projectDir)
  const ref = manifest?.pages.find((page) => page.id === pageId)
  return ref !== undefined && !manifest!.pages.some((page) => page.id !== pageId && page.sourceId === ref.sourceId)
}

/** 目次(version 2 の document.json)を読む。version 1 なら null */
async function readManifest(projectDir: string): Promise<ProjectManifest | null> {
  const raw = JSON.parse(await readFile(join(projectDir, DOCUMENT_FILE), 'utf8')) as { version?: unknown }
  if (raw.version === 1) return null
  if (raw.version !== DOCUMENT_VERSION) throw new Error(`未対応の document.json バージョンです: ${String(raw.version)}`)
  const manifest = raw as ProjectManifest
  if (!Array.isArray(manifest.sources) || !Array.isArray(manifest.pages)) throw new Error('document.json の形式が正しくありません')
  for (const page of manifest.pages) if (!isSafeId(page.id)) throw new Error(`ページIDが正しくありません: ${String(page.id)}`)
  for (const source of manifest.sources) if (!isSafeId(source.id)) throw new Error(`元PDFのIDが正しくありません: ${String(source.id)}`)
  return manifest
}

/**
 * プロジェクトを読む。version 1(1つのPDF、document.json に全部入り)は今の形に読み替える。
 * 読み替えただけではファイルは書き換えない(migrated = true を返し、次の保存で新しい構成にする)。
 */
export async function loadDocument(projectDir: string): Promise<{ document: DocumentModel; migrated: boolean }> {
  const text = await readFile(join(projectDir, DOCUMENT_FILE), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') throw new Error(`${DOCUMENT_FILE} がありません: ${projectDir}`)
    throw err
  })
  const raw = JSON.parse(text) as { version?: unknown }
  if (raw.version === 1) return { document: migrateV1(raw as Parameters<typeof migrateV1>[0]), migrated: true }
  const manifest = await readManifest(projectDir)
  if (!manifest) throw new Error(`未対応の document.json バージョンです: ${String(raw.version)}`)
  const pages: Page[] = []
  for (const ref of manifest.pages) {
    const file = join(projectDir, pageFileName(ref.id))
    const content = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw new Error(`ページのファイルがありません: ${pageFileName(ref.id)}`)
      throw err
    })
    pages.push(fromPageFile(JSON.parse(content), ref))
  }
  return { document: { version: DOCUMENT_VERSION, createdAt: manifest.createdAt, sources: manifest.sources, pages }, migrated: false }
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
async function copyUsedFonts(projectDir: string, pages: readonly Page[], resources: ResourcePaths): Promise<void> {
  const used = new Set<string>()
  for (const page of pages) {
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

/**
 * 保存する。目次(document.json)と、変更のあったページのファイル(pages/<ページID>.json)だけを書く。
 * version 1 の document.json が残っていれば、document.v1.json として取っておく。
 */
export async function saveDocument(projectDir: string, payload: SavePayload, resources?: ResourcePaths): Promise<void> {
  const { manifest, pages, removedPageIds } = payload
  if (manifest.version !== DOCUMENT_VERSION) throw new Error(`未対応のバージョンです: ${String(manifest.version)}`)
  const listed = new Set(manifest.pages.map((page) => page.id))
  for (const page of pages) {
    if (!listed.has(page.id)) throw new Error(`目次にないページは保存できません: ${page.id}`)
  }
  if (resources) await copyUsedFonts(projectDir, pages, resources)
  for (const page of pages) await writeJson(join(projectDir, pageFileName(page.id)), toPageFile(page))

  const target = join(projectDir, DOCUMENT_FILE)
  const backup = join(projectDir, 'document.v1.json')
  const current = await readFile(target, 'utf8').then((text) => JSON.parse(text) as { version?: unknown }, () => null)
  if (current?.version === 1 && !(await exists(backup))) await copyFile(target, backup)
  // ページのファイルは目次から作り直す(渡された file は使わない)
  await writeJson(target, { ...manifest, pages: manifest.pages.map((page) => ({ ...page, file: pageFileName(page.id) })) })
  for (const id of removedPageIds) {
    if (!listed.has(id)) await rm(join(projectDir, pageFileName(id)), { force: true })
  }
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
  const run = shortId()
  return drafts.map((draft, index) => ({ id: `obj-${randomUUID()}`, ...draft, meta: uniqueShape(draft.meta, run), z: index }))
}

/** 図形のグループ番号(meta.shape.group)に、検出の回ごとの番号を足す(前に検出した図形と混ざらないように) */
function uniqueShape(meta: Record<string, unknown>, run: string): Record<string, unknown> {
  const shape = meta.shape as { kind?: unknown; group?: unknown } | undefined
  return shape && typeof shape.group === 'string' ? { ...meta, shape: { ...shape, group: `${shape.group}-${run}` } } : meta
}

/** 背景ラスターの一部を切り出して Image にする。PNG は背景と同じフォルダ(assets/<ページ>/)に書く */
async function cutImages(projectDir: string, target: DetectTarget, kind: ImageCutRequest['kind'], rect?: Rect): Promise<ImageObject[]> {
  const pngPath = resolveAsset(projectDir, target.asset)
  const drafts = await runWorker<ImageCutRequest, ImageCutDraft[]>('image-worker.js', 'Image', {
    kind,
    pngPath,
    pixelWidth: target.pixelWidth,
    pixelHeight: target.pixelHeight,
    imageTransform: target.transform,
    rect,
    outDir: dirname(pngPath),
    filePrefix: `${kind}-${randomUUID().slice(0, 8)}`
  })
  const assetDir = target.asset.replace(/[\\/][^\\/]+$/, '')
  return drafts.map((draft, index) => ({
    id: `obj-${randomUUID()}`,
    type: 'image',
    role: kind === 'qr' ? 'qr' : 'other',
    fieldCode: null,
    transform: draft.transform,
    z: index,
    tags: [],
    meta: { source: kind === 'qr' ? QR_SOURCE : 'crop' },
    asset: `${assetDir}/${draft.file}`,
    pixelWidth: draft.pixelWidth,
    pixelHeight: draft.pixelHeight
  }))
}

/** 背景ラスターから QRコードを見つけ、その範囲を Image(role=qr)として切り出す */
export function detectQr(projectDir: string, target: DetectTarget): Promise<ImageObject[]> {
  return cutImages(projectDir, target, 'qr')
}

/** 背景ラスターの rect(PDF座標)の範囲を Image として切り出す */
export function cropImage(projectDir: string, target: DetectTarget, rect: unknown): Promise<ImageObject[]> {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('切り出す範囲が正しくありません')
  }
  return cutImages(projectDir, target, 'crop', rect as Rect)
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
): Promise<TextDetection> {
  const engine = (await listOcrEngines(resources)).find((info) => info.id === engineId)
  if (!engine) throw new Error(`未登録の OCR エンジンです: ${engineId}`)
  if (!engine.available) throw new Error(`${engine.label} は使えません: ${engine.reason}`)
  const font = BUNDLED_FONTS.find((f) => f.family === DEFAULT_FONT_FAMILY && f.weight === DEFAULT_FONT_WEIGHT)!
  const fontFile = join(resources.fontsDir, font.file)
  if (!(await exists(fontFile))) {
    throw new Error(`フォント ${font.file} がありません。\`pnpm fonts\` で取得してください`)
  }
  const languageData = createRequire(__filename).resolve('@tesseract.js-data/jpn/package.json')
  const drafts = await runWorker<OcrRequest, TextDetectionDrafts>('ocr-worker.js', 'OCR', {
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
  const run = shortId()
  return {
    texts: drafts.texts.map((draft, index) => ({ id: `obj-${randomUUID()}`, ...draft, meta: uniqueShape(draft.meta, run), z: index })),
    paths: drafts.paths.map((draft, index) => ({ id: `obj-${randomUUID()}`, ...draft, meta: uniqueShape(draft.meta, run), z: index }))
  }
}

/** 出力先。1ページだけならそのページのフォルダ、複数ページなら exports/all/ */
function exportDir(projectDir: string, document: DocumentModel): string {
  if (document.pages.length === 0) throw new Error('出力するページがありません')
  const name = document.pages.length === 1 ? document.pages[0].id : 'all'
  if (!isSafeId(name)) throw new Error(`ページIDが正しくありません: ${String(name)}`)
  return join(projectDir, 'exports', name)
}

/**
 * 確定オブジェクトを exports/<ページID>/ に PDF / SVG / JSON として出力し、背景との差分を検証する。
 * document には出力するページだけを入れる。画面上の状態(未保存の変更を含む)をそのまま出力する。
 */
export async function exportDocument(
  projectDir: string,
  document: DocumentModel,
  resources: ResourcePaths
): Promise<ExportResult> {
  return runWorker<ExportRequest, ExportResult>('export-worker.js', 'Export', {
    projectDir,
    outDir: exportDir(projectDir, document),
    document,
    fontDirs: [join(projectDir, 'fonts'), resources.fontsDir]
  })
}

/** AI などに候補を確認してもらうためのデータ(候補の一覧とタイル画像)を exports/<ページID>/review/ に書き出す */
export async function exportReview(
  projectDir: string,
  document: DocumentModel,
  resources: ResourcePaths
): Promise<ReviewExportResult> {
  return runWorker<ExportRequest, ReviewExportResult>('review-worker.js', 'Review', {
    projectDir,
    outDir: exportDir(projectDir, document),
    document,
    fontDirs: [join(projectDir, 'fonts'), resources.fontsDir]
  })
}

const MAX_CORRECTIONS_BYTES = 5 * 1024 * 1024

/** 修正ファイル(JSON)を読む。中身の検証は renderer 側(corrections.ts)で行う */
export async function readCorrections(path: string): Promise<PickedCorrections> {
  const { size } = await stat(path)
  if (size > MAX_CORRECTIONS_BYTES) throw new Error(`修正ファイルが大きすぎます(${size} バイト、上限 5MB)`)
  const content = await readFile(path, 'utf8')
  try {
    return { fileName: basename(path), data: JSON.parse(content) as unknown }
  } catch (err) {
    throw new Error(`修正ファイルを JSON として読めません: ${err instanceof Error ? err.message : String(err)}`)
  }
}
