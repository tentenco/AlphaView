import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deliverDesktopAlerts, undeliveredAlerts } from './desktop-alerts'
import type { RiskAlert } from './alpha-model'

const alerts: RiskAlert[] = [
  {
    id: 'high',
    symbol: 'MU',
    kind: 'concentration',
    severity: 'high',
    date: '2026-09-04',
    value: 54,
    threshold: 25,
  },
  {
    id: 'medium',
    symbol: 'META',
    kind: 'below_ma50',
    severity: 'medium',
    date: '2026-09-04',
    value: -2,
    threshold: 0,
  },
  {
    id: 'data',
    symbol: 'NVDA',
    kind: 'data_gap',
    severity: 'data',
    date: null,
    value: null,
    threshold: null,
  },
]
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())
it('keeps desktop alerts opt-in and excludes data notices, reviewed, and delivered conditions', () => {
  expect(undeliveredAlerts(alerts, { enabled: false, level: 'all' }, [], [])).toEqual([])
  expect(
    undeliveredAlerts(alerts, { enabled: true, level: 'high' }, [], []).map((item) => item.id),
  ).toEqual(['high'])
  expect(undeliveredAlerts(alerts, { enabled: true, level: 'all' }, ['high'], ['medium'])).toEqual(
    [],
  )
})
it('never requests browser permission automatically and deduplicates accepted notifications', async () => {
  const created: unknown[] = []
  class FakeNotification {
    static permission = 'granted'
    static requestPermission = vi.fn()
    constructor(title: string, options: NotificationOptions) {
      created.push({ title, options })
    }
    close() {}
  }
  vi.stubGlobal('Notification', FakeNotification)
  await deliverDesktopAlerts(alerts, { enabled: true, level: 'high' }, [], 'en')
  await deliverDesktopAlerts(alerts, { enabled: true, level: 'high' }, [], 'en')
  expect(created).toHaveLength(1)
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  FakeNotification.permission = 'denied'
  await deliverDesktopAlerts(alerts, { enabled: true, level: 'all' }, [], 'en')
  expect(created).toHaveLength(1)
})
