import { validTrackingRecord, type TrackingRecord } from './research-tracker'
import type { Locale } from './locale'

function escapeText(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}
// RFC 5545 content lines fold at UTF-8 octet boundaries, including continuation space.
export function foldCalendarLine(line: string) {
  const encoder = new TextEncoder()
  const lines: string[] = []
  let current = ''
  let bytes = 0
  for (const character of line) {
    const size = encoder.encode(character).length
    if (bytes + size > 75) {
      lines.push(current)
      current = ' '
      bytes = 1
    }
    current += character
    bytes += size
  }
  lines.push(current)
  return lines.join('\r\n')
}
export function calendarRecords(records: TrackingRecord[]) {
  return records
    .filter(
      (record) => validTrackingRecord(record) && record.stage !== 'archived' && record.reviewOn,
    )
    .filter((record, index, rows) => rows.findIndex((r) => r.symbol === record.symbol) === index)
    .slice(0, 200)
    .sort((a, b) => a.reviewOn.localeCompare(b.reviewOn) || a.symbol.localeCompare(b.symbol))
}
export function researchCalendar(records: TrackingRecord[], locale: Locale, now = new Date()) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const stageNames = {
    inbox: t('待研究', 'Inbox'),
    researching: t('研究中', 'Researching'),
    monitoring: t('持續觀察', 'Monitoring'),
    archived: t('封存', 'Archived'),
  }
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AlphaView//Research Review//EN',
    'CALSCALE:GREGORIAN',
  ]
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  for (const record of calendarRecords(records)) {
    const next = new Date(`${record.reviewOn}T00:00:00.000Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    const end = next.toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('calendar_date_range')
    const description = `${stageNames[record.stage]}\n${record.reason}\n\n${t('AlphaView 個人研究複查。此匯出不會同步後續修改；提醒請在行事曆中設定。', 'AlphaView personal research review. This export does not sync later changes; configure reminders in your calendar.')}`
    lines.push(
      'BEGIN:VEVENT',
      `UID:${record.symbol}-${record.reviewOn}@alphaview.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${record.reviewOn.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${end.replace(/-/g, '')}`,
      `SUMMARY:${escapeText(`${record.symbol} · ${t('AlphaView 研究複查', 'AlphaView Research Review')}`)}`,
      `DESCRIPTION:${escapeText(description)}`,
      'CLASS:PRIVATE',
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldCalendarLine).join('\r\n') + '\r\n'
}
