import { useRef, useState } from 'react'
import { Renew } from '@carbon/icons-react'
import type { Scope } from './types'

export function ResumeUpdate({
  marketCount,
  portfolioCount,
  busy,
  onResume,
}: {
  marketCount: number
  portfolioCount: number
  busy: boolean
  onResume: (scope: Scope) => Promise<void>
}) {
  const [scope, setScope] = useState<Scope>(marketCount ? 'market' : 'portfolio')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const count = scope === 'market' ? marketCount : portfolioCount
  async function resume() {
    if (busy || inFlight.current || !count) return
    inFlight.current = true
    setPending(true)
    setError('')
    try {
      await onResume(scope)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return (
    <section className="resume-update">
      <div className="section-heading">
        <div>
          <h2>續跑行情更新</h2>
          <p>沿用目前清單，補抓尚未通過當期檢查的行情，完成後重算選股。</p>
        </div>
        <div className="actions">
          <select
            aria-label="續跑股票池"
            value={scope}
            disabled={busy || pending}
            onChange={(event) => setScope(event.target.value as Scope)}
          >
            <option value="market">市場候選 · {marketCount} 檔</option>
            <option value="portfolio">我的清單 · {portfolioCount} 檔</option>
          </select>
          <button
            type="button"
            className="button"
            disabled={busy || pending || !count}
            onClick={() => void resume()}
          >
            <Renew size={16} />
            {pending ? '啟動中…' : '續跑更新'}
          </button>
        </div>
      </div>
      <p className="footnote">
        已成功且通過當期檢查的行情直接沿用，其餘每檔重新下載一次。此操作不更換市場成分或股票池上限；若要找新成分，請至每日選股執行市場選股。
      </p>
      {!count && <p className="footnote">此清單尚無標的，請先建立股票池或加入觀察標的。</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
