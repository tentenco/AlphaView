import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Locale } from './locale'
import {
  newPaperKey,
  type PaperAccount,
  type PaperPreview,
  type PaperProposal,
} from './paper-model'
import type { DeskConfig, DeskRisk } from './research-desk-model'
import { money, num } from './ui'
import './strategy-bridge.css'

type Translate = (zh: string, en: string) => string
export type BridgeStatus = 'enter' | 'hold' | 'exit' | 'flat' | 'unavailable'
export type BridgeDecision = {
  symbol: string
  held: boolean
  status: BridgeStatus
  weight_pct: number
  reason: { code: string; message: string } | null
  evidence: {
    date: string
    close: number | null
    entry: boolean
    exit: boolean
    valid: boolean
    indicators: Record<string, number | null>
  } | null
}
export type BridgeValidationMode = 'require_pass' | 'warn_only' | 'off'
export type BridgeGate = 'pass' | 'warn' | 'blocked' | 'overridden' | 'off'
export type BridgeValidation = {
  mode: BridgeValidationMode
  gate: BridgeGate
  skipped: boolean
  acknowledge_fail: boolean
  overridable: boolean
  failing: string[]
  warn: string[]
  unavailable: string[]
  reasons: string[]
  engine_version?: string
  input_revision?: string
  folds?: number
  trials?: number
  request?: {
    risk: DeskRisk
    test_start: string | null
    test_end: string | null
    folds: number
    trials: number
  }
  overall?: 'pass' | 'warn' | 'fail' | 'unavailable'
  counts?: { pass: number; warn: number; fail: number; unavailable: number }
  pass_share?: number | null
  verdicts?: Record<string, 'pass' | 'warn' | 'fail' | 'unavailable'>
  items?: {
    symbol: string
    status: string
    verdict: string | null
    reasons?: string[]
    message?: string
  }[]
}
export type BridgeResult = {
  engine_version: string
  as_of: string
  input_revision: string
  account_id: string
  validation?: BridgeValidation
  would_refuse?: boolean
  config: DeskConfig
  label: string
  label_en: string
  max_weight_pct: number
  slot_weight_pct: number
  decisions: BridgeDecision[]
  counts: Record<BridgeStatus, number>
  target_weights: { symbol: string; weight_pct: number }[]
  invested_weight_pct: number
  labels: Record<BridgeStatus, { zh: string; en: string }>
  paper_preview?: PaperPreview
  paper_proposal?: PaperProposal
  method: string
  warnings: string[]
}
const GATES: Record<BridgeGate, [string, string]> = {
  pass: ['驗證通過', 'Validation passed'],
  warn: ['驗證保留（warn／不可用）', 'Validation warn (warn / unavailable)'],
  blocked: ['驗證未通過，提案會被擋下', 'Validation failed; the proposal will be refused'],
  overridden: ['驗證未通過，已明確覆寫', 'Validation failed; explicitly overridden'],
  off: ['未驗證', 'Validation off'],
}
const MODES: [BridgeValidationMode, string, string][] = [
  [
    'require_pass',
    '要求通過（fail 需明確覆寫）',
    'Require pass (a fail needs an explicit override)',
  ],
  ['warn_only', '僅警告', 'Warn only'],
  ['off', '關閉', 'Off'],
]
const STATUS: Record<BridgeStatus, [string, string]> = {
  enter: ['進場', 'Enter'],
  hold: ['續抱', 'Hold'],
  exit: ['出場', 'Exit'],
  flat: ['空手', 'Flat'],
  unavailable: ['不可用', 'Unavailable'],
}
const REASONS: Record<string, string> = {
  entry_signal: 'Entry signal present',
  no_exit_signal: 'Held with no exit signal; slot kept',
  exit_signal: 'Exit signal present; target set to zero',
  no_entry_signal: 'No entry signal',
  signal_not_defined: 'Indicators still warming up; no entry',
  no_history: 'No local daily history; refresh market data first',
  invalid_history: 'Local history failed validation',
  history_stale: 'Latest local bar is older than the latest completed session',
}
const VIOLATIONS: Record<string, string> = {
  kill_switch: 'Paper simulation is paused for this account.',
  quote_unavailable: 'A current valid USD reference price is unavailable.',
  max_position_weight: 'A target exceeds the account position limit.',
  post_policy_max_position_weight:
    'A resulting position exceeds the limit after costs and rounding.',
  min_cash_weight: 'Projected cash falls below the account minimum.',
  max_turnover: 'The proposed trades exceed the account turnover limit.',
  insufficient_cash: 'The proposed trades and costs exceed available cash.',
  nonpositive_equity: 'Positive paper equity is required.',
  holding_limit: 'The proposed portfolio exceeds the supported position count.',
  symbol_not_allowed: 'The symbol is outside the account allowlist.',
}
async function request<T>(url: string, t: Translate, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = value?.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail) && detail.code)
      throw new Error(String(detail.message))
    if (Array.isArray(detail) && typeof detail[0]?.msg === 'string')
      throw new Error(
        t(
          detail[0].msg.replace(/^Value error, /, ''),
          'The request did not pass validation. Check the account, symbols and weight.',
        ),
      )
    throw new Error(
      typeof detail === 'string'
        ? detail
        : t(`請求失敗（${response.status}）`, `Request failed (${response.status})`),
    )
  }
  return value as T
}
const parseSymbols = (text: string) =>
  text
    .trim()
    .toUpperCase()
    .split(/[\s,，;；]+/)
    .filter(Boolean)
