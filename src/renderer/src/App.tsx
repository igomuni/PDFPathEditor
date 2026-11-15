import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_IMPORT_DPI, DEFAULT_IMPORT_PAGE, DEFAULT_IMPORT_PAGES, type MenuCommand, type RecentProject } from '../../shared/ipc'
import { diffPages, sourceOf, toManifest } from '../../shared/project'
import { Canvas, type CanvasHandle, type CanvasStatus } from './Canvas'
import type { OcrEngineId, OcrEngineInfo } from '../../shared/ocr'
import {
  applyCorrections,
  assignFieldCodes,
  confirmCandidates,
  deleteObjects,
  lineAxis,
  replaceObjectsOfType,
  setLayerOpacity,
  setLayerVisible
} from './commands'
import { objectBounds } from './coords'
import { planCorrections, type CorrectionPlan } from './corrections'
import { CorrectionsDialog } from './CorrectionsDialog'
import { fitTextToBox } from './textMetrics'
import { useFonts } from './fonts'
import { ObjectList } from './ObjectListPanel'
import { isVisible } from './objectList'
import { CodeList, collectCodes, TagSection } from './TagPanel'
import { TextPanel } from './TextPanel'
import { store, useStore } from './store'

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // ipcRenderer.invoke が付ける前置きを落とす
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function App() {
  const { document, projectDir, savedDocument, canUndo, canRedo, selection, diffMode, untaggedMode, currentPageId } = useStore()
  const canvasRef = useRef<CanvasHandle>(null)
  const [pagesSpec, setPagesSpec] = useState(DEFAULT_IMPORT_PAGES)
  const [dpi, setDpi] = useState(DEFAULT_IMPORT_DPI)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [status, setStatus] = useState<CanvasStatus>({ zoomPercent: 100, cursorPdf: null })
  const { fonts, loaded: fontsLoaded } = useFonts()
  const [ocrEngines, setOcrEngines] = useState<OcrEngineInfo[]>([])
  const [ocrEngineId, setOcrEngineId] = useState<OcrEngineId | null>(null)
  const [recent, setRecent] = useState<RecentProject[]>([])
  const [pendingCorrections, setPendingCorrections] = useState<{ fileName: string; plan: CorrectionPlan } | null>(null)

  useEffect(() => {
    void window.api.listOcrEngines().then((engines) => {
      setOcrEngines(engines)
      // 使えるもののうち先頭(macOS では Vision)を既定にする
      setOcrEngineId((engines.find((engine) => engine.available) ?? engines[0])?.id ?? null)
    })
  }, [])

  const dirty = document !== savedDocument
  const page = document?.pages.find((candidate) => candidate.id === currentPageId) ?? document?.pages[0] ?? null
  const source = document && page ? sourceOf(document, page) : null
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
      .filter((object) => ids.has(object.id) && isVisible(object))
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

  /** 保存する。失敗したら例外を投げる */
  const saveNow = useCallback(async (): Promise<void> => {
    const { document: current, savedDocument: saved } = store.getState()
    if (!current) return
    // 目次と、変更のあったページだけを書く
    const { changed, removedIds } = diffPages(saved, current)
    await window.api.saveDocument({ manifest: toManifest(current), pages: changed, removedPageIds: removedIds })
    store.markSaved(current)
  }, [])

  /** 未保存の変更があれば、保存するか尋ねる。続けてよければ true */
  const resolveUnsaved = useCallback(async (): Promise<boolean> => {
    const state = store.getState()
    if (state.document === state.savedDocument) return true
    const choice = await window.api.confirmUnsaved()
    if (choice === 'cancel') return false
    if (choice === 'save') await saveNow()
    return true
  }, [saveNow])

  const importPdf = useCallback(
    () =>
      run('PDFを取り込み中…', async () => {
        if (!(await resolveUnsaved())) return
        const project = await window.api.importPdf({ pages: pagesSpec, dpi })
        if (project) store.open(project)
      }),
    [run, pagesSpec, dpi, resolveUnsaved]
  )

  const addPdf = useCallback(
    () =>
      run('PDFを追加中…', async () => {
        const state = store.getState()
        if (!state.document) return
        // 追加したページは main がファイルに書くので、先に画面の変更を保存しておく
        if (state.document !== state.savedDocument) await saveNow()
        const added = await window.api.addPdf({ pages: pagesSpec, dpi })
        if (!added) return
        store.appendPages(added)
        const skipped = added.skippedPageNumbers.length > 0 ? `(取り込み済みの p.${added.skippedPageNumbers.join(', ')} は飛ばしました)` : ''
        setInfo(`${added.source.originalFileName} の p.${added.pages.map((p) => p.sourcePageNumber).join(', ')} を追加しました${skipped}。`)
      }),
    [run, pagesSpec, dpi, saveNow]
  )

  const openProject = useCallback(
    () =>
      run('プロジェクトを開いています…', async () => {
        if (!(await resolveUnsaved())) return
        const project = await window.api.openProject()
        if (project) store.open(project)
      }),
    [run, resolveUnsaved]
  )

  const openRecent = useCallback(
    (dir: string) =>
      run('プロジェクトを開いています…', async () => {
        if (!(await resolveUnsaved())) return
        store.open(await window.api.openRecentProject(dir))
      }),
    [run, resolveUnsaved]
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
      run('保存中…', saveNow),
    [run, saveNow]
  )

  const exportAll = useCallback(
    () =>
      run('出力して検証中…', async () => {
        const current = store.getState().document
        if (!current) return
        const target = store.currentPage()
        if (!target) return
        // 今のページだけを出力する
        const result = await window.api.exportDocument({ ...current, pages: [target] })
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

  const exportReview = useCallback(
    () =>
      run('確認用データを書き出し中…', async () => {
        const current = store.getState().document
        if (!current) return
        const target = store.currentPage()
        if (!target) return
        const result = await window.api.exportReview({ ...current, pages: [target] })
        setInfo(
          `${result.dir} に確認用データを書き出しました(テキスト ${result.textCount} 件、取れていないインク ${result.uncoveredCount} か所、背景に合っていないテキスト ${result.misfitCount} 件、ファイル ${result.files.length} 個)。`
        )
      }),
    [run]
  )

  const importCorrections = useCallback(
    () =>
      run('修正ファイルを読み込み中…', async () => {
        const current = store.getState().document
        if (!current) return
        const picked = await window.api.pickCorrections()
        if (!picked) return
        // 検証と計画だけ行い、適用はダイアログで確かめてから
        const target = store.currentPage()
        if (!target) return
        // 今のページに適用する(修正ファイルの page が違えば、対象なしとして止める)
        setPendingCorrections({ fileName: picked.fileName, plan: planCorrections([target], picked.data, fitTextToBox) })
      }),
    [run]
  )

  const applyPendingCorrections = (): void => {
    const current = store.getState().document
    if (!pendingCorrections || !current) return
    const { plan, fileName } = pendingCorrections
    setPendingCorrections(null)
    store.execute(applyCorrections(current, plan))
    store.sealHistory()
    // 変わったところを確かめやすいよう、置換・追加したオブジェクトを選択する
    store.select([...plan.replacements.keys(), ...plan.additions.map((object) => object.id)])
    setInfo(
      `${fileName} を適用しました(置換 ${plan.replacements.size} 件 / 追加 ${plan.additions.length} 件 / 削除 ${plan.deletions.size} 件${plan.rejected.length > 0 ? ` / 適用できず ${plan.rejected.length} 件` : ''})。変更したオブジェクトを選択しています。`
    )
  }

  const detectLines = useCallback(
    () =>
      run('罫線を検出中…', async () => {
        const current = store.currentPage()
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
        const current = store.currentPage()
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
    const { command, summary } = assignFieldCodes(current, objectBounds, undefined, store.currentPage()?.id)
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
  const confirmAll = withDocument((current) => store.execute(confirmCandidates(current, undefined, store.currentPage()?.id)))
  const deleteSelection = withDocument((current) => store.execute(deleteObjects(current, store.getState().selection.ids)))
  const selectAll = withDocument(() =>
    store.select(
      (store.currentPage()?.layers ?? [])
        .filter((layer) => layer.visible && !layer.locked)
        .flatMap((layer) => layer.objects.filter(isVisible).map((object) => object.id))
    )
  )

  useEffect(() => {
    const handlers: Record<MenuCommand, () => void> = {
      'import-pdf': () => void importPdf(),
      'add-pdf': () => void addPdf(),
      'open-project': () => void openProject(),
      save: () => void save(),
      export: () => void exportAll(),
      'export-review': () => void exportReview(),
      'import-corrections': () => void importCorrections(),
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
  }, [importPdf, addPdf, openProject, save, exportAll, exportReview, importCorrections, detectLines, detectText])

  // 未保存かどうかを main に伝える(閉じるときの確認用)
  useEffect(() => {
    window.api.setDirty(dirty)
  }, [dirty])

  // 閉じるときに「保存」が選ばれたら、保存してから閉じる。失敗したら閉じずにエラーを見せる
  useEffect(
    () =>
      window.api.onSaveBeforeClose(() => {
        void run('保存中…', async () => {
          await saveNow()
          window.api.closeNow()
        })
      }),
    [run, saveNow]
  )

  useEffect(() => {
    const name = projectDir ? projectDir.split(/[\\/]/).pop() : null
    window.document.title = name ? `${dirty ? '● ' : ''}${name} — PDFPathEditor` : 'PDFPathEditor'
  }, [projectDir, dirty])

  const importControls = (
    <>
      <label>
        ページ
        <input
          type="text"
          className="pages-spec"
          value={pagesSpec}
          onChange={(e) => setPagesSpec(e.target.value)}
          title="取り込むページ。例: 2、1-3,5"
          spellCheck={false}
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
      {document && (
        <button onClick={() => void addPdf()} disabled={busy !== null} title="開いているプロジェクトに、PDFの指定したページを追加する(同じPDFなら元PDFは共有する)">
          PDFを追加…
        </button>
      )}
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
        {document && document.pages.length > 1 && page && (
          <select
            className="page-select"
            value={page.id}
            title="表示するページ"
            onChange={(e) => {
              store.setCurrentPage(e.target.value)
              e.currentTarget.blur()
            }}
          >
            {document.pages.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {sourceOf(document, candidate)?.originalFileName ?? '?'} p.{candidate.sourcePageNumber}
              </option>
            ))}
          </select>
        )}
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
              onClick={() => void exportReview()}
              disabled={busy !== null}
              title="AI などに候補を確認してもらうためのデータ(候補の一覧とタイル画像)を exports/review/ に書き出す (⇧⌘E)"
            >
              確認用データ
            </button>
            <button
              onClick={() => void importCorrections()}
              disabled={busy !== null}
              title="修正ファイル(JSON)を取り込み、内容を確かめてから一括で適用する (⇧⌘I)"
            >
              修正を取り込む…
            </button>
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
        {page && (
          <aside className="sidebar">
            <ObjectList page={page} selection={selection} onReveal={(object) => canvasRef.current?.reveal(objectBounds(object))} />
          </aside>
        )}
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

      {pendingCorrections && (
        <CorrectionsDialog
          fileName={pendingCorrections.fileName}
          plan={pendingCorrections.plan}
          onApply={applyPendingCorrections}
          onCancel={() => setPendingCorrections(null)}
        />
      )}

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
              {source?.originalFileName ?? '(元PDF不明)'} p.{page.sourcePageNumber}/{source?.pageCount ?? '?'}
            </span>
            {source?.encrypted && <span title="元PDFは暗号化されています。読み取りのみ行います">暗号化PDF(読み取り専用)</span>}
            {source && <span title={source.sha256}>sha256 {source.sha256.slice(0, 12)}…</span>}
          </>
        ) : (
          <span>プロジェクト未選択</span>
        )}
      </footer>
    </div>
  )
}
