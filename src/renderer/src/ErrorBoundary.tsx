import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * 画面の描画中に例外が起きても、真っ白にせず内容を見せる。
 * (例外が起きると React は画面全体を外すので、何もしないと何も表示されなくなる)
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('画面の描画に失敗しました', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1>画面を表示できません</h1>
        <p>
          描画中にエラーが起きました。「再読み込み」で起動直後の画面に戻ります。保存していない変更は失われます。
          開いたプロジェクトのデータが壊れている場合は、同じプロジェクトを開くとまたこの画面になります。
        </p>
        <pre>{error.stack ?? error.message}</pre>
        <button onClick={() => window.location.reload()}>再読み込み</button>
      </div>
    )
  }
}
