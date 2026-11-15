# 実アプリの自動確認

ビルド済みのアプリを起動し、DevTools プロトコルで画面を操作して動作を確かめるための道具。
単体テスト(`pnpm test`)では確かめられない、画面・IPC・utility process をまたぐ動きの確認に使う。

```sh
pnpm build                                            # out/ を作る(型チェックと単体テストも走る)
node scripts/e2e/smoke.mjs out/projects/daiichi-candidates   # 通し確認
```

- `stub.cjs`: Electron の main に `-r` で読み込ませ、ファイルダイアログと確認ダイアログの応答を環境変数で決める。本番のコードには入らない。
- `driver.mjs`: `launch()` でアプリを起動し、ボタンを押す・状態を読む・スクリーンショットを撮るためのハンドルを返す。
- `smoke.mjs`: 開く → 罫線検出 → 項目コード割り当て → 全件確定 → 出力 の通し確認。プロジェクトは一時フォルダにコピーして使う。
- 機能ごとの確認: `object-list.mjs` / `project-v2.mjs` / `vertical-text.mjs`(PDF を渡す)/ `manual-text.mjs` / `drag-move.mjs` / `text-edit.mjs` / `code-list.mjs` と `qr-image.mjs`(項目コードを割り当て済み・文字を検出済みのプロジェクトを渡す)/ `arrows.mjs`。使い方は各ファイルの先頭。

## 守ること
- 設定フォルダは一時フォルダを使う(`launch()` の既定)。利用者の「最近使ったプロジェクト」や前回のフォルダを書き換えない。
- `out/projects/` の既存のプロジェクトは直接開かず、コピーしてから使う。
- 新しい機能を確かめるときは、`smoke.mjs` に手順を足すか、同じ形のスクリプトを `scripts/e2e/` に足す。
- メニューの項目はネイティブなので操作できない。同じ処理を呼ぶツールバーのボタンで確かめる。

## 確認に使えるプロジェクト(Git 管理外)
`out/projects/` は利用者の作業エリア。ない場合は `samples/0026006-063.pdf` を取り込んで作る(`E2E_PDF` と `E2E_DEST` を指定して「PDFを取り込む」を押す)。