const percent = (value: number | null | undefined) => (value == null ? '—' : `${num(value)}%`)

export function ResearchDeskPaperBridge({
  config,
  label,
  locale,
  defaultSymbols = [],
  risk,
  testStart,
  testEnd,
}: {
  config: DeskConfig
  label: string
  locale: Locale
  defaultSymbols?: string[]
  risk?: DeskRisk
  testStart?: string | null
  testEnd?: string | null
}) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [accounts, setAccounts] = useState<PaperAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [symbols, setSymbols] = useState(defaultSymbols.join(' '))
  const [maxWeight, setMaxWeight] = useState('20')
  const [mode, setMode] = useState<BridgeValidationMode>('require_pass')
  const [trials, setTrials] = useState('1')
  const [ackFail, setAckFail] = useState(false)
  const [result, setResult] = useState<BridgeResult | null>(null)
  const [saved, setSaved] = useState<PaperProposal | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const attempt = useRef({ input: '', key: '' })
  useEffect(() => {
    const controller = new AbortController()
    request<{ accounts: PaperAccount[] }>('/api/paper/accounts', t, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return
        setAccounts(data.accounts)
        setAccountId((current) =>
          data.accounts.some((item) => item.id === current)
            ? current
            : (data.accounts[0]?.id ?? ''),
        )
        setLoadError('')
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => controller.abort()
    // Account names do not change with the locale; only labels re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const account = accounts.find((item) => item.id === accountId)
  const parsedSymbols = parseSymbols(symbols)
  const weight = maxWeight.trim() ? Number(maxWeight) : NaN
  const symbolsValid =
    parsedSymbols.length >= 1 &&
    parsedSymbols.length <= 10 &&
    parsedSymbols.every((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) &&
    new Set(parsedSymbols).size === parsedSymbols.length
  const weightValid = Number.isFinite(weight) && weight >= 1 && weight <= 100
  const trialCount = trials.trim() ? Number(trials) : NaN
  const trialsValid = Number.isInteger(trialCount) && trialCount >= 1 && trialCount <= 500
  const body = account
    ? {
        account_id: account.id,
        expected_account_version: account.version,
        symbols: parsedSymbols,
        config,
        ...(risk ? { risk } : {}),
        ...(testStart ? { test_start: testStart } : {}),
        ...(testEnd ? { test_end: testEnd } : {}),
        max_weight_pct: weight,
        trials: trialCount,
        validation: { mode },
      }
    : null
  const input = JSON.stringify(body)
  useEffect(() => setAckFail(false), [input])
  const canPreview = !!body && symbolsValid && weightValid && trialsValid && !busy
  const previewCurrent =
    !!result && result.paper_preview !== undefined && attempt.current.input === input
  const validation = result?.validation
  const blocked = previewCurrent && validation?.gate === 'blocked'
  const needsAck = blocked && !!validation?.overridable
  const canSave =
    previewCurrent &&
    !!result?.paper_preview?.executable &&
    !saved &&
    !busy &&
    (!blocked || (needsAck && ackFail))

  async function run(kind: 'preview' | 'save') {
    if (!body) return
    setBusy(kind)
    setError('')
    try {
      if (kind === 'preview') {
        const data = await request<BridgeResult>('/api/research-desk/paper-preview', t, {
          method: 'POST',
          body: JSON.stringify(body),
        })
        attempt.current = { input, key: attempt.current.input === input ? attempt.current.key : '' }
        setResult(data)
        setSaved(null)
      } else {
        if (!attempt.current.key) attempt.current = { input, key: newPaperKey() }
        const data = await request<BridgeResult>('/api/research-desk/paper-proposal', t, {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            validation: { mode, acknowledge_fail: needsAck && ackFail },
            idempotency_key: attempt.current.key,
          }),
        })
        setResult({ ...data, paper_preview: data.paper_proposal })
        setSaved(data.paper_proposal ?? null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  function preview(event: FormEvent) {
    event.preventDefault()
    if (canPreview) void run('preview')
  }
  const paper = result?.paper_preview
  return (
    <section
      className="desk-panel strategy-bridge"
      aria-label={t('用同一套規則做紙上交易', 'Paper-trade these rules')}
    >
      <h2>{t('用同一套規則做紙上交易', 'Paper-trade these rules')}</h2>
      <p>
        {t(
          `把「${label}」在最新完成交易日的訊號翻成模擬帳戶的完整目標配置：進場與續抱佔一個席位，出場、空手與不可用歸零並保留現金。提案仍需在 Agent 投資組合明確接受，才會以次日開盤參考價模擬成交。`,
          `Translate the latest completed session's signals of “${label}” into a full paper-account target: enter and hold take one slot; exit, flat and unavailable go to zero and stay in cash. The proposal still has to be accepted in the Portfolio Agent page before it fills at the next open's reference price.`,
        )}
      </p>
      {(risk || testStart || testEnd) && (
        <p className="research-note">
          {t(
            '驗證沿用診斷的期間與風險設定；訊號仍取最新完成交易日，模擬成交仍受帳戶限制。',
            'Validation uses the diagnosis window and risk settings. Signals still use the latest completed session, and paper fills retain the account limits.',
          )}{' '}
          {testStart ?? '—'} → {testEnd ?? '—'}
        </p>
      )}
      {loadError && (
        <p className="error-message" role="alert">
          {loadError}
        </p>
      )}
      <form onSubmit={preview}>
        <div className="desk-form-grid">
          <label>
            {t('模擬帳戶', 'Paper account')}
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {!accounts.length && (
                <option value="">{t('尚無模擬帳戶', 'No paper account')}</option>
              )}
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.kill_switch ? ` · ${t('已暫停', 'paused')}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('代碼（最多 10 檔）', 'Symbols (up to 10)')}
            <input value={symbols} onChange={(event) => setSymbols(event.target.value)} />
          </label>
          <label>
            {t('單檔權重上限（%）', 'Max weight per symbol (%)')}
            <input
              inputMode="decimal"
              value={maxWeight}
              onChange={(event) => setMaxWeight(event.target.value)}
            />
          </label>
          <label>
            {t('驗證閘', 'Validation gate')}
            <select
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as BridgeValidationMode)
                setAckFail(false)
              }}
            >
              {MODES.map(([value, zh, en]) => (
                <option key={value} value={value}>
                  {t(zh, en)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('比較過的設定數（1–500）', 'Configurations compared (1–500)')}
            <input
              inputMode="numeric"
              value={trials}
              onChange={(event) => setTrials(event.target.value)}
            />
          </label>
        </div>
        <p className="desk-meta">
          {t(
            '保存前會以 alphaview-validation-v1 逐標的驗證同一設定（4 段走動式、bootstrap、機率化／去膨脹 Sharpe）；要求通過模式下任一 fail 或全部不可用都會擋下提案。',
            'Before saving, the same configuration is validated per symbol with alphaview-validation-v1 (4 walk-forward folds, bootstrap, probabilistic / deflated Sharpe); in require-pass mode any fail, or all symbols unavailable, refuses the proposal.',
          )}
        </p>
        {!symbolsValid && symbols.trim() && (
          <p className="error-message" role="alert">
            {t('請輸入 1–10 個不重複的大寫代碼。', 'Enter 1–10 unique uppercase symbols.')}
          </p>
        )}
        {!weightValid && (
          <p className="error-message" role="alert">
            {t('權重上限必須介於 1–100。', 'The weight cap must be between 1 and 100.')}
          </p>
        )}
        {!trialsValid && (
          <p className="error-message" role="alert">
            {t('設定數必須是 1–500 的整數。', 'Configurations compared must be an integer 1–500.')}
          </p>
        )}
        <div className="actions">
          <button className="button" disabled={!canPreview}>
            {busy === 'preview'
              ? t('預覽中…', 'Previewing…')
              : t('預覽紙上配置', 'Preview paper allocation')}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!canSave}
            onClick={() => void run('save')}
          >
            {busy === 'save' ? t('保存中…', 'Saving…') : t('保存紙上提案', 'Save paper proposal')}
          </button>
        </div>
      </form>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <p className="desk-meta">
            {t('訊號日', 'Signal session')} {result.as_of} · {t('席位', 'Slot')}{' '}
            {percent(result.slot_weight_pct)} · {t('投入合計', 'Invested')}{' '}
            {percent(result.invested_weight_pct)} · {result.engine_version}
            {!previewCurrent &&
              ` · ${t('設定已變更，請重新預覽', 'Settings changed; preview again')}`}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    t('代碼', 'Symbol'),
                    t('決策', 'Decision'),
                    t('持有中', 'Held'),
                    t('目標權重', 'Target weight'),
                    t('訊號', 'Signals'),
                    t('說明', 'Reason'),
                  ].map((heading) => (
                    <th scope="col" key={heading}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.decisions.map((row) => (
                  <tr key={row.symbol}>
                    <th scope="row">{row.symbol}</th>
                    <td>
                      <span className={`bridge-status is-${row.status}`}>
                        {t(...STATUS[row.status])}
                      </span>
                    </td>
                    <td>{row.held ? t('是', 'Yes') : t('否', 'No')}</td>
                    <td>{percent(row.weight_pct)}</td>
                    <td className="bridge-evidence">
                      {row.evidence
                        ? `${row.evidence.date} · ${t('收盤', 'close')} ${num(row.evidence.close)} · ${t('進', 'entry')} ${row.evidence.entry ? '✓' : '—'} · ${t('出', 'exit')} ${row.evidence.exit ? '✓' : '—'}${
                            row.evidence.valid ? '' : ` · ${t('未定義', 'undefined')}`
                          }${Object.entries(row.evidence.indicators)
                            .map(([name, value]) => ` · ${name} ${num(value)}`)
                            .join('')}`
                        : '—'}
                    </td>
                    <td className="bridge-evidence">
                      {row.reason
                        ? t(row.reason.message, REASONS[row.reason.code] || row.reason.message)
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {validation && (
            <div
              className={`bridge-validation${validation.gate === 'pass' ? ' is-positive' : ''}`}
              aria-label={t('驗證閘結果', 'Validation gate result')}
            >
              <strong>{t(...GATES[validation.gate])}</strong>
              {validation.gate !== 'off' && (
                <>
                  {' '}
                  · {validation.engine_version} · {t('整體', 'overall')} {validation.overall} · pass{' '}
                  {validation.counts?.pass ?? 0} · warn {validation.counts?.warn ?? 0} · fail{' '}
                  {validation.counts?.fail ?? 0} · {t('不可用', 'unavailable')}{' '}
                  {validation.counts?.unavailable ?? 0}
                  <div className="bridge-validation-chips">
                    {Object.entries(validation.verdicts ?? {}).map(([symbol, verdict]) => (
                      <span key={symbol} className={`bridge-status is-${verdict}`}>
                        {symbol}: {verdict}
                      </span>
                    ))}
                  </div>
                  {validation.request && (
                    <p className="desk-meta">
                      {t('驗證期間', 'Validation window')} {validation.request.test_start ?? '—'} →{' '}
                      {validation.request.test_end ?? '—'} ·{' '}
                      {t('回測費用／滑價（bps）', 'Backtest fee / slippage (bps)')}{' '}
                      {validation.request.risk.fee_bps} / {validation.request.risk.slippage_bps}
                    </p>
                  )}
                </>
              )}
              {!!validation.reasons.length && (
                <ul className="desk-hypotheses">
                  {validation.reasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              )}
              {needsAck && (
                <label className="bridge-ack">
                  <input
                    type="checkbox"
                    checked={ackFail}
                    onChange={(event) => setAckFail(event.target.checked)}
                  />
                  {t(
                    '我了解驗證未通過，仍要保存這個提案（覆寫會記錄在提案理由）',
                    'I understand the validation failed and still want to save this proposal (the override is recorded in the rationale)',
                  )}
                </label>
              )}
              {blocked && !needsAck && (
                <p className="desk-meta">
                  {t(
                    '全部標的的驗證都不可用，無法覆寫；請先補足歷史或改用僅警告模式。',
                    'Validation is unavailable for every symbol and cannot be overridden; add history or switch to warn-only.',
                  )}
                </p>
              )}
            </div>
          )}
          {paper && (
            <>
              <div className={`desk-verdict${paper.executable ? ' is-positive' : ''}`}>
                {paper.executable
                  ? t(
                      '紙上限制檢查通過，可保存提案',
                      'Paper limits passed; the proposal can be saved',
                    )
                  : t(
                      '紙上限制未通過；提案不可執行',
                      'Paper limits failed; the proposal is not executable',
                    )}
              </div>
              {!!paper.violations.length && (
                <ul className="desk-hypotheses">
                  {paper.violations.map((item, index) => (
                    <li key={index}>
                      {item.symbol ? `${item.symbol}: ` : ''}
                      {t(item.message, VIOLATIONS[item.code] || item.message)}{' '}
                      <code>{item.code}</code>
                    </li>
                  ))}
                </ul>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        t('代碼', 'Symbol'),
                        t('方向', 'Side'),
                        t('股數', 'Shares'),
                        t('模擬價', 'Fill price'),
                        t('金額', 'Notional'),
                        t('費用', 'Fee'),
                      ].map((heading) => (
                        <th scope="col" key={heading}>
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paper.orders.map((order) => (
                      <tr key={order.symbol}>
                        <th scope="row">{order.symbol}</th>
                        <td>{order.side === 'buy' ? t('買入', 'Buy') : t('賣出', 'Sell')}</td>
                        <td>{num(order.shares, 4)}</td>
                        <td>{money(order.fill_price)}</td>
                        <td>{money(order.notional)}</td>
                        <td>{money(order.fee)}</td>
                      </tr>
                    ))}
                    {!paper.orders.length && (
                      <tr>
                        <td colSpan={6}>{t('沒有需要變動的部位。', 'No position changes.')}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="desk-meta">
                {t('模擬後現金', 'Cash after')} {money(paper.cash_after)} · {t('換手', 'Turnover')}{' '}
                {percent(paper.turnover_pct)} · {t('成本合計', 'Total cost')}{' '}
                {money(paper.cost_total)}
              </p>
            </>
          )}
          {saved && (
            <p className="notice" role="status">
              {t(
                `紙上提案已保存（${saved.id}），尚未執行。請到 Agent 投資組合的「配置與提案」檢閱並明確接受。`,
                `Paper proposal saved (${saved.id}); not executed. Review and explicitly accept it under Allocation & proposals in the Portfolio Agent page.`,
              )}
            </p>
          )}
          <details>
            <summary>{t('提醒與方法', 'Warnings and method')}</summary>
            <ul className="desk-hypotheses">
              {result.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            <p className="desk-meta">{result.method}</p>
          </details>
        </>
      )}
    </section>
  )
}
