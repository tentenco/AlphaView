import { useEffect, useRef, useState } from 'react'
import type { AgentRun } from './portfolio-agent-model'
import { num } from './ui'
import './workflow-path-receipts.css'

type Translate = (zh: string, en: string) => string
export type PathReceiptKind = 'path_validation' | 'path_costs'
export type PathReceiptRequest = {
  expected_proposal_fingerprint: string
  expected_input_revision: string
  expected_as_of: string
  fee_bps?: number[]
  slippage_bps?: number[]
}
type EvidenceBinding = {
  engine_version: string
  agent_run_id: string
  proposal_fingerprint: string
  input_revision: string
  as_of: string
  evidence_fingerprint: string
  current_at_snapshot: boolean
  request?: { fee_bps?: number[]; slippage_bps?: number[] }
}
type Metrics = {
  final_value: number
  return_pct: number
  max_drawdown_pct: number
  total_fees: number
}
type StoredEvidence = EvidenceBinding & {
  status: string
  metrics?: Metrics | null
  coverage: Record<string, unknown>
  reasons?: { code: string; symbol?: string; date?: string }[]
  curve?: { date: string; value: number }[]
  baseline?: StoredEvidence
  scenarios?: {
    fee_bps: number
    slippage_bps: number
    status: string
    metrics: Metrics | null
    costs: { fees: number; slippage: number; total: number } | null
    differences: { final_value: number; return_pp: number } | null
  }[]
  method: string
}
export type WorkflowPathReceipt = {
  id: string
  account_id: string
  run_id: string
  kind: PathReceiptKind
  created_at: string
  engine_version: string
  content_fingerprint: string
  integrity: { available: boolean; reason: string | null }
  currentness: { current: boolean | null; reasons: string[] }
  status: string | null
  as_of: string | null
  baseline_metrics: Metrics | null
  replayed?: boolean
  receipt?: {
    receipt_id: string
    kind: PathReceiptKind
    created_at: string
    request: PathReceiptRequest
    account_context: { account_id: string; version: number; symbol_policy: unknown }
    source_context: {
      agent_run_id: string
      proposal_fingerprint: string
      input_revision: string
      as_of: string
      history_fingerprint: string | null
      evidence_fingerprint: string
      account_binding: string
      versions: Record<string, string>
    }
    evidence: StoredEvidence
    policy: { advisory_only: boolean; execution_source: boolean; gating_authority: boolean }
    method: string
  } | null
}
type History = {
  account_id: string
  run_id: string
  kind: PathReceiptKind
  items: WorkflowPathReceipt[]
  pagination: { limit: number; offset: number; total: number; returned: number }
  retention: { per_account: number; global: number; max_bytes: number; automatic_deletion: boolean }
}
const metric = (value: number | null | undefined, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? num(value, digits) : '—'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const hashPattern = /^[a-f0-9]{64}$/
const statusLabel = (status: string | null, t: Translate) =>
  ({
    evaluated: t('當時已計算', 'Calculated at the time'),
    incomplete: t('當時部分情境不可用', 'Some scenarios were unavailable at the time'),
    unavailable: t('當時證據不可用', 'Evidence was unavailable at the time'),
  })[status ?? ''] ?? '—'
const freshness = (item: WorkflowPathReceipt, t: Translate) =>
  !item.integrity.available
    ? t('回條無法驗證', 'Receipt cannot be verified')
    : item.currentness.current === true
      ? t('讀取時來源相符', 'Sources matched when read')
      : item.currentness.current === false
        ? t('歷史來源已非當期', 'Historical sources are no longer current')
        : t('目前來源無法核對', 'Current sources cannot be checked')
const reasonLabel = (code: string, t: Translate) =>
  ({
    inputs_changed: t('工作區輸入版本已變更', 'Workspace input revision changed'),
    session_changed: t('最新完成交易日已變更', 'Latest completed session changed'),
    receipt_method_changed: t('回條方法版本已變更', 'Receipt method changed'),
    evidence_method_changed: t('保存證據的方法版本已變更', 'The saved evidence method changed'),
    path_method_changed: t('歷史路徑方法版本已變更', 'Historical path method changed'),
    workflow_method_changed: t('工作流方法版本已變更', 'Workflow method changed'),
    scan_method_changed: t('掃描方法版本已變更', 'Scan method changed'),
    allocator_method_changed: t('配置器方法版本已變更', 'Allocator method changed'),
    account_missing: t('原帳戶已不存在', 'Original account is missing'),
    account_context_changed: t('帳戶版本或政策已變更', 'Account version or policies changed'),
    workflow_missing: t('原保存工作流已不存在', 'Original saved workflow is missing'),
    workflow_changed: t('原保存工作流內容已變更', 'Original saved workflow changed'),
    context_unverifiable: t('目前來源內容無法核對', 'Current source contents cannot be checked'),
    receipt_unverifiable: t(
      '回條內容或來源無法核對',
      'Receipt contents or sources cannot be verified',
    ),
    receipt_content_changed: t('回條內容指紋不符', 'Receipt content fingerprint mismatch'),
    receipt_size_or_storage_invalid: t(
      '回條儲存格式或大小無效',
      'Invalid receipt storage format or size',
    ),
    held_corporate_action_unmodeled: t(
      '持有期間公司行動帳務無法重建',
      'Held corporate-action accounting cannot be reconstructed',
    ),
    decision_evidence_incomplete: t(
      '歷史決策證據不完整',
      'Historical decision evidence incomplete',
    ),
  })[code] ?? code

async function downloadOriginal(response: Response, selected: WorkflowPathReceipt) {
  const raw = await response.text()
  const parsed = JSON.parse(raw, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite receipt')
    return value
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  if (
    response.headers.get('etag') !== `"${selected.content_fingerprint}"` ||
    hash !== selected.content_fingerprint ||
    parsed.receipt_id !== selected.id ||
    parsed.kind !== selected.kind ||
    parsed.account_context?.account_id !== selected.account_id ||
    parsed.source_context?.agent_run_id !== selected.run_id ||
    parsed.policy?.advisory_only !== true ||
    parsed.policy?.execution_source !== false ||
    parsed.policy?.gating_authority !== false
  )
    throw new Error('Receipt download identity or content mismatch')
  return raw
}

function saveBlob(raw: string, item: WorkflowPathReceipt) {
  const anchor = document.createElement('a')
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }))
  anchor.href = url
  anchor.download = `alphaview-path-receipt-${item.kind}-${item.id.slice(0, 16)}.json`
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
}

