// macOS Vision で画像の文字を認識し、行ごとの結果を JSON で標準出力に書く。
// 使い方: vision-ocr <画像ファイル> [言語,言語,...]
// 出力の box は画像の画素座標(左上原点、y下向き)。
import AppKit
import Foundation
import Vision

struct Box: Encodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct Line: Encodable {
  let text: String
  let confidence: Float
  let box: Box
  /** text の1文字ごとの位置。取れなかった文字は null */
  let chars: [Box?]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail("usage: vision-ocr <image> [languages]") }
let languages = arguments.count >= 3 ? arguments[2].split(separator: ",").map(String.init) : ["ja-JP", "en-US"]

guard let image = NSImage(contentsOfFile: arguments[1]),
  let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else { fail("画像を読めません: \(arguments[1])") }

let imageWidth = Double(cgImage.width)
let imageHeight = Double(cgImage.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = languages
// 項目コード(G01 等)を単語に補正されないようにする
request.usesLanguageCorrection = false
// 小さい印字も拾う(画像の高さに対する最小の文字高さ)
request.minimumTextHeight = 0.003

do {
  try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
} catch {
  fail("Vision の実行に失敗しました: \(error)")
}

// 正規化座標(左下原点)を画素座標(左上原点)にする
func toPixels(_ rect: CGRect) -> Box {
  Box(
    x: rect.minX * imageWidth,
    y: (1 - rect.maxY) * imageHeight,
    width: rect.width * imageWidth,
    height: rect.height * imageHeight)
}

var lines: [Line] = []
for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let text = candidate.string
  var chars: [Box?] = []
  var index = text.startIndex
  while index < text.endIndex {
    let next = text.index(after: index)
    let box = try? candidate.boundingBox(for: index..<next)
    chars.append(box.flatMap { $0 }.map { toPixels($0.boundingBox) })
    index = next
  }
  lines.append(
    Line(text: text, confidence: candidate.confidence, box: toPixels(observation.boundingBox), chars: chars))
}

let data = try JSONEncoder().encode(lines)
FileHandle.standardOutput.write(data)
