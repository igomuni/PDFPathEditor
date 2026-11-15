import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_IMPORT_DPI, DEFAULT_IMPORT_PAGE, type MenuCommand, type RecentProject } from '../../shared/ipc'
import { Canvas, type CanvasHandle, type CanvasStatus } from './Canvas'
import type { OcrEngineId, OcrEngineInfo } from '../../shared/ocr'
import {
  assignFieldCodes,
  confirmCandidates,
  deleteObjects,
  lineAxis,
  replaceObjectsOfType,
  setLayerOpacity,
  setLayerVisible
} from './commands'
import { objectBounds } from './coords'
import { useFonts } from './fonts'
import { CodeList, collectCodes, TagSection } from './TagPanel'
import { TextPanel } from './TextPanel'
import { store, useStore } from './store'

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // ipcRenderer.invoke が付ける前置きを落とす
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function App() {
  const { document, projectDir, savedDocument, canUndo, canRedo, selection, diffMode, untaggedMode } = useStore()
  const canvasRef = useRef<CanvasHandle>(null)
  const [pageNumber, setPageNumber] = useState(DEFAULT_IMPORT_PAGE)
  const [dpi, setDpi] = useState(DEFAULT_IMPORT_DPI)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [status, setStatus] = useState<CanvasStatus>({ zoomPercent: 100, cursorPdf: null })
  const { fonts, loaded: fontsLoaded } = useFonts()
  const [ocrEngines, setOcrEngines] = useState<OcrEngineInfo[]>([])
  const [ocrEngineId, setOcrEngineId] = useState<OcrEngineId | null>(null)
  const [recent, setRecent] = useState<RecentProject[]>([])

  useEffect(() => {
    void window.api.listOcrEngines().then((engines) => {
      setOcrEngines(engines)
      // 使えるもののうち先頭(macOS では Vision)を既定にする
      setOcrEngineId((engines.find((engine) => engine.available) ?? engines[0])?.id ?? null)
    })
  }, [])

  const dirty = document !== savedDocument
  const page = document?.pages[0] ?? null
  const background = page?.layers.find((layer) => layer.kind === 'background') ?? null
  const candidates = page?.layers.find((layer) => layer.kind === 'candidates') ?? null
  const confirmed = page?.layers.find((layer) => layer.kind === 'confirmed') ?? null
  const backgroundImage = background?.objects.find((object) => object.type === 'image') ?? null
  // 微調整の単位は背景ラスターの1画素(pt)
  const nudgeStep = backgroundImage ? Math.abs(backgroundImage.transform[0]) / backgroundImage.pixelWidth : 72 / DEFAULT_IMPORT_DPI

  const selectionSummary = useMemo(() => {
    if (!page || selection.ids.length === 0) return null
    if (selection.ids.length > 1) return `選択 ${selection.ids.length} 件`
    for (const layer of page.layers) {
      const object = layer.objects.find((candidate) => candidate.id === selection.ids[0])
      if (!object) continue
      const code = object.fieldCode ? ` [${object.fieldCode}]` : ''
      if (object.type === 'text') {
        return `選択: ${layer.name} テキスト「${object.text}」 ${object.fontFamily} ${object.fontSize}pt${code}`
      }
      if (object.type !== 'path') return `選択: ${layer.name}`
      if (object.role === 'inputCell') return `選択: ${layer.name} 記入欄${code}`
      const [p, q] = [object.nodes[0], object.nodes.at(-1)!]
      const axis = lineAxis(object)
      const kind = axis === 'h' ? '横線' : axis === 'v' ? '縦線' : 'Path'
      const node = selection.node ? ` / 頂点 ${selection.node.index + 1}` : ''
      return `選択: ${layer.name} ${kind} (${p.x}, ${p.y}) → (${q.x}, ${q.y}) 線幅 ${object.strokeWidth}pt${object.dash ? ' 点線' : ''}${node}`
    }
    return null
  }, [page, selection])

  const selectedObjects = useMemo(() => {
    if (!page || selection.ids.length === 0) return []
    const ids = new Set(selection.ids)
    return page.layers
      .filter((layer) => layer.visible && !layer.locked)
      .flatMap((layer) => layer.objects)
      .filter((object) => ids.has(object.id))
  }, [page, selection.ids])
  const selectedTexts = useMemo(() => selectedObjects.filter((object) => object.type === 'text'), [selectedObjects])
  const codeEntries = useMemo(() => (page ? collectCodes(page) : []), [page])
  const codeNames = useMemo(() => codeEntries.map((entry) => entry.code), [codeEntries])
  // 選択中のオブジェクトが持つ項目コード。同じコードのオブジェクトをキャンバスで強調する
  const activeCodes = useMemo(
    () => new Set(selectedObjects.flatMap((object) => (object.fieldCode === null ? [] : [object.fieldCode]))),
    [selectedObjects]
  )

  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    setInfo(null)
    try {
      await task()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const importPdf = useCallback(
    () =>
      run('PDFを取り込み中…', async () => {
        const project = await window.api.importPdf({ pageNumber, dpi })
        if (project) store.open(project)
      }),
    [run, pageNumber, dpi]
  )

  const openProject = useCallback(
    () =>
      run('プロジェクトを開いています…', async () => {
        const project = await window.api.openProject()
        if (project) store.open(project)
      }),
    [run]
  )

  const openRecent = useCallback(
    (dir: string) =>
      run('プロジェクトを開いています…', async () => {
        store.open(await window.api.openRecentProject(dir))
      }),
    [run]
  )

  useEffect(() => {
    void window.api.listRecentProjects().then(setRecent)
    const offChanged = window.api.onRecentProjectsChanged(setRecent)
    const offPicked = window.api.onRecentProjectPicked((dir) => void openRecent(dir))
    return () => {
      offChanged()
      offPicked()
    }
  }, [openRecent])

  const save = useCallback(
    () =>
      run('保存中…', async () => {
        const current = store.getState().document
        if (!current) return
        await window.api.saveDocument(current)
        store.markSaved(current)
      }),
    [run]
  )

  const exportAll = useCallback(
    () =>
      run('出力して検証中…', async () => {
        const current = store.getState().document
        if (!current) return
        const result = await window.api.exportDocument(current)
        const percent = (value: number): string => `${(value * 100).toFixed(2)}%`
        const summary = result.pages
          .map((page) =>
            page.metrics
              ? `p.${page.pageNumber}: ${page.objectCount} 件 / 再現率 ${percent(page.metrics.recall)} / 過剰率 ${percent(page.metrics.excess)} / 不一致画素率 ${percent(page.metrics.mismatch)}`
              : `p.${page.pageNumber}: ${page.objectCount} 件(背景なし、検証なし)`
          )
          .join(' / ')
        setInfo(`${result.dir} に出力しました(${result.files.join(', ')})。${summary}`)
      }),
    [run]
  )

  const detectLines = useCallback(
    () =>
      run('罫線を検出中…', async () => {
        const current = store.getState().document?.pages[0]
        const image = current?.layers
          .find((layer) => layer.kind === 'background')
          ?.objects.find((object) => object.type === 'image')
        const target = current?.layers.find((layer) => layer.kind === 'candidates')
        if (!image || !target) return
        const paths = await window.api.detectCandidates({
          asset: image.asset,
          transform: image.transform,
          pixelWidth: image.pixelWidth,
          pixelHeight: image.pixelHeight
        })
        const latest = store.getState().document
        if (latest) store.execute(replaceObjectsOfType(latest, target.id, 'path', paths, '罫線を検出'))
      }),
    [run]
  )

  const detectText = useCallback(
    () =>
      run('文字を検出中…', async () => {
        if (!ocrEngineId) return
        const current = store.getState().document?.pages[0]
        const image = current?.layers
          .find((layer) => layer.kind === 'background')
          ?.objects.find((object) => object.type === 'image')
        const target = current?.layers.find((layer) => layer.kind === 'candidates')
        if (!image || !target) return
        const texts = await window.api.detectText(
          { asset: image.asset, transform: image.transform, pixelWidth: image.pixelWidth, pixelHeight: image.pixelHeight },
          ocrEngineId
        )
        const latest = store.getState().document
        if (latest) store.execute(replaceObjectsOfType(latest, target.id, 'text', texts, '文字を検出'))
      }),
    [run, ocrEngineId]
  )

  const withDocument = (action: (current: NonNullable<typeof document>) => void) => (): void => {
    const current = store.getState().document
    if (current) action(current)
  }
  const confirmSelection = withDocument((current) =>
    store.execute(confirmCandidates(current, store.getState().selection.ids))
  )
  const assignCodes = withDocument((current) => {
    // 文字の外形は画面のフォントで実測する
    const { command, summary } = assignFieldCodes(current, objectBounds)
    store.execute(command)
    setError(null)
    setInfo(
      summary.codes === 0
        ? '項目コードの印字が見つかりませんでした。先に「罫線を検出」と「文字を検出」を実行してください。'
        : command
          ? `印字された項目コード ${summary.codes} 件を見つけ、${summary.tagged} 件のオブジェクトに項目コードを付け、記入欄を ${summary.cells} 件作りました。`
          : `印字された項目コード ${summary.codes} 件はすべて割り当て済みです。`
    )
  })
  const confirmAll = withDocument((current) => store.execute(confirmCandidates(current)))
  const deleteSelection = withDocument((current) => store.execute(deleteObjects(current, store.getState().selection.ids)))
  const selectAll = withDocument((current) =>
    store.select(
      (current.pages[0]?.layers ?? [])
        .filter((layer) => layer.visible && !layer.locked)
        .flatMap((layer) => layer.objects.map((object) => object.id))
    )
  )

  useEffect(() => {
    const handlers: Record<MenuCommand, () => void> = {
      'import-pdf': () => void importPdf(),
      'open-project': () => void openProject(),
      save: () => void save(),
      export: () => void exportAll(),
      undo: () => store.undo(),
      redo: () => store.redo(),
      'detect-lines': () => void detectLines(),
      'detect-text': () => void detectText(),
      'assign-field-codes': assignCodes,
      'confirm-selection': confirmSelection,
      'confirm-all': confirmAll,
      'delete-selection': deleteSelection,
      'select-all': selectAll,
      'toggle-diff': () => store.setDiffMode(!store.getState().diffMode),
      'toggle-untagged': () => store.setUntaggedMode(!store.getState().untaggedMode),
      'zoom-in': () => canvasRef.current?.zoomIn(),
      'zoom-out': () => canvasRef.current?.zoomOut(),
      'zoom-fit': () => canvasRef.current?.zoomFit(),
      'zoom-100': () => canvasRef.current?.zoom100()
    }
    return window.api.onMenuCommand((command) => handlers[command]())
  }, [importPdf, openProject, save, exportAll, detectLines, detectText])

  useEffect(() => {
    const name = projectDir ? projectDir.split(/[\\/]/).pop() : null
    window.document.title = name ? `${dirty ? '● ' : ''}${name} — PDFPathEditor` : 'PDFPathEditor'
  }, [projectDir, dirty])

  const importControls = (
    <>
      <label>
        ページ
        <input
          type="number"
          min={1}
          value={pageNumber}
          onChange={(e) => setPageNumber(Math.max(1, Math.trunc(e.target.valueAsNumber) || 1))}
        />
      </label>
      <label>
        dpi
        <input
          type="number"
          min={36}
          max={1200}
          step={1}
          value={dpi}
          onChange={(e) => setDpi(e.target.valueAsNumber || DEFAULT_IMPORT_DPI)}
        />
      </label>
      <button onClick={() => void importPdf()} disabled={busy !== null}>
        PDFを取り込む…
      </button>
      <button onClick={() => void openProject()} disabled={busy !== null}>
        プロジェクトを開く…
      </button>
      {recent.length > 0 && (
        <select
          className="recent-select"
          value=""
          disabled={busy !== null}
          title="最近使ったプロジェクトを開く"
          onChange={(e) => {
            const dir = e.target.value
            e.currentTarget.blur()
            if (dir) void openRecent(dir)
          }}
        >
          <option value="">最近使ったプロジェクト</option>
          {recent.map((entry) => (
            <option key={entry.dir} value={entry.dir} title={entry.dir}>
              {entry.dir.split(/[\\/]/).pop()}
            </option>
          ))}
        </select>
      )}
    </>
  )

  return (
    <div className="app">
      <header className="toolbar">
        {importControls}
        {document && background && (
          <>
            <span className="separator" />
            <button onClick={() => store.undo()} disabled={!canUndo} title="元に戻す (⌘Z)">
              ↶
            </button>
            <button onClick={() => store.redo()} disabled={!canRedo} title="やり直す (⇧⌘Z)">
              ↷
            </button>
            <button onClick={() => void save()} disabled={!dirty || busy !== null}>
              保存
            </button>
            <button
              onClick={() => void exportAll()}
              disabled={busy !== null || !confirmed || confirmed.objects.length === 0}
              title="確定オブジェクトを PDF / SVG / JSON に出力し、背景との差分を検証する (⌘E)"
            >
              出力
            </button>
            <span className="separator" />
            <label>
              <input
                type="checkbox"
                checked={background.visible}
                onChange={(e) => {
                  store.execute(setLayerVisible(background, e.target.checked))
                  e.currentTarget.blur()
                }}
              />
              背景
            </label>
            <label>
              不透明度
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={background.opacity}
                onChange={(e) => store.execute(setLayerOpacity(background, e.target.valueAsNumber))}
                onPointerUp={(e) => {
                  store.sealHistory()
                  // フォーカスが残ると矢印キーがスライダーに取られる
                  e.currentTarget.blur()
                }}
                onKeyUp={() => store.sealHistory()}
                onBlur={() => store.sealHistory()}
              />
            </label>
            <span className="separator" />
            <button onClick={() => void detectLines()} disabled={busy !== null} title="背景ラスターから罫線・枠の候補を抽出 (⌘D)">
              罫線を検出
            </button>
            <button
              onClick={() => void detectText()}
              disabled={busy !== null || !ocrEngineId}
              title="背景ラスターを OCR にかけてテキストの候補を抽出 (⌘T)"
            >
              文字を検出
            </button>
            <select
              value={ocrEngineId ?? ''}
              onChange={(e) => {
                setOcrEngineId(e.target.value as OcrEngineId)
                e.currentTarget.blur()
              }}
              title="OCR エンジン"
            >
              {ocrEngines.map((engine) => (
                <option key={engine.id} value={engine.id} disabled={!engine.available} title={engine.reason ?? undefined}>
                  {engine.label}
                  {engine.available ? '' : '(使用不可)'}
                </option>
              ))}
            </select>
            <button
              onClick={assignCodes}
              disabled={busy !== null}
              title="印字された項目コード(G01 等)を見つけ、コードと右隣の記入欄に割り当てる (⌘G)"
            >
              項目コードを割り当て
            </button>
            {candidates && (
              <label>
                <input
                  type="checkbox"
                  checked={candidates.visible}
                  onChange={(e) => {
                    store.execute(setLayerVisible(candidates, e.target.checked))
                    e.currentTarget.blur()
                  }}
                />
                候補
              </label>
            )}
            {confirmed && (
              <label>
                <input
                  type="checkbox"
                  checked={confirmed.visible}
                  onChange={(e) => {
                    store.execute(setLayerVisible(confirmed, e.target.checked))
                    e.currentTarget.blur()
                  }}
                />
                確定
              </label>
            )}
            <label title="背景を赤、Pathをシアンで重ねる。一致=黒 / 背景のみ=赤 / Pathのみ=シアン (⇧⌘D)">
              <input
                type="checkbox"
                checked={diffMode}
                onChange={(e) => {
                  store.setDiffMode(e.target.checked)
                  e.currentTarget.blur()
                }}
              />
              差分
            </label>
            <label title="項目コードが付いていないテキストと記入欄を強調する (⇧⌘G)">
              <input
                type="checkbox"
                checked={untaggedMode}
                onChange={(e) => {
                  store.setUntaggedMode(e.target.checked)
                  e.currentTarget.blur()
                }}
              />
              未付与
            </label>
            <span className="separator" />
            <button onClick={confirmSelection} disabled={selection.ids.length === 0} title="選択した候補を確定レイヤーへ移す (Enter)">
              選択を確定
            </button>
            <button onClick={confirmAll} disabled={!candidates || candidates.objects.length === 0} title="候補を全件確定する (⇧⌘Enter)">
              全件確定
            </button>
            <span className="separator" />
            <button onClick={() => canvasRef.current?.zoomOut()} title="縮小 (-)">
              −
            </button>
            <button onClick={() => canvasRef.current?.zoomIn()} title="拡大 (+)">
              +
            </button>
            <button onClick={() => canvasRef.current?.zoomFit()} title="ページ全体 (5)">
              全体
            </button>
            <button onClick={() => canvasRef.current?.zoom100()} title="100% (1)">
              100%
            </button>
          </>
        )}
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError(null)}>閉じる</button>
        </div>
      )}

      {info && (
        <div className="info" role="status">
          {info}
          <button onClick={() => setInfo(null)}>閉じる</button>
        </div>
      )}

      {fontsLoaded && fonts.length === 0 && (
        <div className="notice">
          フォントが取得されていません。<code>pnpm fonts</code> を実行してから再起動してください(テキストは代わりのフォントで表示されます)。
        </div>
      )}

      <div className="body">
        <main className="workspace">
          {page ? (
            <Canvas
              ref={canvasRef}
              page={page}
              selection={selection}
              diffMode={diffMode}
              untaggedMode={untaggedMode}
              activeCodes={activeCodes}
              nudgeStep={nudgeStep}
              onStatus={setStatus}
            />
          ) : (
            <div className="empty">
              <p>PDFを取り込むか、既存のプロジェクトフォルダを開いてください。</p>
              <p className="hint">
                既定では {DEFAULT_IMPORT_PAGE} ページ目を {DEFAULT_IMPORT_DPI}dpi で背景ラスターにします。元PDFは変更しません。
              </p>
              {recent.length > 0 && (
                <div className="recent-list">
                  <h2>最近使ったプロジェクト</h2>
                  <ul>
                    {recent.map((entry) => (
                      <li key={entry.dir}>
                        <button onClick={() => void openRecent(entry.dir)} disabled={busy !== null} title={entry.dir}>
                          <span className="name">{entry.dir.split(/[\\/]/).pop()}</span>
                          <span className="path">{entry.dir}</span>
                          <span className="date">{new Date(entry.openedAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {busy && <div className="busy">{busy}</div>}
        </main>
        {page && (
          <aside className="panel">
            {selectedObjects.length > 0 && <TagSection objects={selectedObjects} codes={codeNames} />}
            {selectedTexts.length > 0 && <TextPanel texts={selectedTexts} fonts={fonts} />}
            <CodeList entries={codeEntries} activeCodes={activeCodes} />
          </aside>
        )}
      </div>

      <footer className="statusbar">
        {document && page ? (
          <>
            <span>{Math.round(status.zoomPercent)}%</span>
            <span>
              {status.cursorPdf
                ? `x ${status.cursorPdf.x.toFixed(2)} pt, y ${status.cursorPdf.y.toFixed(2)} pt`
                : 'x —, y —'}
            </span>
            {candidates && confirmed && (
              <span>
                候補 {candidates.objects.length} 件 / 確定 {confirmed.objects.length} 件
              </span>
            )}
            {selectionSummary && <span className="selection-summary">{selectionSummary}</span>}
            <span className="grow" />
            <span>
              {document.source.originalFileName} p.{page.sourcePageNumber}/{document.source.pageCount}
            </span>
            {document.source.encrypted && <span title="元PDFは暗号化されています。読み取りのみ行います">暗号化PDF(読み取り専用)</span>}
            <span title={document.source.sha256}>sha256 {document.source.sha256.slice(0, 12)}…</span>
          </>
        ) : (
          <span>プロジェクト未選択</span>
        )}
      </footer>
    </div>
  )
}
