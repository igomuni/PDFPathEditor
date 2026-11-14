# PDFPathEditor

PDFを読み込み、Path / Text / Image を編集するElectronデスクトップツール。
元PDFが画像PDFでも Path 化し、人間がズレを微調整できるようにする。

- 元PDFは背景レイヤー(読み取り専用)として管理し、出力PDFとは分離する
- 編集結果は構造化データ(JSON)として保持し、PDF / SVG / JSON に出力する
- 当面のPoC対象: 確定申告書(案)第一表

詳細は [docs/design.md](docs/design.md) を参照。
