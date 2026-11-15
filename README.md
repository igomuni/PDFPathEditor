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
pnpm fonts      # 同梱フォント(Noto Sans JP / Noto Serif JP)を resources/fonts/ に取得
pnpm ocr:build  # macOS のみ: Vision の OCR ヘルパーをビルド(Xcode のコマンドラインツールが必要)
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

### 現状(PoC マイルストーン3)
- 選択: 線をクリック(Shift で追加・解除)、何もない場所をドラッグで範囲選択、⌘A ですべて選択、Esc で解除
- 微調整: 矢印キーで背景ラスターの1画素ぶん移動(Shift で10倍、Alt で 1/10)。端点のハンドルをクリックすると、その端点だけを動かせる(水平・垂直は保つ)
- 確定: Enter で選択した候補を「確定オブジェクト」レイヤーへ移す。「全件確定」(⇧⌘Enter)もある。Delete で削除
- 差分表示(⇧⌘D): 背景を赤、Pathをシアンで重ねる。一致=黒 / 背景のみ=赤 / Pathのみ=シアン
- すべての編集は Undo/Redo できる

### 現状(PoC マイルストーン4)
- 「文字を検出」(⌘T)で、背景ラスターを OCR にかけ、行ごとの Text オブジェクトを候補レイヤーに入れる。エンジンは macOS Vision と Tesseract(tesseract.js)を選べる
- 候補のサイズ・位置・字間は、インクの範囲に Noto Sans JP で組んだ文字が重なるように推定する。文字内容は人が確定する前提
- Text を選択すると右のパネルで文字列・フォント・太さ・サイズ・字間・配置・色を編集できる(Undo/Redo 対応)
- 保存すると、使っているフォントをプロジェクトの `fonts/` にコピーする

### 構成
- `src/main/` ファイルI/O、プロジェクト管理、PDFラスタライズと候補抽出(utility process)
- `src/main/vectorize/` Vectorizer の実装(罫線検出)
- `src/main/ocr/` OCR エンジンと後処理
- `native/vision-ocr/` macOS Vision を呼ぶ Swift ヘルパー
- `scripts/` フォント取得スクリプト
- `src/preload/` renderer に公開するAPI
- `src/renderer/` React + SVGキャンバス
- `src/shared/` ドキュメントモデルとIPCの型
