import { expect, it } from 'vitest'
import { calendarRecords, foldCalendarLine, researchCalendar } from './research-calendar'
import type { TrackingRecord } from './research-tracker'

const record: TrackingRecord = {
  symbol: 'NVDA',
  stage: 'monitoring',
  reason: '研究,資料;備註\\\nBEGIN:VEVENT',
  reviewOn: '2026-12-31',
  version: 1,
  updatedAt: '2026-09-07T00:00:00Z',
}
it('exports saved active reviews as escaped all-day events with exclusive next-day end', () => {
  const records = [
    record,
    { ...record, symbol: 'META', stage: 'archived' as const },
    { ...record, symbol: 'MU', reviewOn: '' },
  ]
  expect(calendarRecords(records)).toEqual([record])
  const text = researchCalendar(records, 'en', new Date('2026-09-07T01:02:03Z')).replace(
    /\r\n /g,
    '',
  )
  expect(text).toContain('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101')
  expect(text).toContain('DTSTAMP:20260907T010203Z')
  expect(text).toContain('研究\\,資料\\;備註\\\\\\nBEGIN:VEVENT')
  expect(text.match(/^BEGIN:VEVENT$/gm)).toHaveLength(1)
  expect(text).not.toContain('VALARM')
  expect(() => researchCalendar([{ ...record, reviewOn: '9999-12-31' }], 'en')).toThrow(
    'calendar_date_range',
  )
})
it('folds long multilingual text by bytes without corrupting Unicode', () => {
  const original = 'DESCRIPTION:' + '繁體中文🙂'.repeat(40)
  const folded = foldCalendarLine(original)
  expect(folded.replace(/\r\n /g, '')).toBe(original)
  for (const line of folded.split('\r\n'))
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
})
