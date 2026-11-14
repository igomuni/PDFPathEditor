# PDFPathEditor

PDFを読み込み、Path / Text / Image を編集するElectronデスクトップツール。
元PDFが画像PDFでも Path 化し、人間がズレを微調整できるようにする。

- 元PDFは背景レイヤー(読み取り専用)として管理し、出力PDFとは分離する
- 編集結果は構造化データ(JSON)として保持し、PDF / SVG / JSON に出力する
- 当面のPoC対象: 確定申告書(案)第一表

詳細は [docs/design.md](docs/design.md) を参照。

## 開発

```sh
pnpm install
pnpm dev        # 開発起動(HMR)
pnpm test       # 単体テスト
pnpm build      # 型チェック + テスト + ビルド(out/)
pnpm start      # ビルド済みを起動
```

### 現状(PoC マイルストーン1)
- 「PDFを取り込む…」でPDFと作成先を選ぶと、プロジェクトフォルダ(`source/ assets/ fonts/ exports/ document.json`)を作り、指定ページを指定dpi(既定: 2ページ目・300dpi)で背景ラスターにして表示する
- ズーム: ⌘/Ctrl+ホイール、ピンチ、`+` / `-`、`1`(100%)、`5`(ページ全体)
- パン: ホイール/2本指スクロール、中ボタンドラッグ、Space+ドラッグ

### 現状(PoC マイルストーン2)
- 「罫線を検出」(⌘D)で、背景ラスターから水平・垂直の罫線と点線を検出し、「自動抽出の候補」レイヤーに Path として入れる。候補はマゼンタで背景に重ねて表示する
- 検出は候補を出すだけで、Undo/Redo できる。再実行すると候補を入れ替える
- `pnpm test` で検出器の単体テストを実行する

### 構成
- `src/main/` ファイルI/O、プロジェクト管理、PDFラスタライズと候補抽出(utility process)
- `src/main/vectorize/` Vectorizer の実装(罫線検出)
- `src/preload/` renderer に公開するAPI
- `src/renderer/` React + SVGキャンバス
- `src/shared/` ドキュメントモデルとIPCの型
