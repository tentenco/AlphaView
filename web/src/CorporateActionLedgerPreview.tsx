import { useEffect, useRef, useState } from 'react'
import type { Locale } from './locale'
import type { PaperAccount } from './paper-model'
import { dateTime, num } from './ui'
import './corporate-action-ledger-preview.css'

type Translate = (zh: string, en: string) => string
type Effect = {
  shares: number | null
  cost_basis: number | null
  average_cost: number | null
  shares_exact?: string
  cost_basis_exact?: string
  average_cost_exact?: string
}
type Event = {
  ex_date: string
  kind: 'stock_split' | 'cash_dividend'
  source_value: number | null
  raw_value: string | null
  raw_type: string | null
  source_reason: string | null
  status: string
  entitlement: string
  reasons: string[]
  record_date: null
  pay_date: null
  cash_entitlement: null
  before: Effect | null
  after: Effect | null
  shares_delta: number | null
}
type Holding = {
  symbol: string
  status: string
  reasons: string[]
  current: Effect | null
  conditional_after: Effect | null
  ledger: {
    status: string
    entry_session: string | null
    rows_checked: number | null
    reasons: string[]
  }
  events: Event[]
  coverage: {
    required_sessions: number | null
    captured_sessions: number | null
    unknown_split_cells: number | null
    reported_events: number | null
    applicable_splits: number | null
    calculated_splits: number | null
    unavailable_events: number | null
  }
  source: {
    status: string
    reason?: string
    source?: string
    source_completeness: string
    adapter_version?: string
    fingerprint: string | null
    fetched_at?: string
    first_fetched_at: string | null
    evidence_revision?: number
    capture_version?: number
    captured_input_revision?: string
    freshness_reasons?: string[]
    coverage?: {
      first: string
      last: string
      rows: number | null
      unavailable_cells: number | null
      columns: Record<
        string,
        { present: boolean; checked: number; zero: number; events: number; unavailable: number }
      >
    }
  }
}
export type CorporateActionLedgerResult = {
  engine_version: string
  account_id: string
  account_version: number
  input_revision: string
  as_of: string
  read_at: string
  status: string
  ledger_mutated: false
  source_completeness: 'unknown'
  holdings: Holding[]
  coverage: {
    holdings: number | null
    conditional_holdings: number | null
    unavailable_holdings: number | null
    reported_events: number | null
    calculated_splits: number | null
  }
  method: string
  warnings: string[]
}

const metric = (value: number | null | undefined, digits = 6) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value !== 0 && Math.abs(value) < 10 ** -digits
    ? value.toExponential(4)
    : num(value, digits)
}
const count = (value: number | null | undefined) => metric(value, 0)
const status = (value: string, t: Translate) =>
  ({
    conditional: t('條件式試算・未入帳', 'Conditional arithmetic · Unposted'),
    unavailable: t('不可用', 'Unavailable'),
    no_applicable_split_reported: t('未回傳適用拆股事件', 'No applicable split reported'),
    outside_holding_period: t('早於本次進場', 'Before current entry'),
    available: t('回傳證據已保存', 'Returned evidence saved'),
    partial: t('回傳欄位不完整', 'Returned fields incomplete'),
    stale: t('保存來源已過期', 'Stored source is stale'),
    reconciled: t('本機股數與成本相符', 'Local shares and cost reconcile'),
  })[value] ?? value
