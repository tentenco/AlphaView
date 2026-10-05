import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import type { PaperOrder, PaperPreview, PaperTarget } from './paper-model'
import { useSessionState } from './session-state'
import { money, num } from './ui'

type Issue = { code: string; message: string; symbol?: string }
export type CostSensitivityReport = {
  engine_version: string
  paper_engine_version: string
  account_id: string
  account_version: number
  input_revision: string
  as_of: string
  targets: PaperTarget[]
  baseline: { cost_total: number | null; orders: PaperOrder[] }
  liquidity: {
    status: 'complete' | 'incomplete' | 'unavailable'
    coverage: { required: number; available: number; unavailable: number }
    orders: {
      symbol: string
      side: string
      shares: number
      session_volume: number | null
      participation_pct: number | null
      status: string
      reason: string | null
    }[]
  }
  scenarios: {
    fee_bps: number
    slippage_bps: number
    status: 'calculated' | 'blocked' | 'unavailable'
    fees_total: number | null
    slippage_total: number | null
    cost_total: number | null
    cost_change_vs_baseline: number | null
    cash_after: number | null
    equity_after: number | null
    violations: Issue[]
    reason: string | null
  }[]
  method: string
}
type Props = { preview: PaperPreview; locale: Locale }
type Draft = { fees: string; slippage: string }
const validDraft = (value: unknown): value is Draft => {
  const draft = value as Draft | null
  return (
    !!draft &&
    typeof draft.fees === 'string' &&
    draft.fees.length <= 120 &&
    typeof draft.slippage === 'string' &&
    draft.slippage.length <= 120
  )
}
function grid(text: string): number[] | null {
  if (!text.trim()) return null
  const parts = text.trim().split(/[,\s]+/)
  if (parts.some((part) => !part)) return null
  const values = parts.map(Number)
  return values.length <= 5 &&
    new Set(values).size === values.length &&
    values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1000)
    ? values
    : null
}
const orderIdentity = (orders: PaperOrder[]) =>
  orders
    .map((order) => ({
      symbol: order.symbol,
      side: order.side,
      shares: order.shares,
      reference_price: order.reference_price,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
const targetsIdentity = (targets: PaperTarget[]) =>
  JSON.stringify([...targets].sort((a, b) => a.symbol.localeCompare(b.symbol)))

export function PortfolioCostSensitivity(props: Props) {
  return <CostGrid key={props.preview.account_id} {...props} />
}

function CostGrid({ preview, locale }: Props) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const id = useId()
  const [draft, setDraft] = useSessionState<Draft>(
    `paper-cost-grid-${preview.account_id}-v1`,
    () => ({ fees: '0, 10, 25', slippage: '0, 10, 50' }),
    validDraft,
  )
  const fees = grid(draft.fees),
    slippage = grid(draft.slippage)
  const available = preview.executable && preview.valuation_complete && preview.orders.length > 0
  const identity = JSON.stringify([
    preview.account_id,
    preview.account_version,
    preview.input_revision,
    preview.as_of,
    preview.engine_version,
    targetsIdentity(preview.targets),
    orderIdentity(preview.orders),
    available,
    draft,
  ])
  const latest = useRef(identity)
  latest.current = identity
  const pending = useRef<AbortController | null>(null)
  const [state, setState] = useState<{
    identity: string
    busy: boolean
    result: CostSensitivityReport | null
    error: string
  }>({ identity, busy: false, result: null, error: '' })
  const current = state.identity === identity ? state : null
  const report = current?.result ?? null
  const busy = current?.busy ?? false
  useEffect(
    () => () => {
      pending.current?.abort()
      pending.current = null
    },
    [identity],
  )

  async function calculate(event: FormEvent) {
    event.preventDefault()
    if (!available || !fees || !slippage || pending.current || busy) return
    const controller = new AbortController()
    pending.current = controller
    const matches = () =>
      pending.current === controller && !controller.signal.aborted && latest.current === identity
    setState({ identity, busy: true, result: null, error: '' })
    try {
      const response = await fetch(`/api/paper/accounts/${preview.account_id}/cost-sensitivity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify({
          expected_version: preview.account_version,
          expected_input_revision: preview.input_revision,
          expected_as_of: preview.as_of,
          expected_engine_version: preview.engine_version,
          expected_orders: orderIdentity(preview.orders),
          targets: preview.targets,
          fee_bps: fees,
          slippage_bps: slippage,
        }),
      })
      const data = await response.json()
      if (!matches()) return
      if (!response.ok) {
        throw new Error(
          typeof data?.detail === 'string'
            ? data.detail
            : typeof data?.detail?.message === 'string'
              ? data.detail.message
              : t(
                  '成本比較失敗，請重新預覽後重試。',
                  'Cost comparison failed. Preview again and retry.',
                ),
        )
      }
      const value = data as CostSensitivityReport
      if (
        value.account_id !== preview.account_id ||
        value.account_version !== preview.account_version ||
        value.input_revision !== preview.input_revision ||
        value.as_of !== preview.as_of ||
        value.paper_engine_version !== preview.engine_version ||
        targetsIdentity(value.targets) !== targetsIdentity(preview.targets) ||
        JSON.stringify(orderIdentity(value.baseline.orders)) !==
          JSON.stringify(orderIdentity(preview.orders))
      ) {
        throw new Error(
          t(
            '來源預覽已變更，請重新預覽後比較成本。',
            'Source preview changed. Preview again before comparing costs.',
          ),
        )
      }
      setState({ identity, busy: false, result: value, error: '' })
    } catch (error) {
      if (matches())
        setState({
          identity,
          busy: false,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        })
    } finally {
      if (pending.current === controller) pending.current = null
    }
  }

  const percent = (value: number | null) => (value == null ? '—' : `${num(value, 4)}%`)
  return (
    <section
      className="agent-panel"
      aria-label={t('固定股數成本敏感度', 'Fixed-order cost sensitivity')}
    >
      <h3>{t('成本假設會改變多少現金？', 'How do cost assumptions change cash?')}</h3>
      <p className="scenario-scope">
        {t(
          '沿用此預覽的股數、精度與最低交易額，只比較手續費和不利滑價假設。最多 25 組，不修改帳戶政策、不建立提案或送單。',
          'Keep this preview’s quantities, precision and minimum-trade skips. Compare up to 25 fee and adverse-slippage assumptions without changing policy, creating proposals or sending orders.',
        )}
      </p>
      {!available && (
        <p className="notice">
          {t(
            '請先產生通過限制、有完整報價且含委託的預覽，才能比較固定股數成本。',
            'First create a preview that passes limits, has complete quotes and contains orders to compare fixed-order costs.',
          )}
        </p>
      )}
      <form onSubmit={(event) => void calculate(event)}>
        <div className="form-grid">
          <label htmlFor={`${id}-fees`}>
            {t('手續費假設（bps）', 'Fee assumptions (bps)')}
            <input
              id={`${id}-fees`}
              value={draft.fees}
              maxLength={120}
              onChange={(event) => setDraft({ ...draft, fees: event.target.value })}
            />
          </label>
          <label htmlFor={`${id}-slippage`}>
            {t('滑價假設（bps）', 'Slippage assumptions (bps)')}
            <input
              id={`${id}-slippage`}
              value={draft.slippage}
              maxLength={120}
              onChange={(event) => setDraft({ ...draft, slippage: event.target.value })}
            />
          </label>
        </div>
        <p className="scenario-scope">
          {t(
            '每欄輸入 1–5 個不重複的 0–1,000 數值，以逗號分隔；100 bps = 1%。',
            'Enter 1–5 unique values from 0–1,000 per field, separated by commas; 100 bps = 1%.',
          )}
        </p>
        {(!fees || !slippage) && (
          <p className="error-message" role="alert">
            {t(
              '成本格點不可留空、重複或超出範圍。',
              'Cost grids cannot be empty, duplicated or outside the allowed range.',
            )}
          </p>
        )}
        <div className="actions">
          <button className="button" disabled={!available || !fees || !slippage || busy}>
            {busy ? t('計算中…', 'Calculating…') : t('比較成本假設', 'Compare cost assumptions')}
          </button>
          {busy && (
            <button
              className="button"
              type="button"
              onClick={() => {
                pending.current?.abort()
                pending.current = null
                setState({ identity, busy: false, result: null, error: '' })
              }}
            >
              {t('取消', 'Cancel')}
            </button>
          )}
        </div>
      </form>
      {current?.error && (
        <p className="error-message" role="alert">
          {current.error}
        </p>
      )}
      {report && (
        <div aria-live="polite">
          <p>
            {t('現行政策的成本合計', 'Costs under current policy')}:{' '}
            {money(report.baseline.cost_total)} · {t('固定委託筆數', 'Fixed orders')}:{' '}
            {report.baseline.orders.length}
          </p>
          <p className={report.liquidity.status === 'complete' ? 'scenario-scope' : 'notice'}>
            {t('當期成交量覆蓋', 'Completed-session volume coverage')}:{' '}
            {report.liquidity.coverage.available}/{report.liquidity.coverage.required}.{' '}
            {t(
              '參與率只是股數除以日成交量，不代表成交能力或滑價估計；缺量維持不可用。',
              'Participation is shares divided by daily volume, not executable capacity or a slippage estimate; missing volume stays unavailable.',
            )}
          </p>
          <div className="table-scroll" tabIndex={0}>
            <table aria-label={t('成交量參與率', 'Volume participation')}>
              <thead>
                <tr>
                  <th>{t('代碼／方向', 'Symbol / side')}</th>
                  <th>{t('股數', 'Shares')}</th>
                  <th>{t('當期成交量', 'Session volume')}</th>
                  <th>{t('參與率', 'Participation')}</th>
                  <th>{t('缺值原因', 'Unavailable reason')}</th>
                </tr>
              </thead>
              <tbody>
                {report.liquidity.orders.map((order) => (
                  <tr key={order.symbol}>
                    <td>
                      {order.symbol} · {order.side}
                    </td>
                    <td>{num(order.shares, 6)}</td>
                    <td>{num(order.session_volume, 0)}</td>
                    <td>{percent(order.participation_pct)}</td>
                    <td>{order.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-scroll" tabIndex={0}>
            <table aria-label={t('成本假設比較', 'Cost assumption comparison')}>
              <thead>
                <tr>
                  {[
                    t('費率／滑價 bps', 'Fee / slip bps'),
                    t('手續費', 'Fees'),
                    t('滑價成本', 'Slippage'),
                    t('成本合計', 'Total cost'),
                    t('對現行成本差額', 'Change vs current costs'),
                    t('剩餘現金', 'Cash after'),
                    t('扣成本淨值', 'Equity after'),
                    t('限制', 'Constraints'),
                  ].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.scenarios.map((scenario) => (
                  <tr key={`${scenario.fee_bps}:${scenario.slippage_bps}`}>
                    <td>
                      {scenario.fee_bps} / {scenario.slippage_bps}
                    </td>
                    <td>{money(scenario.fees_total)}</td>
                    <td>{money(scenario.slippage_total)}</td>
                    <td>{money(scenario.cost_total)}</td>
                    <td>{money(scenario.cost_change_vs_baseline)}</td>
                    <td>{money(scenario.cash_after)}</td>
                    <td>{money(scenario.equity_after)}</td>
                    <td>
                      {scenario.status === 'calculated' ? (
                        t('未新增超限', 'No added breaches')
                      ) : (
                        <details>
                          <summary>{t('受阻／不可用', 'Blocked / unavailable')}</summary>
                          <ul>
                            {scenario.violations.map((reason, index) => (
                              <li key={index}>
                                {reason.symbol} {reason.message} ({reason.code})
                              </li>
                            ))}
                          </ul>
                          {scenario.reason}
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>{t('範圍與方法', 'Scope and method')}</summary>
            <p className="scenario-scope">
              {t(
                '成本格點是假設，不是交易建議。低成本假設不會解除基準阻擋；不重新分配或縮減委託。',
                'These are cost assumptions, not trading advice. Lower assumed costs do not remove baseline blocks, redistribute targets or resize orders.',
              )}
            </p>
            <p className="desk-meta">{report.method}</p>
            <p className="desk-meta" style={{ overflowWrap: 'anywhere' }}>
              {report.engine_version} · {report.as_of} · {report.input_revision}
            </p>
          </details>
        </div>
      )}
    </section>
  )
}
