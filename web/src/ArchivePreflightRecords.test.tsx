import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArchivePreflightRecords, type ArchivePreflightRecord } from './ArchivePreflightRecords'

const t = (_zh: string, en: string) => en
type Record = ArchivePreflightRecord & { detail: string }
function records(count: number): Record[] {
  return Array.from({ length: count }, (_, index) => ({
    id: (count - index).toString(16).padStart(64, '0'),
    compatible: index % 2 === 0,
    detail: `Original detail ${index}`,
  }))
}
const rowNodes = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLDetailsElement>('[data-archive-record-index]'))
const indices = (container: HTMLElement) =>
  rowNodes(container).map((row) => Number(row.dataset.archiveRecordIndex))
const content = (record: Record, index: number) => (
  <p>
    {record.detail} · original index {index}
  </p>
)
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('archive preflight record presentation', () => {
  it('paginates 500 immutable records in original order, never sorting or changing objects', () => {
    const values = records(500).map((value) => Object.freeze(value))
    Object.freeze(values)
    const raw = JSON.stringify(values)
    const report = {}
    const received = vi.fn(content)
    const view = render(
      <ArchivePreflightRecords records={values} resultIdentity={report} t={t}>
        {received}
      </ArchivePreflightRecords>,
    )
    expect(indices(view.container)).toEqual(Array.from({ length: 25 }, (_, index) => index))
    expect(screen.getByRole('status').textContent).toBe(
      'Matched 500 / 500 returned records · Showing 1–25 · 25 per page',
    )
    expect(screen.getByText('Page 1 / 20')).toBeTruthy()
    expect(received.mock.calls[0][0]).toBe(values[0])
    expect(received.mock.calls[24][0]).toBe(values[24])
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(indices(view.container)).toEqual(Array.from({ length: 25 }, (_, index) => index + 25))
    for (let page = 2; page < 20; page++)
      fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(indices(view.container)).toEqual(Array.from({ length: 25 }, (_, index) => index + 475))
    expect(screen.getByText('Page 20 / 20')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('Showing 476–500')
    expect(JSON.stringify(values)).toBe(raw)
  })

  it('combines compatibility and case-insensitive literal ID search, resetting pages and keeping complete counts', () => {
    const values = records(60)
    const report = {}
    const view = render(
      <ArchivePreflightRecords records={values} resultIdentity={report} t={t}>
        {content}
      </ArchivePreflightRecords>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Compatibility filter' }), {
      target: { value: 'compatible' },
    })
    expect(screen.getByText('Page 1 / 2')).toBeTruthy()
    expect(indices(view.container)).toEqual(Array.from({ length: 25 }, (_, index) => index * 2))
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(indices(view.container)).toEqual([50, 52, 54, 56, 58])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search receipt ID (optional)' }), {
      target: { value: values[0].id!.toUpperCase() },
    })
    expect(indices(view.container)).toEqual([0])
    expect(screen.getByRole('status').textContent).toContain('Matched 1 / 60')
    expect(screen.getByText('Page 1 / 1')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '[not a regex]' } })
    expect(rowNodes(view.container)).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toContain(
      'Matched 0 / 60 returned records · Showing 0–0',
    )
    expect(screen.getByText('Page 0 / 0')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true)
    expect(
      screen.getByText(
        'No records match this filter; the full preflight result above still applies.',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }))
    expect(screen.getByRole('searchbox')).toHaveProperty('value', '')
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'all')
    expect(indices(view.container)[0]).toBe(0)
  })

  it('preserves controls across unrelated renders and cloned record arrays, but resets on a new accepted report', () => {
    const values = records(120)
    const report = {}
    const view = render(
      <ArchivePreflightRecords records={values} resultIdentity={report} t={t}>
        {content}
      </ArchivePreflightRecords>,
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'unavailable' } })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByText('Page 2 / 3')).toBeTruthy()
    view.rerender(
      <ArchivePreflightRecords records={[...values]} resultIdentity={report} t={(_zh, en) => en}>
        {content}
      </ArchivePreflightRecords>,
    )
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'unavailable')
    expect(screen.getByRole('searchbox')).toHaveProperty('value', '000')
    expect(screen.getByText('Page 2 / 3')).toBeTruthy()
    view.rerender(
      <ArchivePreflightRecords records={records(2)} resultIdentity={{}} t={t}>
        {content}
      </ArchivePreflightRecords>,
    )
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'all')
    expect(screen.getByRole('searchbox')).toHaveProperty('value', '')
    expect(screen.getByText('Page 1 / 1')).toBeTruthy()
    expect(indices(view.container)).toEqual([0, 1])
  })

  it('clamps an out-of-range page immediately if a caller supplies fewer records without changing report identity', () => {
    const report = {}
    const values = records(60)
    const view = render(
      <ArchivePreflightRecords records={values} resultIdentity={report} t={t}>
        {content}
      </ArchivePreflightRecords>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    view.rerender(
      <ArchivePreflightRecords records={values.slice(0, 1)} resultIdentity={report} t={t}>
        {content}
      </ArchivePreflightRecords>,
    )
    expect(screen.getByText('Page 1 / 1')).toBeTruthy()
    expect(indices(view.container)).toEqual([0])
    expect(screen.getByRole('status').textContent).toContain('Showing 1–1')
  })

  it('keeps duplicate and unknown IDs as distinct original rows, with full IDs inside native details', async () => {
    const id = 'abcdef0123456789'.repeat(4)
    const values: Record[] = [
      { id, compatible: true, detail: 'Duplicate first' },
      { id: null, compatible: false, detail: 'Unknown original' },
      { id, compatible: false, detail: 'Duplicate second' },
      { id: '', compatible: false, detail: 'Empty original' },
    ]
    const view = render(
      <ArchivePreflightRecords records={values} resultIdentity={{}} t={t}>
        {content}
      </ArchivePreflightRecords>,
    )
    const rows = rowNodes(view.container)
    expect(rows).toHaveLength(4)
    expect(indices(view.container)).toEqual([0, 1, 2, 3])
    const summary = rows[0].querySelector('summary')!
    expect(summary.textContent).toContain('abcdef012345…23456789')
    expect(summary.textContent).not.toContain(id)
    expect(summary.querySelector('code')?.title).toBe(id)
    expect(within(rows[0]).getByText(id)).toBeTruthy()
    expect(screen.getAllByText('Unknown identity')).toHaveLength(2)
    expect(within(rows[1]).getByText('—')).toBeTruthy()
    expect(within(rows[3]).getByText('""')).toBeTruthy()
    await userEvent.click(summary)
    expect(rows[0].open).toBe(true)
    expect(rows[2].open).toBe(false)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'unavailable' } })
    expect(indices(view.container)).toEqual([1, 2, 3])
    expect(screen.getByText('Duplicate second · original index 2')).toBeTruthy()
  })

  it('shows an explicit empty report without an invented page or record', () => {
    const view = render(
      <ArchivePreflightRecords records={[]} resultIdentity={{}} t={t}>
        {content}
      </ArchivePreflightRecords>,
    )
    expect(rowNodes(view.container)).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe(
      'Matched 0 / 0 returned records · Showing 0–0 · 25 per page',
    )
    expect(screen.getByText('Page 0 / 0')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true)
  })

  it('uses native keyboard controls without fetching, submitting, persisting or rewriting the route', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault())
    const hash = window.location.hash
    const view = render(
      <form onSubmit={submit}>
        <ArchivePreflightRecords records={records(60)} resultIdentity={{}} t={t}>
          {content}
        </ArchivePreflightRecords>
      </form>,
    )
    const user = userEvent.setup()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    await user.keyboard('{Enter}')
    expect(submit).not.toHaveBeenCalled()
    screen.getByRole('button', { name: 'Next page' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('Page 2 / 3')).toBeTruthy()
    screen.getByRole('button', { name: 'Previous page' }).focus()
    await user.keyboard(' ')
    expect(screen.getByText('Page 1 / 3')).toBeTruthy()
    const summary = rowNodes(view.container)[0].querySelector('summary')!
    await user.click(summary)
    expect(rowNodes(view.container)[0].open).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(window.location.hash).toBe(hash)
  })
})

