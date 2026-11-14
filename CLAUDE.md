# CLAUDE.md

## プロジェクト概要
PDFPathEditor: 画像PDFを再編集可能な構造化データ(Path / Text / Image)にし、人手でズレを微調整して、PDF/SVG/JSONへ出力するElectronデスクトップツール。

## 最初にやること
実装の前に必ず `docs/design.md` を読むこと。決定事項(§3)と未決事項(§8)を区別すること。未決事項を勝手に確定させず、選択肢と推奨を示して確認する。

## 技術スタック(決定済み)
- Electron(main: ファイルI/O・PDF処理・重い処理 / renderer: UI)
- TypeScript, React, SVGキャンバス(Inkscape風のzoom/pan/ノード編集)
- ドキュメントモデル(JSON)を唯一の正とする。元PDFは書き換えない

## 方針
- 元PDFは背景レイヤー(読み取り専用)。出力PDFはモデルから生成する
- 内部座標はPDF座標(pt、左下原点)。SVG座標への変換層を1枚挟む
- Undo/Redoは最初から入れる(コマンドパターン)
- Path化(Vectorizer)は差し替え可能なインターフェースにする
- Textは実フォントのTextオブジェクト。フォント・サイズ編集に対応。日本語フォントは埋め込む
- 各オブジェクトに安定ID・role・fieldCode(G01等の項目コード)を持たせる

## 参考
- ビュー/操作感: https://gitlab.com/inkscape/inkscape
- Electron構成: https://github.com/stablyai/orca

## サンプル
`samples/` はGit管理外。取得元は `samples/README.md`。
