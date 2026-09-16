import { useEffect, useMemo, useState } from 'react'
import { ArrowRight } from '@carbon/icons-react'
import type { Locale } from './locale'
import type { Overview, Scope } from './types'
import { DEFAULT_ALPHA_SETTINGS, rankAlpha, WEIGHT_PRESETS } from './alpha-model'
import {
  readWeightProfiles,
  WEIGHT_PROFILES_KEY,
  type WeightConfiguration,
} from './weight-profiles'
import { num } from './ui'

export function WeightComparison({
  data,
  scope,
  locale,
  onOpen,
  onLoad,
}: {
  data: Overview
  scope: Scope
  locale: Locale
  onOpen: (symbol: string, scope: Scope, date: string) => void
  onLoad: (configuration: WeightConfiguration) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [saved, setSaved] = useState(readWeightProfiles)
  const [selected, setSelected] = useState([
    'builtin:balanced',
    'builtin:momentum',
    'builtin:pullback',
  ])
  const [minimum, setMinimum] = useState(2)
  const [limit, setLimit] = useState(20)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const update = () => setSaved(readWeightProfiles())
    const storage = (event: StorageEvent) => {
      if (event.key === WEIGHT_PROFILES_KEY || event.key === null) update()
    }
    window.addEventListener('storage', storage)
    window.addEventListener('alphaview-weight-profiles', update)
    return () => {
      window.removeEventListener('storage', storage)
      window.removeEventListener('alphaview-weight-profiles', update)
    }
  }, [])
  const profiles = [
    ...Object.entries(WEIGHT_PRESETS).map(([id, weights]) => ({
      id: `builtin:${id}`,
      name:
        id === 'balanced'
          ? t('均衡', 'Balanced')
          : id === 'momentum'
            ? t('動能', 'Momentum')
            : t('回檔', 'Pullback'),
      weights,
      threshold: 50,
      minMatches: 2,
    })),
    ...saved.map((profile) => ({ ...profile, id: `saved:${profile.id}` })),
  ]
  const chosen = profiles.filter((profile) => selected.includes(profile.id))
  const results = useMemo(
    () =>
      chosen.map((profile) => ({
        profile,
        ranking: rankAlpha(data, scope, { ...DEFAULT_ALPHA_SETTINGS, ...profile }),
      })),
    [data, scope, JSON.stringify(chosen)],
  )
  const ready = results.length > 0 && results.every((result) => result.ranking.ready)
  const required = Math.min(minimum, chosen.length)
  const membership = new Set(
    results.flatMap((result) => result.ranking.alpha.map((row) => row.symbol)),
  )
  const rows = [...membership]
    .map((symbol) => ({
      symbol,
      candidates: results.map((result) => result.ranking.rows.find((row) => row.symbol === symbol)),
      count: results.filter((result) => result.ranking.alpha.some((row) => row.symbol === symbol))
        .length,
    }))
    .filter((row) => row.count >= required)
    .sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
  const held = new Set(
    data.positions.filter((position) => position.shares > 0).map((position) => position.symbol),
  )
  function toggle(id: string) {
    setSelected((previous) => {
      const active = previous.filter((value) => profiles.some((profile) => profile.id === value))
      return active.includes(id)
        ? active.filter((value) => value !== id)
        : active.length < 4
          ? [...active, id]
          : active
    })
    setLimit(20)
  }
  return (
    <section className="alpha-weight-comparison">
      <div className="section-heading">
        <div>
          <h2>
            {t('哪些候選在不同權重下仍然符合？', 'Which Candidates Survive Different Weights?')}
          </h2>
          <p>
            {t(
              '用同一日、同股票池比較 1–4 組設定，查看候選對權重選擇的敏感程度。',
              'Compare 1–4 configurations on the same session and universe to see how sensitive candidates are to weight choices.',
            )}
          </p>
        </div>
      </div>
      <p className="footnote">
        {t(
          '這是規則穩定度檢視，不是回測排名或未來表現預測。內建方案皆使用 50 分、至少兩項策略；自訂方案沿用各自門檻。',
          'This examines rule stability, not backtest rankings or future performance. Built-in profiles use 50 points and at least two matches; custom profiles use their saved thresholds.',
        )}
      </p>
      <fieldset className="alpha-profile-picker">
        <legend>{t('選擇比較方案（最多四組）', 'Choose Profiles (Up to Four)')}</legend>
        {profiles.map((profile) => (
          <label key={profile.id}>
            <input
              type="checkbox"
              checked={selected.includes(profile.id)}
              disabled={!selected.includes(profile.id) && chosen.length >= 4}
              onChange={() => toggle(profile.id)}
            />
            <span>
              {profile.name}
              <small>
                {profile.threshold} {t('分', 'points')} · {profile.minMatches}{' '}
                {t('項策略', 'matches')}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      {!chosen.length && (
        <p className="notice">{t('請至少選擇一組方案。', 'Select at least one profile.')}</p>
      )}
      {chosen.length > 0 && !ready && (
        <p className="notice">
          {t(
            '目前範圍的快照需要更新；請回到 Alpha 首頁同步重算。',
            'This scope needs a current snapshot. Return to Alpha Picks and recalculate both lists.',
          )}
        </p>
      )}
      {ready && (
        <>
          <div className="alpha-profile-summaries">
            {results.map(({ profile, ranking }) => (
              <article key={profile.id}>
                <strong>{profile.name}</strong>
                <b>
                  {ranking.alpha.length}
                  <small> Alpha Picks</small>
                </b>
                <p>
                  {ranking.alpha.filter((row) => held.has(row.symbol)).length}{' '}
                  {t('檔已持有', 'already held')} · {ranking.usable}/{ranking.total}{' '}
                  {t('可研究', 'usable')}
                </p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    onLoad({
                      weights: { ...profile.weights },
                      threshold: profile.threshold,
                      minMatches: profile.minMatches,
                    })
                    setMessage(
                      t(
                        `已將「${profile.name}」載入上方實驗權重；未更新首頁。`,
                        `Loaded “${profile.name}” into the experiment weights above; homepage unchanged.`,
                      ),
                    )
                  }}
                >
                  {t('載入實驗權重', 'Load Experiment Weights')}
                  <ArrowRight size={14} />
                </button>
              </article>
            ))}
          </div>
          {message && (
            <p className="notice" role="status">
              {message}
            </p>
          )}
          <div className="alpha-context">
            <label>
              {t('至少符合幾組方案', 'Minimum Matching Profiles')}{' '}
              <select
                value={required}
                onChange={(event) => {
                  setMinimum(Number(event.target.value))
                  setLimit(20)
                }}
              >
                {Array.from({ length: chosen.length }, (_, index) => (
                  <option key={index + 1} value={index + 1}>
                    {index + 1} / {chosen.length}
                  </option>
                ))}
              </select>
            </label>
            <small>
              {data.summary.expected_session} · {rows.length} {t('檔候選', 'candidates')}
            </small>
          </div>
          <div className="alpha-table-scroll">
            <table>
              <caption>
                {t(
                  '按符合方案數排序，再按代碼排序；各欄顯示該方案分數與 Alpha 資格。',
                  'Sorted by matching profile count, then ticker. Each column shows the profile score and Alpha eligibility.',
                )}
              </caption>
              <thead>
                <tr>
                  <th>{t('候選', 'Candidate')}</th>
                  <th>{t('符合方案', 'Matching Profiles')}</th>
                  {chosen.map((profile) => (
                    <th key={profile.id}>{profile.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((row) => (
                  <tr key={row.symbol}>
                    <td>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onOpen(row.symbol, scope, data.summary.expected_session!)}
                      >
                        {row.symbol}
                      </button>
                      {held.has(row.symbol) && <small> · {t('已持有', 'Held')}</small>}
                    </td>
                    <td>
                      {row.count} / {chosen.length}
                    </td>
                    {row.candidates.map((candidate, index) => (
                      <td key={chosen[index].id}>
                        {candidate
                          ? `${num(candidate.score, 0)} · ${candidate.alpha ? 'Alpha' : candidate.coverage < 100 - 1e-9 ? t('資料不足', 'Incomplete') : t('未達門檻', 'Below Criteria')}`
                          : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <p className="footnote">
              {t(
                '沒有候選符合目前設定的方案數。降低「至少符合幾組」可檢視其他交集。',
                'No candidate meets this number of profiles. Lower the minimum to explore other overlaps.',
              )}
            </p>
          )}
          {rows.length > limit && (
            <button type="button" className="button" onClick={() => setLimit(limit + 40)}>
              {t('顯示更多', 'Show More')}
            </button>
          )}
        </>
      )}
    </section>
  )
}
