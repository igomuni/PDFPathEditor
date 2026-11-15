import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// 開発時のみ React Fast Refresh のインラインスクリプトを許可する
const cspPlugin: Plugin = {
  name: 'pdfpe-csp',
  transformIndexHtml(html, ctx) {
    return html.replace('__CSP_SCRIPT_SRC__', ctx.server ? "'self' 'unsafe-inline'" : "'self'")
  }
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // PDFラスタライズ用 utility process のエントリ
          'rasterize-worker': resolve(__dirname, 'src/main/rasterize-worker.ts'),
          // Path候補抽出(Vectorizer)用 utility process のエントリ
          'vectorize-worker': resolve(__dirname, 'src/main/vectorize-worker.ts'),
          // OCR(Text候補抽出)用 utility process のエントリ
          'ocr-worker': resolve(__dirname, 'src/main/ocr-worker.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react(), cspPlugin]
  }
})
