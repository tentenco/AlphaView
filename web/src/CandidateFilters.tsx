import { useEffect, useState } from 'react'
import type { Locale } from './locale'
import { EMPTY_CRITERIA, validCandidateCriteria, type CandidateCriteria } from './candidate-filters'
export function CandidateFilters({
  criteria,
  locale,
  onApply,
}: {
  criteria: CandidateCriteria
  locale: Locale
  onApply: (criteria: CandidateCriteria) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const toDraft = () =>
    Object.fromEntries(
      Object.entries(criteria).map(([key, value]) => [key, value === null ? '' : String(value)]),
    ) as Record<keyof CandidateCriteria, string>
  const [draft, setDraft] = useState(toDraft)
  useEffect(() => setDraft(toDraft()), [criteria])
  const next = Object.fromEntries(
    Object.entries(draft).map(([key, value]) => [key, value.trim() === '' ? null : Number(value)]),
  ) as CandidateCriteria
  const valid = validCandidateCriteria(next)
  const active = Object.values(criteria).filter((value) => value !== null).length
  const labels: Record<keyof CandidateCriteria, string> = {
    minScore: t('最低 Alpha 分數', 'Minimum Alpha Score'),
    minRps: t('最低 RPS', 'Minimum RPS'),
    maxRsi: t('最高 RSI', 'Maximum RSI'),
  }
  return (
    <>
      <details className="alpha-candidate-filters">
        <summary>
          {t('進階指標篩選', 'Advanced Indicator Filters')}{' '}
          <span>
            {active
              ? t(`${active} 個條件已套用`, `${active} active conditions`)
              : t('未設定', 'Not Set')}
          </span>
        </summary>
        <p className="footnote">
          {t(
            '留白表示不限，範圍 0–100。缺少指定指標的標的不會通過篩選；僅縮小目前清單，不改變 Alpha 計分或重新執行策略。',
            'Leave blank for no limit; range 0–100. Candidates missing a required indicator are excluded. These filters narrow the current list without changing Alpha scores or rerunning strategies.',
          )}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) onApply(next)
          }}
        >
          <div className="alpha-basket-inputs">
            {(Object.keys(labels) as (keyof CandidateCriteria)[]).map((key) => (
              <label key={key}>
                {labels[key]}
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="any"
                  value={draft[key]}
                  placeholder={t('不限', 'No Limit')}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="actions">
            <button type="submit" className="button" disabled={!valid}>
              {t('套用指標篩選', 'Apply Indicator Filters')}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setDraft({ minScore: '', minRps: '', maxRsi: '' })
                onApply({ ...EMPTY_CRITERIA })
              }}
            >
              {t('清除指標條件', 'Clear Indicator Conditions')}
            </button>
          </div>
          {!valid && (
            <p role="status">
              {t(
                '請輸入 0–100 的有效數值，或留白。',
                'Enter valid values from 0 to 100, or leave blank.',
              )}
            </p>
          )}
        </form>
      </details>
      {active > 0 && (
        <div
          className="alpha-applied-filters"
          aria-label={t('已套用的指標條件', 'Applied Indicator Conditions')}
        >
          {(Object.keys(labels) as (keyof CandidateCriteria)[])
            .filter((key) => criteria[key] !== null)
            .map((key) => (
              <button
                type="button"
                className="text-button"
                key={key}
                aria-label={t(`移除${labels[key]}條件`, `Remove ${labels[key]} condition`)}
                onClick={() => onApply({ ...criteria, [key]: null })}
              >
                {labels[key]} {criteria[key]} ×
              </button>
            ))}
        </div>
      )}
    </>
  )
}
