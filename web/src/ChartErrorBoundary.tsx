import { Component, type ReactNode } from 'react'
export class ChartErrorBoundary extends Component<
  { children: ReactNode; onReload?: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="notice" role="alert">
        <div>
          <strong>比較圖暫時無法顯示</strong>
          <p>
            下方數值表、CSV
            匯出與標的選擇仍可使用。若要重新載入圖表，可重新載入頁面；這會重設本頁選擇。
          </p>
          <button
            type="button"
            className="button"
            onClick={() => (this.props.onReload ? this.props.onReload() : window.location.reload())}
          >
            重新載入頁面
          </button>
        </div>
      </div>
    )
  }
}