const reason = (value: string, t: Translate): string =>
  ({
    ledger_value_unavailable: t('成交數值不可用', 'Fill values unavailable'),
    fill_provenance_unavailable: t(
      '同帳戶成交來源無法確認',
      'Same-account fill provenance unverified',
    ),
    fill_session_unavailable: t('成交交易日或順序無法確認', 'Fill session or ordering unverified'),
    ledger_cost_mismatch: t('歷史成本無法核對', 'Historical cost does not reconcile'),
    ledger_balance_invalid: t('歷史成交餘額無效', 'Historical fill balance invalid'),
    holding_value_unavailable: t('目前股數或成本不可用', 'Current shares or cost unavailable'),
    ledger_holding_mismatch: t(
      '成交歷史與目前持倉不符',
      'Fill history differs from current holdings',
    ),
    entry_session_unknown: t('進場交易日未知', 'Entry session unknown'),
    source_not_current: t('缺少當期對齊的來源證據', 'Current aligned source evidence unavailable'),
    split_column_unavailable: t('未取得拆股欄位', 'Split column unavailable'),
    holding_period_not_covered: t(
      '來源未涵蓋完整持有期間',
      'Source does not cover the holding period',
    ),
    holding_sessions_missing: t('持有期間缺少交易日', 'Holding-period sessions missing'),
    holding_sessions_unavailable: t(
      '持有期間交易日分母未知',
      'Holding-period session denominator unknown',
    ),
    split_cells_unavailable: t('持有期間有未知拆股儲存格', 'Unknown split cells in holding period'),
    split_ratio_unavailable: t('拆併股倍率不可用', 'Split multiplier unavailable'),
    split_event_session_unavailable: t('拆股事件交易日無法確認', 'Split event session unverified'),
    fill_on_or_after_split: t('事件當日或之後有成交', 'A fill occurred on or after the split'),
    dividend_entitlement_unknown: t('股息權利未確認', 'Dividend entitlement unverified'),
    record_and_pay_dates_unknown: t('登記日與付款日未知', 'Record and payment dates unknown'),
    event_before_current_entry: t(
      '事件早於目前持倉的進場日',
      'Event predates the current position',
    ),
    calculation_nonfinite: t('算術結果超出有限值範圍', 'Arithmetic result outside finite range'),
    not_captured: t('尚未擷取來源證據', 'Source evidence not captured'),
    bars_changed: t('擷取後本機日線已變更', 'Local bars changed after capture'),
    source_update_failed: t('最近來源更新失敗', 'Latest source update failed'),
    capture_not_aligned: t('來源與日線擷取時間不一致', 'Source and bars capture times differ'),
    coverage_ends_before_as_of: t(
      '來源覆蓋未到查詢交易日',
      'Source coverage ends before the session',
    ),
    missing_value: t('來源值缺失', 'Source value missing'),
    non_finite_value: t('來源值不是有限數', 'Source value is nonfinite'),
    negative_value: t('來源值為負數', 'Source value is negative'),
    non_numeric_value: t('來源值不是數字', 'Source value is not numeric'),
  })[value] ?? value

