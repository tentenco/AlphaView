import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchDeskPaperBridge, type BridgeResult } from './ResearchDeskPaperBridge'
import type { PaperAccount, PaperPreview, PaperProposal } from './paper-model'

afterEach(() => {
  vi.unstubAllGlobals()
})

const account: PaperAccount = {
  id: 'synthetic-bridge-account',
  name: 'Synthetic bridge account',
  currency: 'USD',
  initial_cash: 10000,
  cash: 10000,
  version: 3,
  kill_switch: false,
  limits: { max_position_weight_pct: 35, max_turnover_pct: 100, min_cash_weight_pct: 10 },
  created_at: '2026-09-29T22:00:00Z',
  updated_at: '2026-09-29T22:00:00Z',
}
const config = {
  strategy: 'donchian_breakout' as const,
  params: { entry_period: 5, exit_period: 3 },
}
const preview: PaperPreview = {
  engine_version: 'alphaview-paper-portfolio-v2',
  as_of: '2026-09-29',
  input_revision: 'synthetic:1',
  account_id: account.id,
  account_version: 3,
  limits: account.limits,
  targets: [
    { symbol: 'SYNTA', weight_pct: 20 },
    { symbol: 'SYNTB', weight_pct: 0 },
  ],
  coverage: { required: 2, priced: 2, missing: [] },
  valuation_complete: true,
  equity_before: 10000,
  equity_after: 10000,
  cash_before: 10000,
  cash_after: 8000,
  cash_weight_after_pct: 80,
  turnover_pct: 20,
  fees_total: 2,
  slippage_total: 0,
  cost_total: 2,
  orders: [
    {
      symbol: 'SYNTA',
      side: 'buy',
      shares: 20,
      reference_price: 100,
      fill_price: 100,
      fee: 2,
      notional: 2000,
      current_shares: 0,
      target_shares: 20,
      target_weight_pct: 20,
      projected_weight_pct: 20,
    },
  ],
  violations: [],
  executable: true,
  method: 'Synthetic paper method.',
  warnings: [],
}
const proposal: PaperProposal = {
  ...preview,
  id: 'synthetic-bridge-proposal',
  status: 'proposed',
  created_at: '2026-09-30T00:00:00Z',
  accepted_at: null,
}
const validationPass: NonNullable<BridgeResult['validation']> = {
  mode: 'require_pass',
  gate: 'pass',
  skipped: false,
  acknowledge_fail: false,
  overridable: false,
  failing: [],
  warn: [],
  unavailable: [],
  reasons: [],
  engine_version: 'alphaview-validation-v1',
  input_revision: 'synthetic:1',
  folds: 4,
  trials: 1,
  overall: 'pass',
  counts: { pass: 1, warn: 0, fail: 0, unavailable: 0 },
  pass_share: 1,
  verdicts: { SYNTA: 'pass' },
  items: [],
}
const validationFail: NonNullable<BridgeResult['validation']> = {
  ...validationPass,
  gate: 'blocked',
  overridable: true,
  failing: ['SYNTA'],
  reasons: ['驗證 fail：SYNTA'],
  overall: 'fail',
  counts: { pass: 0, warn: 0, fail: 1, unavailable: 0 },
  pass_share: 0,
  verdicts: { SYNTA: 'fail' },
}
const result: BridgeResult = {
  engine_version: 'alphaview-strategy-bridge-v1',
  validation: validationPass,
  would_refuse: false,
  as_of: '2026-09-29',
  input_revision: 'synthetic:1',
  account_id: account.id,
  config,
  label: '通道突破 5/3',
  label_en: 'Donchian breakout 5/3',
  max_weight_pct: 20,
  slot_weight_pct: 20,
  decisions: [
    {
      symbol: 'SYNTA',
      held: false,
      status: 'enter',
      weight_pct: 20,
      reason: { code: 'entry_signal', message: '規則進場訊號成立' },
      evidence: {
        date: '2026-09-29',
        close: 120,
        entry: true,
        exit: false,
        valid: true,
        indicators: { upper: 100.1, lower: 99.9 },
      },
    },
    {
      symbol: 'SYNTB',
      held: false,
      status: 'unavailable',
      weight_pct: 0,
      reason: { code: 'history_stale', message: 'SYNTB 最新本機日線過舊' },
      evidence: null,
    },
  ],
  counts: { enter: 1, hold: 0, exit: 0, flat: 0, unavailable: 1 },
  target_weights: [
    { symbol: 'SYNTA', weight_pct: 20 },
    { symbol: 'SYNTB', weight_pct: 0 },
  ],
  invested_weight_pct: 20,
  labels: {
    enter: { zh: '進場', en: 'Enter' },
    hold: { zh: '續抱', en: 'Hold' },
    exit: { zh: '出場', en: 'Exit' },
    flat: { zh: '空手', en: 'Flat' },
    unavailable: { zh: '不可用', en: 'Unavailable' },
  },
  paper_preview: preview,
  method: 'Synthetic bridge method.',
  warnings: ['Synthetic bridge warning.'],
}
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
function mockApi(handler?: (url: string, init?: RequestInit) => unknown) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = handler?.(url, init)
    if (custom !== undefined) return custom
    if (url === '/api/paper/accounts') return response({ accounts: [account] })
    if (url === '/api/research-desk/paper-preview') return response(result)
    if (url === '/api/research-desk/paper-proposal')
      return response({ ...result, paper_preview: undefined, paper_proposal: proposal }, 201)
    throw new Error(`Unexpected test API ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const bodyOf = (fetcher: ReturnType<typeof mockApi>, url: string) =>
  JSON.parse(String(fetcher.mock.calls.find(([callUrl]) => callUrl === url)?.[1]?.body))

it('carries diagnosis risk and window through preview and saved proposal', async () => {
  const fetcher = mockApi()
  const risk = {
    initial_cash: 25000,
    fee_bps: 15,
    slippage_bps: 25,
    position_pct: 70,
    stop_loss_pct: 6,
    take_profit_pct: 12,
  }
  render(
    <ResearchDeskPaperBridge
      config={config}
      label="x"
      locale="en"
      defaultSymbols={['SYNTA']}
      risk={risk}
      testStart="2025-01-02"
      testEnd="2026-08-31"
    />,
  )
  await screen.findByRole('option', { name: 'Synthetic bridge account' })
  expect(screen.getByText(/Validation uses the diagnosis window/)).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
  await screen.findByText('Validation passed')
  await userEvent.click(screen.getByRole('button', { name: 'Save paper proposal' }))
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === '/api/research-desk/paper-proposal')).toBe(
      true,
    ),
  )
  for (const endpoint of ['paper-preview', 'paper-proposal']) {
    expect(bodyOf(fetcher, `/api/research-desk/${endpoint}`)).toMatchObject({
      risk,
      test_start: '2025-01-02',
      test_end: '2026-08-31',
    })
  }
})

it('requires a fresh preview after the diagnosis window changes', async () => {
  mockApi()
  const props = { config, label: 'x', locale: 'en' as const, defaultSymbols: ['SYNTA'] }
  const { rerender } = render(<ResearchDeskPaperBridge {...props} testEnd="2026-08-31" />)
  await screen.findByRole('option', { name: 'Synthetic bridge account' })
  await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
  await screen.findByText('Validation passed')
  expect(
    (screen.getByRole('button', { name: 'Save paper proposal' }) as HTMLButtonElement).disabled,
  ).toBe(false)
  rerender(<ResearchDeskPaperBridge {...props} testEnd="2026-09-15" />)
  expect(
    (screen.getByRole('button', { name: 'Save paper proposal' }) as HTMLButtonElement).disabled,
  ).toBe(true)
})

describe('Research Desk paper bridge', () => {
  it('previews today’s decisions for the diagnosed symbol with the account version', async () => {
    const fetcher = mockApi()
    render(
      <ResearchDeskPaperBridge
        config={config}
        label="Donchian breakout 5/3"
        locale="en"
        defaultSymbols={['SYNTA']}
      />,
    )
    await screen.findByRole('option', { name: 'Synthetic bridge account' })
    fireEvent.change(screen.getByLabelText('Symbols (up to 10)'), {
      target: { value: 'synta, syntb' },
    })
    const save = screen.getByRole('button', { name: 'Save paper proposal' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
    const panel = await screen.findByRole('region', { name: 'Paper-trade these rules' })
    await within(panel).findByText('Enter')
    expect(bodyOf(fetcher, '/api/research-desk/paper-preview')).toEqual({
      account_id: account.id,
      expected_account_version: 3,
      symbols: ['SYNTA', 'SYNTB'],
      config,
      max_weight_pct: 20,
      trials: 1,
      validation: { mode: 'require_pass' },
    })
    expect(within(panel).getByText('Unavailable')).toBeTruthy()
    expect(
      within(panel).getByText('Latest local bar is older than the latest completed session'),
    ).toBeTruthy()
    expect(within(panel).getByText(/upper 100\.10/)).toBeTruthy()
    expect(within(panel).getByText('Paper limits passed; the proposal can be saved')).toBeTruthy()
    expect(save.disabled).toBe(false)
  })

  it('saves the proposal with a generated idempotency key and points to the Agent page', async () => {
    const fetcher = mockApi()
    render(
      <ResearchDeskPaperBridge config={config} label="x" locale="en" defaultSymbols={['SYNTA']} />,
    )
    await screen.findByRole('option', { name: 'Synthetic bridge account' })
    await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
    await screen.findByText('Paper limits passed; the proposal can be saved')
    await userEvent.click(screen.getByRole('button', { name: 'Save paper proposal' }))
    await screen.findByText(/Paper proposal saved \(synthetic-bridge-proposal\); not executed/)
    const body = bodyOf(fetcher, '/api/research-desk/paper-proposal')
    expect(body.symbols).toEqual(['SYNTA'])
    expect(body.idempotency_key).toMatch(/^[A-Za-z0-9._:-]{8,100}$/)
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Save paper proposal' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    )
  })

  it('shows backend problems and blocks saving when the paper preview is not executable', async () => {
    mockApi((url) =>
      url === '/api/research-desk/paper-preview'
        ? response({
            ...result,
            paper_preview: {
              ...preview,
              executable: false,
              violations: [{ code: 'kill_switch', message: '虛擬帳戶已暫停' }],
            },
          })
        : undefined,
    )
    render(
      <ResearchDeskPaperBridge config={config} label="x" locale="en" defaultSymbols={['SYNTA']} />,
    )
    await screen.findByRole('option', { name: 'Synthetic bridge account' })
    await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
    await screen.findByText('Paper limits failed; the proposal is not executable')
    expect(screen.getByText('Paper simulation is paused for this account.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Save paper proposal' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    mockApi((url) =>
      url === '/api/research-desk/paper-preview'
        ? response({ detail: { code: 'no_history', message: 'SYNTA 沒有本機日線' } }, 422)
        : undefined,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
    await screen.findByText('SYNTA 沒有本機日線')
  })
})

describe('Research Desk paper bridge validation gate', () => {
  it('refuses a failing verdict until the override is acknowledged and records it in the save payload', async () => {
    const fetcher = mockApi((url, init) => {
      if (url === '/api/research-desk/paper-preview')
        return response({ ...result, validation: validationFail, would_refuse: true })
      if (url === '/api/research-desk/paper-proposal') {
        const body = JSON.parse(String(init?.body))
        return body.validation?.acknowledge_fail
          ? response(
              {
                ...result,
                validation: { ...validationFail, gate: 'overridden', acknowledge_fail: true },
                paper_preview: undefined,
                paper_proposal: proposal,
              },
              201,
            )
          : response({ detail: { code: 'validation_failed', message: '驗證 fail：SYNTA' } }, 422)
      }
      return undefined
    })
    render(
      <ResearchDeskPaperBridge config={config} label="x" locale="en" defaultSymbols={['SYNTA']} />,
    )
    await screen.findByRole('option', { name: 'Synthetic bridge account' })
    await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
    await screen.findByText('Validation failed; the proposal will be refused')
    expect(screen.getByText('SYNTA: fail')).toBeTruthy()
    expect(screen.getByText('驗證 fail：SYNTA')).toBeTruthy()
    const save = screen.getByRole('button', { name: 'Save paper proposal' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await userEvent.click(
      screen.getByRole('checkbox', { name: /I understand the validation failed/ }),
    )
    expect(save.disabled).toBe(false)
    await userEvent.click(save)
    await screen.findByText('Validation failed; explicitly overridden')
    expect(bodyOf(fetcher, '/api/research-desk/paper-proposal').validation).toEqual({
      mode: 'require_pass',
      acknowledge_fail: true,
    })
  })

  it('sends the chosen mode and trials and lets warn-only previews save without acknowledgement', async () => {
    const fetcher = mockApi((url) =>
      url === '/api/research-desk/paper-preview'
        ? response({
            ...result,
            validation: {
              ...validationFail,
              mode: 'warn_only',
              gate: 'warn',
              overridable: false,
              reasons: ['僅警告模式：fail SYNTA'],
            },
            would_refuse: false,
          })
        : undefined,
    )
    render(
      <ResearchDeskPaperBridge config={config} label="x" locale="en" defaultSymbols={['SYNTA']} />,
    )
    await screen.findByRole('option', { name: 'Synthetic bridge account' })
    await userEvent.selectOptions(screen.getByLabelText('Validation gate'), 'warn_only')
    fireEvent.change(screen.getByLabelText('Configurations compared (1–500)'), {
      target: { value: '12' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Preview paper allocation' }))
    await screen.findByText('Validation warn (warn / unavailable)')
    const body = bodyOf(fetcher, '/api/research-desk/paper-preview')
    expect(body.validation).toEqual({ mode: 'warn_only' })
    expect(body.trials).toBe(12)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Save paper proposal' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})