export function WorkflowPathReceipts({
  account,
  run,
  kind,
  evidence = null,
  request = null,
  enabled,
  t,
}: {
  account: { id: string; version: number } | null
  run: AgentRun
  kind: PathReceiptKind
  evidence?: EvidenceBinding | null
  request?: PathReceiptRequest | null
  enabled: boolean
  t: Translate
}) {
  const identity = JSON.stringify([
    account?.id,
    account?.version,
    run.id,
    kind,
    evidence?.evidence_fingerprint,
    request,
  ])
  const latestIdentity = useRef(identity)
  latestIdentity.current = identity
  const operation = useRef<AbortController | null>(null)
  const [state, setState] = useState<{
    identity: string
    busy?: string
    error?: string
    notice?: string
    history?: History
    selected?: WorkflowPathReceipt
  }>({ identity })
  const current = state.identity === identity ? state : null
  const base = account
    ? `/api/paper/accounts/${encodeURIComponent(account.id)}/runs/${encodeURIComponent(run.id)}/path-receipts`
    : ''
  const boundEvidence =
    !!evidence &&
    !!request &&
    evidence.agent_run_id === run.id &&
    evidence.proposal_fingerprint === run.proposal_fingerprint &&
    evidence.input_revision === run.input_revision &&
    evidence.as_of === run.as_of &&
    evidence.current_at_snapshot === true &&
    hashPattern.test(evidence.evidence_fingerprint) &&
    request.expected_proposal_fingerprint === evidence.proposal_fingerprint &&
    request.expected_input_revision === evidence.input_revision &&
    request.expected_as_of === evidence.as_of &&
    (kind === 'path_validation'
      ? request.fee_bps === undefined && request.slippage_bps === undefined
      : Array.isArray(request.fee_bps) &&
        Array.isArray(request.slippage_bps) &&
        same(request.fee_bps, evidence.request?.fee_bps) &&
        same(request.slippage_bps, evidence.request?.slippage_bps))
  const canSave =
    !!account && enabled && run.saved && run.current !== false && boundEvidence && !current?.busy
  const canRead = !!account && run.saved && !current?.busy
  useEffect(() => {
    setState({ identity })
    return () => {
      operation.current?.abort()
      operation.current = null
    }
  }, [identity])

  async function act(
    action: string,
    execute: (signal: AbortSignal) => Promise<Partial<typeof state>>,
  ) {
    if (!account || operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setState((previous) => ({
      ...(previous.identity === identity ? previous : {}),
      identity,
      busy: action,
      error: '',
      notice: '',
    }))
    try {
      const next = await execute(controller.signal)
      if (!controller.signal.aborted && latestIdentity.current === identity)
        setState((previous) => ({ ...previous, ...next, identity, busy: undefined }))
    } catch (error) {
      if (!controller.signal.aborted && latestIdentity.current === identity)
        setState((previous) => ({
          ...previous,
          identity,
          busy: undefined,
          error: error instanceof Error ? error.message : String(error),
        }))
    } finally {
      if (operation.current === controller) operation.current = null
    }
  }
  async function read(response: Response) {
    const value = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message =
        typeof value.detail?.message === 'string'
          ? value.detail.message
          : t('路徑回條請求失敗，請重新讀取。', 'Path receipt request failed. Load again.')
      throw new Error(t(message, message))
    }
    return value
  }
  const matches = (item: WorkflowPathReceipt) =>
    item.account_id === account?.id && item.run_id === run.id && item.kind === kind
  function save() {
    if (!canSave || !account || !evidence || !request) return
    const frozen = {
      kind,
      request,
      expected_account_version: account.version,
      expected_evidence_engine_version: evidence.engine_version,
      expected_evidence_fingerprint: evidence.evidence_fingerprint,
    }
    void act('save', async (signal) => {
      const value = (await read(
        await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal,
          body: JSON.stringify(frozen),
        }),
      )) as WorkflowPathReceipt
      const recorded = value.receipt
      if (
        !matches(value) ||
        !value.integrity.available ||
        !recorded ||
        recorded.receipt_id !== value.id ||
        recorded.source_context.evidence_fingerprint !== frozen.expected_evidence_fingerprint ||
        recorded.source_context.proposal_fingerprint !== request.expected_proposal_fingerprint ||
        recorded.source_context.input_revision !== request.expected_input_revision ||
        recorded.source_context.as_of !== request.expected_as_of ||
        recorded.account_context.version !== frozen.expected_account_version
      )
        throw new Error(
          t('保存回應與這次路徑證據不符。', 'Saved response does not match this path evidence.'),
        )
      return {
        selected: value,
        history: undefined,
        notice: value.replayed
          ? t(
              '已讀取同一份歷史回條；原證據不重算、不重複保存。',
              'The same historical receipt was replayed without recomputation or a duplicate.',
            )
          : t('已保存不可變路徑證據回條。', 'Immutable path evidence receipt saved.'),
      }
    })
  }
  function loadHistory(offset = 0) {
    if (!canRead) return
    void act('list', async (signal) => {
      const value = (await read(
        await fetch(`${base}?kind=${kind}&limit=20&offset=${offset}`, {
          cache: 'no-store',
          signal,
        }),
      )) as History
      if (
        value.account_id !== account?.id ||
        value.run_id !== run.id ||
        value.kind !== kind ||
        !Array.isArray(value.items) ||
        value.items.some((item) => !matches(item))
      )
        throw new Error(
          t(
            '歷史清單與帳戶、工作流或證據種類不符。',
            'History does not match the account, workflow, or evidence kind.',
          ),
        )
      return { history: value }
    })
  }
  function loadReceipt(identifier: string) {
    if (!canRead) return
    void act('detail', async (signal) => {
      const value = (await read(
        await fetch(`${base}/${encodeURIComponent(identifier)}`, { cache: 'no-store', signal }),
      )) as WorkflowPathReceipt
      if (!matches(value) || value.id !== identifier)
        throw new Error(t('歷史路徑回條識別不符。', 'Historical path receipt identity mismatch.'))
      return { selected: value }
    })
  }
  function download() {
    const selected = current?.selected
    if (
      !selected?.integrity.available ||
      !selected.receipt ||
      !hashPattern.test(selected.content_fingerprint)
    )
      return
    void act('download', async (signal) => {
      const response = await fetch(
        `${base}/${encodeURIComponent(selected.id)}/evidence.json?expected_content_fingerprint=${encodeURIComponent(selected.content_fingerprint)}`,
        { cache: 'no-store', signal },
      )
      if (!response.ok) await read(response)
      let raw: string
      try {
        raw = await downloadOriginal(response, selected)
      } catch {
        throw new Error(
          t(
            '下載內容的識別或指紋不符，未產生檔案。',
            'Download identity or fingerprint mismatch; no file was created.',
          ),
        )
      }
      if (!signal.aborted && latestIdentity.current === identity) saveBlob(raw, selected)
      return {}
    })
  }
  const selected = current?.selected
  const preserved = selected?.integrity.available ? selected.receipt : null
  const historical = preserved?.evidence
  const baseline = kind === 'path_costs' ? historical?.baseline : historical
  const values = baseline?.curve?.map((point) => point.value) ?? []
  const finiteCurve = values.length > 1 && values.every(Number.isFinite)
  const low = finiteCurve ? Math.min(100000, ...values) : 0
  const high = finiteCurve ? Math.max(100000, ...values) : 0
  const points = values
    .map(
      (value, index) =>
        `${(index / (values.length - 1)) * 600},${150 - ((value - low) / (high - low || 1)) * 140}`,
    )
    .join(' ')
  return (
    <section
      className="workflow-path-receipts"
      aria-label={t('保存的路徑證據回條', 'Saved path evidence receipts')}
    >
      <h4>
        {kind === 'path_validation'
          ? t('保存與重讀歷史路徑', 'Save and reread historical paths')
          : t('保存與重讀成本情境', 'Save and reread cost scenarios')}
      </h4>
      <p className="research-note">
        {t(
          '保存時由伺服器重算並核對已檢閱證據；歷史值不覆寫，目前來源資格另外列出。這不是提案閘門、可執行來源或交易授權。',
          'The server recomputes and checks reviewed evidence before saving. Historical values are immutable; current source eligibility is shown separately. This is not a proposal gate, an execution source, or trading authorization.',
        )}
      </p>
      {!account && (
        <p className="notice">
          {t(
            '選擇模擬帳戶後，可保存或讀取該帳戶的路徑回條。',
            'Select a paper account to save or read its path receipts.',
          )}
        </p>
      )}
      <div className="actions">
        <button type="button" className="button" disabled={!canSave} onClick={save}>
          {current?.busy === 'save'
            ? t('核對並保存路徑中…', 'Checking and saving path…')
            : t('保存這次路徑證據', 'Save this path evidence')}
        </button>
        <button type="button" className="button" disabled={!canRead} onClick={() => loadHistory()}>
          {current?.busy === 'list'
            ? t('讀取路徑回條中…', 'Loading path receipts…')
            : t('讀取此工作流回條歷史', 'Load receipt history for this workflow')}
        </button>
      </div>
      {account && !boundEvidence && (
        <p>
          {t(
            '先計算並核對當期證據，才能保存；仍可讀取歷史回條。',
            'Calculate and check current evidence before saving; historical receipts remain readable.',
          )}
        </p>
      )}
      {current?.error && (
        <p className="error-message" role="alert">
          {current.error}
        </p>
      )}
      {current?.notice && (
        <p className="notice" role="status">
          {current.notice}
        </p>
      )}
      {current?.history && (
        <>
          <p>
            {t('此帳戶與工作流的回條數', 'Receipts for this account and workflow')}:{' '}
            {current.history.pagination.total} ·{' '}
            {t('每帳戶 / 工作區保留上限', 'Per-account / workspace retention limit')}:{' '}
            {current.history.retention.per_account} / {current.history.retention.global}
          </p>
          {current.history.items.length ? (
            <div className="table-scroll">
              <table aria-label={t('路徑證據回條歷史', 'Path evidence receipt history')}>
                <thead>
                  <tr>
                    {[
                      t('保存時間', 'Saved at'),
                      t('當次證據', 'Recorded evidence'),
                      t('來源資格', 'Source eligibility'),
                      t('讀取', 'Load'),
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.history.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.created_at}</td>
                      <td>{statusLabel(item.status, t)}</td>
                      <td>{freshness(item, t)}</td>
                      <td>
                        <button
                          type="button"
                          className="button"
                          disabled={!!current.busy || !hashPattern.test(item.id)}
                          onClick={() => loadReceipt(item.id)}
                          aria-label={`${t('讀取路徑回條', 'Load path receipt')} ${item.id.slice(0, 12)}`}
                        >
                          {t('讀取路徑回條', 'Load path receipt')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>{t('此工作流尚無這類回條。', 'No receipts of this kind for this workflow.')}</p>
          )}
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={!canRead || current.history.pagination.offset === 0}
              onClick={() => loadHistory(Math.max(0, current.history!.pagination.offset - 20))}
            >
              {t('較新回條', 'Newer receipts')}
            </button>
            <button
              type="button"
              className="button"
              disabled={
                !canRead ||
                current.history.pagination.offset + current.history.items.length >=
                  current.history.pagination.total
              }
              onClick={() => loadHistory(current.history!.pagination.offset + 20)}
            >
              {t('較舊回條', 'Older receipts')}
            </button>
          </div>
        </>
      )}
      {selected && (
        <div
          className="workflow-path-receipt-detail"
          aria-label={t('保存路徑回條明細', 'Saved path receipt detail')}
        >
          <h5>{t('當時保存的路徑證據', 'Path evidence recorded at the time')}</h5>
          <p>
            {selected.created_at} · {selected.as_of ?? '—'} · {statusLabel(selected.status, t)}
          </p>
          <p role="status">{freshness(selected, t)}</p>
          {!!selected.currentness.reasons.length && (
            <ul>
              {selected.currentness.reasons.map((reason) => (
                <li key={reason}>{reasonLabel(reason, t)}</li>
              ))}
            </ul>
          )}
          {!selected.integrity.available && (
            <p className="notice">
              {t(
                '回條無法驗證，歷史數值與下載不可用；不會重建或覆寫。',
                'The receipt cannot be verified. Historical values and download are unavailable; it will not be rebuilt or overwritten.',
              )}
            </p>
          )}
          {preserved && historical && (
            <>
              <p>
                {preserved.source_context.account_binding === 'workflow_bound'
                  ? t(
                      '原工作流已綁定此帳戶的標的政策。',
                      'The original workflow was bound to this account’s symbol policy.',
                    )
                  : t(
                      '此帳戶只用於歸檔；原工作流未綁定帳戶，不是此帳戶的歷史績效。',
                      'This account is a filing association only. The original workflow was unbound; this is not that account’s historical performance.',
                    )}
              </p>
              <dl className="workflow-receipt-metrics">
                {[
                  [
                    t('保存基準期末資產', 'Recorded baseline final equity'),
                    metric(baseline?.metrics?.final_value),
                  ],
                  [
                    t('保存基準報酬（%）', 'Recorded baseline return (%)'),
                    metric(baseline?.metrics?.return_pct),
                  ],
                  [
                    t('保存基準最大回撤（%）', 'Recorded baseline maximum drawdown (%)'),
                    metric(baseline?.metrics?.max_drawdown_pct),
                  ],
                  [
                    t('保存基準累計費用', 'Recorded baseline total fees'),
                    metric(baseline?.metrics?.total_fees, 4),
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {!!baseline?.reasons?.length && (
                <ul>
                  {baseline.reasons.map((reason, index) => (
                    <li key={index}>
                      {reason.symbol} {reason.date} {reasonLabel(reason.code, t)}
                    </li>
                  ))}
                </ul>
              )}
              {finiteCurve && (
                <figure className="workflow-receipt-chart">
                  <svg
                    viewBox="0 0 600 165"
                    role="img"
                    aria-label={t('保存基準資產路徑', 'Recorded baseline equity path')}
                  >
                    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                  <figcaption>
                    {t('保存基準資產值範圍', 'Recorded baseline equity range')}: {metric(low)} –{' '}
                    {metric(high)}
                  </figcaption>
                </figure>
              )}
              {!!historical.scenarios?.length && (
                <div className="table-scroll">
                  <table aria-label={t('保存的成本情境', 'Recorded cost scenarios')}>
                    <thead>
                      <tr>
                        {[
                          t('費用 / 滑價（bps）', 'Fee / slippage (bps)'),
                          t('當次證據', 'Recorded evidence'),
                          t('期末資產', 'Final equity'),
                          t('報酬（%）', 'Return (%)'),
                          t('明列成本', 'Explicit costs'),
                          t('資產差（對原基準）', 'Equity difference vs baseline'),
                        ].map((label) => (
                          <th scope="col" key={label}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {historical.scenarios.map((item) => (
                        <tr key={`${item.fee_bps}:${item.slippage_bps}`}>
                          <th scope="row">
                            {metric(item.fee_bps)} / {metric(item.slippage_bps)}
                          </th>
                          <td>{statusLabel(item.status, t)}</td>
                          <td>{metric(item.metrics?.final_value)}</td>
                          <td>{metric(item.metrics?.return_pct)}</td>
                          <td>{metric(item.costs?.total, 4)}</td>
                          <td>{metric(item.differences?.final_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button
                type="button"
                className="button"
                disabled={!!current?.busy}
                onClick={download}
              >
                {current?.busy === 'download'
                  ? t('下載路徑回條中…', 'Downloading path receipt…')
                  : t('下載保存路徑回條原始 JSON', 'Download original saved path receipt JSON')}
              </button>
              <details>
                <summary>
                  {t('保存的請求、來源與方法', 'Saved request, sources, and method')}
                </summary>
                <p>
                  {t('保存帳戶版本', 'Saved account version')}: {preserved.account_context.version}
                </p>
                <p>
                  {t('保存請求', 'Saved request')}: <code>{JSON.stringify(preserved.request)}</code>
                </p>
                <p>
                  {t('保存方法版本', 'Saved method versions')}:{' '}
                  <code>{JSON.stringify(preserved.source_context.versions)}</code>
                </p>
                <p>
                  {t('保存輸入版本', 'Saved input revision')}:{' '}
                  {preserved.source_context.input_revision}
                </p>
                <p>
                  {t('保存歷史指紋', 'Saved history fingerprint')}:{' '}
                  <code>{preserved.source_context.history_fingerprint ?? '—'}</code>
                </p>
                <p>
                  {t('保存證據指紋', 'Saved evidence fingerprint')}:{' '}
                  <code>{preserved.source_context.evidence_fingerprint}</code>
                </p>
                <p>
                  {t('回條內容指紋', 'Receipt content fingerprint')}:{' '}
                  <code>{selected.content_fingerprint}</code>
                </p>
                <p>{historical.method}</p>
                <p>{preserved.method}</p>
              </details>
            </>
          )}
          <p className="research-note">
            {t(
              '來源資格只描述此次讀取，不改寫原證據，也不保證日後仍相符。下載逐字保存伺服器回條，不重新計算、套用設定或送出提案。',
              'Source eligibility describes this read only; it does not rewrite evidence or guarantee future freshness. Downloads preserve the server’s receipt bytes without recomputation, applying settings, or submitting proposals.',
            )}
          </p>
        </div>
      )}
    </section>
  )
}