export function CorporateActionLedgerPreview({
  account,
  locale,
}: {
  account: PaperAccount
  locale: Locale
}) {
  const t: Translate = (zh, en) => (locale === 'en' ? en : zh)
  const [result, setResult] = useState<{
    key: string
    value: CorporateActionLedgerResult
  } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const operation = useRef<AbortController | null>(null)
  const reloadPending = useRef(false)
  const key = JSON.stringify([account.id, account.version, refresh])
  const identity = useRef(key)
  identity.current = key
  const shown = result?.key === key ? result.value : null

  useEffect(() => {
    const controller = new AbortController()
    operation.current = controller
    reloadPending.current = false
    setResult(null)
    setError(null)
    setLoading(true)
    fetch(
      `/api/paper/accounts/${encodeURIComponent(account.id)}/corporate-actions/ledger-preview`,
      {
        cache: 'no-store',
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const value = await response.json().catch(() => ({}))
        if (!response.ok)
          throw new Error(
            t('無法讀取本機帳本預覽。', 'Could not read the local ledger preview.') +
              ` (${response.status})`,
          )
        if (controller.signal.aborted || key !== identity.current) return
        if (
          value.account_id !== account.id ||
          value.account_version !== account.version ||
          value.engine_version !== 'alphaview-corporate-action-ledger-preview-v1' ||
          value.ledger_mutated !== false ||
          !Array.isArray(value.holdings)
        )
          throw new Error(
            t(
              '帳本預覽的帳戶、版本或方法不符。',
              'Ledger preview account, version or method mismatch.',
            ),
          )
        setResult({ key, value })
      })
      .catch((cause) => {
        if (!controller.signal.aborted && key === identity.current)
          setError({ key, message: cause instanceof Error ? cause.message : String(cause) })
      })
      .finally(() => {
        if (operation.current === controller) operation.current = null
        if (!controller.signal.aborted && key === identity.current) setLoading(false)
      })
    return () => {
      controller.abort()
      if (operation.current === controller) operation.current = null
    }
    // The fetch identity follows account data, not display language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, account.version, refresh])

  function reload() {
    if (operation.current || reloadPending.current) return
    reloadPending.current = true
    setResult(null)
    setLoading(true)
    setRefresh((value) => value + 1)
  }

  function download() {
    if (
      !shown ||
      loading ||
      operation.current ||
      reloadPending.current ||
      result?.key !== identity.current
    )
      return
    let url: string | null = null
    let link: HTMLAnchorElement | null = null
    try {
      const json = JSON.stringify(
        shown,
        (_key, value: unknown) => {
          if (typeof value === 'number' && !Number.isFinite(value))
            throw new Error('Nonfinite preview value')
          return value
        },
        2,
      )
      const safe = (value: string) =>
        value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'unknown'
      url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }))
      link = document.createElement('a')
      link.href = url
      link.download = `alphaview-corporate-ledger-preview-${safe(shown.as_of)}-${safe(shown.account_id)}.json`
      document.body.appendChild(link)
      link.click()
    } catch {
      setError({
        key,
        message: t(
          '本機帳本預覽 JSON 無法下載。',
          'Local ledger preview JSON could not be downloaded.',
        ),
      })
    } finally {
      link?.remove()
      if (url) {
        const release = url
        window.setTimeout(() => URL.revokeObjectURL(release), 10000)
      }
    }
  }

  return (
    <section
      className="panel corporate-ledger-preview"
      aria-label={t('公司行動帳本預覽', 'Corporate-action ledger preview')}
    >
      <div className="section-heading">
        <div>
          <h3>{t('公司行動帳本預覽', 'Corporate-action ledger preview')}</h3>
          <p className="muted">
            {t(
              '拆併股條件式算術；股息權利仍未知。',
              'Conditional split arithmetic; dividend entitlement remains unknown.',
            )}
          </p>
        </div>
        <div className="corporate-ledger-buttons">
          <button type="button" disabled={loading} onClick={reload}>
            {t('重新讀取帳本預覽', 'Reload ledger preview')}
          </button>
          <button type="button" disabled={loading || !shown} onClick={download}>
            {t('下載帳本預覽 JSON', 'Download ledger preview JSON')}
          </button>
        </div>
      </div>
      <p className="research-note">
        {t(
          '這不是入帳或應收款證明。只讀本機保存資料，不改股數、成本或現金。事件當日或之後有成交時不試算；來源完整性與零股處分仍未知。',
          'This is not a posting or receivable confirmation. It reads saved local data and leaves shares, cost and cash unchanged. Fills on or after an event prevent calculation; source completeness and fractional-share disposal remain unknown.',
        )}
      </p>
      {loading && (
        <p role="status">{t('正在讀取本機帳本預覽…', 'Reading local ledger preview…')}</p>
      )}
      {error?.key === key && (
        <p role="alert" className="notice">
          {error.message}
        </p>
      )}
      {shown && (
        <>
          <p className="muted corporate-ledger-meta">
            {shown.engine_version} · {shown.as_of} · {t('讀取時間', 'Read at')}{' '}
            {dateTime(shown.read_at)}
            <br />
            {t('條件式持倉', 'Conditional holdings')} {count(shown.coverage.conditional_holdings)} /{' '}
            {count(shown.coverage.holdings)} · {t('不可用持倉', 'Unavailable holdings')}{' '}
            {count(shown.coverage.unavailable_holdings)} · {t('已計算拆股', 'Calculated splits')}{' '}
            {count(shown.coverage.calculated_splits)}
          </p>
          {shown.holdings.length === 0 && (
            <p>{t('沒有虛擬持倉可預覽。', 'No paper holdings to preview.')}</p>
          )}
          {shown.holdings.map((holding) => (
            <article
              className="corporate-ledger-holding"
              key={holding.symbol}
              aria-label={`${holding.symbol} ${t('帳本預覽', 'ledger preview')}`}
            >
              <h4>
                {holding.symbol} · {status(holding.status, t)}
              </h4>
              {holding.reasons.length > 0 && (
                <p className="notice">
                  {holding.reasons.map((code) => reason(code, t)).join(' · ')}
                </p>
              )}
              <dl className="corporate-ledger-metrics">
                <div>
                  <dt>{t('帳本股數', 'Ledger shares')}</dt>
                  <dd>{metric(holding.current?.shares)}</dd>
                </div>
                <div>
                  <dt>{t('假設拆股後股數', 'Conditional shares after splits')}</dt>
                  <dd>{metric(holding.conditional_after?.shares)}</dd>
                </div>
                <div>
                  <dt>{t('帳本總成本', 'Ledger total cost')}</dt>
                  <dd>{metric(holding.current?.cost_basis, 8)}</dd>
                </div>
                <div>
                  <dt>{t('假設拆股後總成本', 'Conditional total cost after splits')}</dt>
                  <dd>{metric(holding.conditional_after?.cost_basis, 8)}</dd>
                </div>
                <div>
                  <dt>{t('帳本每股成本', 'Ledger cost per share')}</dt>
                  <dd>{metric(holding.current?.average_cost, 8)}</dd>
                </div>
                <div>
                  <dt>{t('假設拆股後每股成本', 'Conditional cost per share after splits')}</dt>
                  <dd>{metric(holding.conditional_after?.average_cost, 8)}</dd>
                </div>
              </dl>
              <p className="muted">
                {status(holding.ledger.status, t)} · {t('進場交易日', 'Entry session')}{' '}
                {holding.ledger.entry_session ?? '—'} ·{' '}
                {t('持有期間交易日覆蓋', 'Holding-period session coverage')}{' '}
                {count(holding.coverage.captured_sessions)} /{' '}
                {count(holding.coverage.required_sessions)} ·{' '}
                {t('未知拆股儲存格', 'Unknown split cells')}{' '}
                {count(holding.coverage.unknown_split_cells)}
              </p>
              <details className="corporate-ledger-source">
                <summary>
                  {t('來源與擷取覆蓋', 'Source and capture coverage')} ·{' '}
                  {status(holding.source.status, t)}
                </summary>
                <p>
                  {holding.source.source ?? '—'} · {holding.source.adapter_version ?? '—'}
                </p>
                <p>
                  {t('來源完整性未知', 'Source completeness unknown')} ·{' '}
                  {t('事件修訂', 'Evidence revision')} {count(holding.source.evidence_revision)} ·{' '}
                  {t('擷取版本', 'Capture version')} {count(holding.source.capture_version)}
                </p>
                <p>
                  {t('擷取時間', 'Captured at')}{' '}
                  {holding.source.fetched_at ? dateTime(holding.source.fetched_at) : '—'} ·{' '}
                  {t('首次保存時間', 'First saved at')}{' '}
                  {holding.source.first_fetched_at
                    ? dateTime(holding.source.first_fetched_at)
                    : '—'}
                </p>
                <p>
                  {t('來源期間', 'Source period')} {holding.source.coverage?.first ?? '—'} →{' '}
                  {holding.source.coverage?.last ?? '—'} · {t('來源列數', 'Source rows')}{' '}
                  {count(holding.source.coverage?.rows)} ·{' '}
                  {t('來源不可用儲存格', 'Unavailable source cells')}{' '}
                  {count(holding.source.coverage?.unavailable_cells)}
                </p>
                {(['Stock Splits', 'Dividends'] as const).map((field) => {
                  const column = holding.source.coverage?.columns[field]
                  return (
                    <p key={field}>
                      {field === 'Stock Splits'
                        ? t('拆股欄位', 'Split column')
                        : t('股息欄位', 'Dividend column')}{' '}
                      ·{' '}
                      {column?.present
                        ? t('有回傳欄位', 'Column returned')
                        : t('欄位未知', 'Column unknown')}{' '}
                      · {t('已檢查', 'Checked')} {count(column?.checked)} ·{' '}
                      {t('回傳零值', 'Returned zeros')} {count(column?.zero)} ·{' '}
                      {t('回傳事件', 'Reported events')} {count(column?.events)} ·{' '}
                      {t('不可用儲存格', 'Unavailable cells')} {count(column?.unavailable)}
                    </p>
                  )
                })}
                <p>
                  {t('證據指紋', 'Evidence fingerprint')}{' '}
                  <code>{holding.source.fingerprint ?? '—'}</code>
                </p>
                <p>
                  {t('擷取輸入版本', 'Captured input revision')}{' '}
                  <code>{holding.source.captured_input_revision ?? '—'}</code>
                </p>
                {[
                  ...(holding.source.reason ? [holding.source.reason] : []),
                  ...(holding.source.freshness_reasons ?? []),
                ].map((code) => (
                  <p className="notice" key={code}>
                    {reason(code, t)}
                  </p>
                ))}
              </details>
              {holding.events.length === 0 && (
                <p className="muted">
                  {t(
                    '此保存來源沒有回傳事件；不代表沒有公司行動。',
                    'This capture returned no events; it does not prove there were no corporate actions.',
                  )}
                </p>
              )}
              {holding.events.map((event, index) => (
                <div
                  className="corporate-ledger-event"
                  key={`${event.ex_date}-${event.kind}-${index}`}
                >
                  <strong>
                    {event.ex_date} ·{' '}
                    {event.kind === 'stock_split'
                      ? t('回傳拆併股', 'Reported split')
                      : t('回傳現金股息', 'Reported cash dividend')}{' '}
                    · {status(event.status, t)}
                  </strong>
                  <p className="muted">
                    {event.kind === 'stock_split'
                      ? t('來源股數倍率', 'Source shares multiplier')
                      : t('來源每股股息', 'Source dividend per share')}{' '}
                    {metric(event.source_value, 8)} · {t('來源原值', 'Source raw value')}{' '}
                    <code>{event.raw_value ?? '—'}</code>
                  </p>
                  {event.kind === 'cash_dividend' && (
                    <p>
                      {t('股息應收金額', 'Dividend cash entitlement')} — ·{' '}
                      {t('登記日', 'Record date')} — · {t('付款日', 'Payment date')} —
                    </p>
                  )}
                  {event.before && event.after && (
                    <p>
                      {t('條件式股數', 'Conditional shares')} {metric(event.before.shares)} →{' '}
                      {metric(event.after.shares)} ·{' '}
                      {t('條件式每股成本', 'Conditional cost per share')}{' '}
                      {metric(event.before.average_cost, 8)} → {metric(event.after.average_cost, 8)}
                    </p>
                  )}
                  {(event.source_reason || event.reasons.length > 0) && (
                    <p className="muted">
                      {[...(event.source_reason ? [event.source_reason] : []), ...event.reasons]
                        .map((code) => reason(code, t))
                        .join(' · ')}
                    </p>
                  )}
                </div>
              ))}
            </article>
          ))}
          <p className="research-note">
            {t(
              '下載保存此次已接受的完整回應，含來源原值、修訂、缺值與讀取時狀態；不重新抓取來源，也不證明下載當下仍為當期資料。',
              'The download preserves the complete accepted response, including source values, revisions, missing values and read-time status. It does not refetch sources or establish freshness at download time.',
            )}
          </p>
        </>
      )}
    </section>
  )
}