function csvDownloads() {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:preflight-csv')
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return {
    createObjectURL,
    text: (index: number) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = reject
        reader.readAsText(createObjectURL.mock.calls[index][0])
      }),
  }
}
function csvReport(values: Record[], reason = 'blocked_original') {
  return {
    engine_version: 'alphaview-research-integrity-archive-v1',
    symbol: 'SYNTHETIC',
    as_of: '2026-10-01',
    verdict: 'blocked',
    compatible: false,
    reasons: [reason],
    coverage: { checked: values.length, unavailable: null },
    capacity: { remaining: 0 },
    records: values,
  }
}

describe('complete preflight CSV controls', () => {
  it('downloads all 500 original records and full blocked metadata after paging and filtering to zero, without requests or storage', async () => {
    const values = records(500),
      report = csvReport(values)
    const mock = csvDownloads(),
      fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    render(
      <ArchivePreflightRecords records={values} resultIdentity={report} csvReport={report} t={t}>
        {content}
      </ArchivePreflightRecords>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'compatible' } })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } })
    expect(screen.getByRole('status').textContent).toContain('Matched 0 / 500')
    fireEvent.click(screen.getByRole('button', { name: 'Download all preflight records CSV' }))
    const csv = await mock.text(0)
    expect(csv.match(/"\/records\/\d+\/id"/g)).toHaveLength(500)
    expect(csv.indexOf('Original detail 0')).toBeLessThan(csv.indexOf('Original detail 499'))
    expect(csv).toContain('"/verdict","string","blocked"')
    expect(csv).toContain('"/coverage/checked","number","500"')
    expect(csv).toContain('"/capacity/remaining","number","0"')
    expect(fetcher).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
  })

  it('uses only the new accepted identity and exports zero-record blocked metadata; stale binding is disabled', async () => {
    const old = csvReport(records(2)),
      fresh = csvReport([], 'replacement_rejected')
    const mock = csvDownloads()
    const view = render(
      <ArchivePreflightRecords records={old.records} resultIdentity={old} csvReport={old} t={t}>
        {content}
      </ArchivePreflightRecords>,
    )
    view.rerender(
      <ArchivePreflightRecords
        records={fresh.records}
        resultIdentity={fresh}
        csvReport={fresh}
        t={t}
      >
        {content}
      </ArchivePreflightRecords>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download all preflight records CSV' }))
    const csv = await mock.text(0)
    expect(csv).toContain('replacement_rejected')
    expect(csv).toContain('"/record_count","number","0"')
    expect(csv).not.toContain('blocked_original')
    expect(csv).not.toContain('/records/0')
    view.rerender(
      <ArchivePreflightRecords records={fresh.records} resultIdentity={fresh} csvReport={old} t={t}>
        {content}
      </ArchivePreflightRecords>,
    )
    expect(
      screen.getByRole('button', { name: 'Download all preflight records CSV' }),
    ).toHaveProperty('disabled', true)
    expect(screen.getByRole('alert').textContent).toContain('No partial file')
    view.unmount()
    expect(screen.queryByRole('button', { name: 'Download all preflight records CSV' })).toBeNull()
    expect(mock.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('shows an explicit unavailable CSV for unsupported values without a partial download', () => {
    const report = { ...csvReport(records(1)), future: Infinity }
    const mock = csvDownloads()
    render(
      <ArchivePreflightRecords
        records={report.records}
        resultIdentity={report}
        csvReport={report}
        t={t}
      >
        {content}
      </ArchivePreflightRecords>,
    )
    const button = screen.getByRole('button', { name: 'Download all preflight records CSV' })
    expect(button).toHaveProperty('disabled', true)
    expect(screen.getByRole('alert').textContent).toContain('Complete preflight CSV unavailable')
    fireEvent.click(button)
    expect(mock.createObjectURL).not.toHaveBeenCalled()
  })
})
