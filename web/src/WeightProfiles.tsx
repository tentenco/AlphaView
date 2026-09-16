import { useEffect, useState } from 'react'
import { Save } from '@carbon/icons-react'
import type { Locale } from './locale'
import { STRATEGY_IDS } from './alpha-model'
import { num } from './ui'
import {
  readWeightProfiles,
  validWeightProfile,
  WEIGHT_PROFILES_KEY,
  type WeightConfiguration,
  type WeightProfile,
} from './weight-profiles'

export function WeightProfiles({
  configuration,
  locale,
  onLoad,
}: {
  configuration: WeightConfiguration
  locale: Locale
  onLoad: (configuration: WeightConfiguration) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [profiles, setProfiles] = useState(readWeightProfiles)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [previous, setPrevious] = useState<WeightConfiguration | null>(null)
  const [removed, setRemoved] = useState<WeightProfile | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === WEIGHT_PROFILES_KEY || event.key === null) setProfiles(readWeightProfiles())
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [])
  async function change(update: (current: WeightProfile[]) => WeightProfile[]) {
    if (busy) return false
    setBusy(true)
    try {
      const write = () => {
        const next = update(readWeightProfiles())
        if (next.length > 12) throw new Error('profile_limit')
        localStorage.setItem(WEIGHT_PROFILES_KEY, JSON.stringify(next))
        return next
      }
      setProfiles(
        navigator.locks?.request
          ? await navigator.locks.request('alphaview-weight-profiles', write)
          : write(),
      )
      window.dispatchEvent(new Event('alphaview-weight-profiles'))
      return true
    } catch (err) {
      setMessage(
        (err as Error).message === 'profile_limit'
          ? t('最多保存 12 組，請先移除一組。', 'Save up to 12 profiles. Remove one first.')
          : t(
              '無法保存權重方案，請檢查瀏覽器儲存空間。',
              'Could not save weight profiles. Check browser storage.',
            ),
      )
      return false
    } finally {
      setBusy(false)
    }
  }
  const valid = validWeightProfile({
    ...configuration,
    id: 'draft',
    name: name.trim(),
    savedAt: new Date().toISOString(),
  })
  const names = {
    turtle: t('海龜', 'Turtle'),
    trend: t('趨勢', 'Trend'),
    pullback: t('回檔', 'Pullback'),
    rps: 'RPS',
  }
  return (
    <details className="alpha-weight-profiles">
      <summary>
        {t('我的權重方案', 'My Weight Profiles')} <span>{profiles.length} / 12</span>
      </summary>
      <p className="footnote">
        {t(
          '命名保存四策略權重、Alpha 分數與最低策略數。載入只替換目前編輯中的權重；不改提醒門檻，也不自動套用到首頁或執行實驗。',
          'Save named strategy weights, the Alpha score threshold, and minimum matches. Loading replaces the weights currently being edited; it does not change alert thresholds, apply to the homepage, or run an experiment.',
        )}
      </p>
      <div className="actions">
        <label>
          {t('方案名稱', 'Profile Name')}
          <input
            maxLength={60}
            value={name}
            disabled={busy}
            placeholder={t('例如：我的動能組合', 'For example: My momentum mix')}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={busy || !valid}
          onClick={async () => {
            const item = {
              weights: { ...configuration.weights },
              threshold: configuration.threshold,
              minMatches: configuration.minMatches,
              id: crypto.randomUUID(),
              name: name.trim(),
              savedAt: new Date().toISOString(),
            }
            if (await change((current) => [...current, item])) {
              setName('')
              setMessage(t(`已保存「${item.name}」。`, `Saved “${item.name}”.`))
            }
          }}
        >
          <Save size={15} />
          {t('保存此方案', 'Save This Profile')}
        </button>
      </div>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {previous && (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            onLoad(previous)
            setPrevious(null)
          }}
        >
          {t('恢復載入前的權重', 'Restore Previous Weights')}
        </button>
      )}
      {removed && (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={async () => {
            if (
              await change((current) =>
                current.some((p) => p.id === removed.id) ? current : [...current, removed],
              )
            )
              setRemoved(null)
          }}
        >
          {t(`復原「${removed.name}」`, `Restore “${removed.name}”`)}
        </button>
      )}
      <div className="alpha-profile-list">
        {profiles.map((profile) => {
          const sum = STRATEGY_IDS.reduce((total, id) => total + profile.weights[id], 0)
          return (
            <article key={profile.id}>
              <strong>{profile.name}</strong>
              <p>
                {STRATEGY_IDS.map(
                  (id) => `${names[id]} ${num((profile.weights[id] / sum) * 100, 0)}%`,
                ).join(' · ')}
                <br />
                {t('Alpha 門檻', 'Alpha Threshold')} {profile.threshold} · {profile.minMatches}{' '}
                {t('項策略', 'matches')}
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setPrevious({ ...configuration, weights: { ...configuration.weights } })
                    onLoad({
                      weights: { ...profile.weights },
                      threshold: profile.threshold,
                      minMatches: profile.minMatches,
                    })
                    setMessage(
                      t(
                        '已載入編輯區，尚未套用到首頁。',
                        'Loaded into the editor; not applied to the homepage.',
                      ),
                    )
                  }}
                >
                  {t('載入編輯區', 'Load into Editor')}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={async () => {
                    if (await change((current) => current.filter((p) => p.id !== profile.id)))
                      setRemoved(profile)
                  }}
                >
                  {t('移除', 'Remove')}
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </details>
  )
}
