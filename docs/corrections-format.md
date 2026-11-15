# 修正ファイルの形式(v1)

アプリの外(AI など)で候補を確認し、直す内容を JSON にまとめてアプリに取り込むための形式。
型の定義は `src/shared/corrections.ts`、検証は `src/renderer/src/corrections.ts`。

## 流れ
1. アプリで「確認用データ」(⇧⌘E)を実行する。プロジェクトの `exports/review/` に次のファイルができる。
   - `page-NNNN-review.json`: 候補の Text の一覧(ID・文字列・フォント・サイズ・位置)と、機械的に洗い出した要確認箇所
   - `page-NNNN-tile-rR-cC.png`: 背景(黒)に候補の文字(赤)を重ねたタイル画像(3 列 × 4 行、300dpi)
2. タイル画像と `review.json` を見て、修正ファイルを作る。
3. アプリで「修正を取り込む…」(⇧⌘I)を実行する。置換・追加・削除の件数と、適用できない操作が表示されるので、確かめて適用する。
   適用は 1 回の操作になり、「元に戻す」1 回で全部戻る。

## 確認用データの読み方
- 座標はすべて PDF 座標(pt、ページ左下が原点、y は上向き)。
- タイル画像の青枠 `U<番号>` は `uncovered[].number`。罫線にも候補の Text にも対応しない背景のインク(取れていない文字、記号、QR コードなど)で、`box` がその範囲。
- タイル画像の橙枠 `T<番号>` は `texts[].index`。描いた文字のインクの 25% 超が背景に対応しない Text(`misfit: true`)。読み違い、大きすぎるサイズ、位置ずれが多い。
- `texts[].inkBox` は、その Text を今の設定で描いたときのインクの範囲。
- 画素との換算: `x_px = (x - mediaBox[0]) * raster.pxPerPt`、`y_px = (mediaBox[3] - y) * raster.pxPerPt`(画像は左上が原点)。

## 修正ファイル
```json
{
  "version": 1,
  "page": 2,
  "note": "任意のメモ",
  "operations": [
    { "op": "replace", "id": "obj-…", "set": { "text": "G17" }, "reason": "I を 1 と読み違い" },
    { "op": "replace", "id": "obj-…", "set": { "text": "㊿", "fitBox": [431.2, 328.1, 438.6, 335.5] } },
    { "op": "add", "text": { "text": "㋔", "fitBox": [154.9, 520.3, 162.4, 527.9] } },
    { "op": "add", "text": { "text": "当", "x": 133.5, "y": 548.2, "fontSize": 8.2 } },
    { "op": "delete", "id": "obj-…", "reason": "QR コードを読んだゴミ" }
  ]
}
```

- `page`: 対象ページ(元 PDF でのページ番号)。省略すると最初のページ。
- `reason`: 任意。アプリは使わない(作った側の記録用)。
- 操作は最大 5000 件。同じ `id` への操作は 1 つだけ(2 つ目以降は適用されない)。

### 操作
| op | 必須 | 内容 |
|---|---|---|
| `replace` | `id`, `set` | 既存の Text の属性を上書きする。指定しなかった属性は元のまま |
| `add` | `text` | Text を候補レイヤーに追加する。`text.text` と、`fitBox` または `x`・`y`・`fontSize` が必要 |
| `delete` | `id` | オブジェクトを削除する(Text 以外も可) |

対象にできるのは、候補レイヤーと確定レイヤーのオブジェクト。背景は変更できない。

### 属性(`set` と `text` の中身)
| 属性 | 型 | 説明 |
|---|---|---|
| `text` | 文字列 | 1〜500 字、改行なし |
| `fitBox` | `[x0, y0, x1, y1]` | 文字のインクが収まる枠。指定すると、サイズ・位置・字間をアプリがフォントの字形から決める(`fontSize`・`x`・`y`・`letterSpacing` より優先)。配置は左揃えになる |
| `x`, `y` | 数値 | ベースライン上の基準点 |
| `fontSize` | 数値 | pt |
| `letterSpacing` | 数値 | 字間(pt)。各文字の送りに足す |
| `fontFamily` | 文字列 | 例: `Noto Sans JP`、`Noto Serif JP` |
| `fontWeight` | 数値 | 100〜900(取得済みは 400 と 700) |
| `align` | `left` / `center` / `right` | 基準点に対する揃え |
| `fill` | `#rrggbb` | 文字色 |
| `outline` | 真偽値 | 出力時に輪郭 Path で描く |
| `role` | 文字列 | `label` / `fieldCode` / `inputCell` / `frame` / `qr` / `formId` / `other` |
| `fieldCode` | 文字列または `null` | 項目コード |

`fitBox` の決め方: 高さからサイズを決め、幅は字間で合わせる。1 字で横長の字形(「ー」など)は幅からサイズを決める。
背景の文字のインクの範囲をそのまま枠にすればよい(`uncovered[].box` はそのまま使える)。

### 適用されない操作
形式が違う、対象がない、Text 以外への置換、同じ対象への重複などは、その操作だけ飛ばして理由を表示する。
ファイル全体が読めない(JSON でない、`version` が違う、`operations` がない)ときは取り込まない。

### できないこと
- 縦書きの Text は未対応。縦書きの文字は 1 字ずつ `add` する。
- 罫線(Path)の追加・変更はできない(削除だけできる)。
