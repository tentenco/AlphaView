import { Component, Suspense, type ReactNode } from 'react'
import type { Locale } from './locale'
type Props = { children: ReactNode; name: string; locale: Locale }
class PanelBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    const en = this.props.locale === 'en'
    if (!this.state.failed) return this.props.children
    return (
      <div className="notice" role="alert" translate="no">
        <strong>
          {en ? `${this.props.name} could not be loaded.` : `無法載入${this.props.name}。`}
        </strong>
        <p>
          {en
            ? 'The app may have been updated. Reload to fetch the latest version; save any other edits first.'
            : '應用程式可能已更新。儲存其他編輯後，可重新載入取得最新版本。'}
        </p>
        <button type="button" className="button" onClick={() => window.location.reload()}>
          {en ? 'Reload Application' : '重新載入應用程式'}
        </button>
      </div>
    )
  }
}
export function DeferredContent({ children, name, locale }: Props) {
  return (
    <PanelBoundary name={name} locale={locale}>
      <Suspense
        fallback={
          <p className="notice" role="status" translate="no">
            {locale === 'en' ? `Loading ${name}…` : `正在載入${name}…`}
          </p>
        }
      >
        {children}
      </Suspense>
    </PanelBoundary>
  )
}
