// 確定オブジェクトから PDF を生成する(PDFKit)。元PDFには触れず、モデルだけから作る。
import { createWriteStream } from 'node:fs'
import PDFDocument from 'pdfkit'
import type { DocumentModel, ImageObject, PathObject, TextObject } from '../../shared/model'
import { isVertical, verticalChars } from '../../shared/vertical'
import type { FontBook } from './fonts'
import { exportedObjects, isDrawn, type LayoutText } from './layout'
import type { ImageBytes } from './svg'

type Pdf = InstanceType<typeof PDFDocument>

function drawPath(pdf: Pdf, object: PathObject): void {
  const { nodes } = object
  if (nodes.length === 0) return
  pdf.save()
  pdf.transform(...object.transform)
  pdf.moveTo(nodes[0].x, nodes[0].y)
  const segment = (from: PathObject['nodes'][number], to: PathObject['nodes'][number]): void => {
    if (!from.out && !to.in) {
      pdf.lineTo(to.x, to.y)
      return
    }
    const c1 = from.out ?? [from.x, from.y]
    const c2 = to.in ?? [to.x, to.y]
    pdf.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], to.x, to.y)
  }
  for (let i = 1; i < nodes.length; i++) segment(nodes[i - 1], nodes[i])
  if (object.closed) {
    segment(nodes.at(-1)!, nodes[0])
    pdf.closePath()
  }
  const stroked = object.stroke !== null && object.strokeWidth > 0
  if (stroked) {
    pdf.lineWidth(object.strokeWidth).lineCap(object.lineCap)
    if (object.dash) pdf.dash(object.dash, {})
    else pdf.undash()
  }
  if (object.fill !== null && stroked) pdf.fillAndStroke(object.fill, object.stroke!)
  else if (object.fill !== null) pdf.fill(object.fill)
  else if (stroked) pdf.stroke(object.stroke!)
  pdf.restore()
}

function drawText(pdf: Pdf, object: TextObject, book: FontBook, layout: LayoutText): void {
  const laidOut = layout(object)
  pdf.save()
  pdf.transform(...object.transform)
  if (object.outline) {
    // グリフの輪郭を塗る。フォントは埋め込まれず、文字としては選択できない
    for (const glyph of laidOut.glyphs) {
      if (glyph.d === '') continue
      pdf.save()
      pdf.translate(glyph.x, glyph.y).scale(laidOut.scale)
      pdf.path(glyph.d).fill(object.fill)
      pdf.restore()
    }
  } else {
    // ローカル座標は y 上向き。PDFKit の文字は y 下向きで組まれるので上下を戻す
    pdf.scale(1, -1)
    pdf.font(book.file(object.fontFamily, object.fontWeight)).fontSize(object.fontSize).fillColor(object.fill)
    if (isVertical(object)) {
      // 縦書き: 1字ずつ、縦書き用の字形(vert)で左右の中央に置く。文字としては1字ずつ選択できる
      for (const item of verticalChars(object)) {
        const options = { lineBreak: false, baseline: 'alphabetic' as const, features: ['vert'] as PDFKit.Mixins.OpenTypeFeatures[] }
        pdf.text(item.char, -pdf.widthOfString(item.char, options) / 2, item.baseline, options)
      }
    } else {
      pdf.text(object.text, laidOut.x0, 0, {
        lineBreak: false,
        baseline: 'alphabetic',
        characterSpacing: object.letterSpacing
      })
    }
  }
  pdf.restore()
}

/** 画像は PNG のまま埋め込む。単位正方形(y上向き)に、上下を戻して置く */
function drawImage(pdf: Pdf, object: ImageObject, images: ImageBytes): void {
  const bytes = images.get(object.asset)
  if (!bytes) return
  pdf.save()
  pdf.transform(...object.transform)
  pdf.transform(1, 0, 0, -1, 0, 1)
  pdf.image(Buffer.from(bytes), 0, 0, { width: 1, height: 1 })
  pdf.restore()
}

/** ドキュメントの全ページを1つの PDF に書き出す。フォントは使った文字だけをサブセットして埋め込む */
export function writePdf(document: DocumentModel, book: FontBook, layout: LayoutText, outPath: string, images: ImageBytes = new Map()): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const pdf = new PDFDocument({
      autoFirstPage: false,
      info: {
        Title: document.sources.find((source) => source.id === document.pages[0]?.sourceId)?.originalFileName ?? 'PDFPathEditor',
        Creator: 'PDFPathEditor'
      }
    })
    const stream = createWriteStream(outPath)
    stream.on('finish', resolvePromise)
    stream.on('error', reject)
    pdf.on('error', reject)
    pdf.pipe(stream)
    try {
      for (const page of document.pages) {
        const [x0, y0, x1, y1] = page.mediaBox
        pdf.addPage({ size: [x1 - x0, y1 - y0], margin: 0 })
        // PDFKit の座標は左上原点・y下向き。モデルのPDF座標(左下原点)に合わせる
        pdf.transform(1, 0, 0, -1, -x0, y1)
        for (const object of exportedObjects(page)) {
          if (!isDrawn(object)) continue
          if (object.type === 'path') drawPath(pdf, object)
          else if (object.type === 'text') drawText(pdf, object, book, layout)
          else drawImage(pdf, object, images)
        }
      }
      pdf.end()
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
