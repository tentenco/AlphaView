import { useState } from 'react'
import { ArrowRight } from '@carbon/icons-react'
import type { Locale } from './locale'
import type { Overview, Scope } from './types'
import {
  readAlphaSettings,
  STRATEGY_IDS,
  WEIGHT_PRESETS,
  validAlphaSettings,
  ALPHA_SETTINGS_KEY,
} from './alpha-model'
import { notifyAlphaPreferences } from './alpha-preferences'
import { AlphaReplay } from './AlphaReplay'
import { AlphaBasket } from './AlphaBasket'
import { num } from './ui'
import { WeightProfiles } from './WeightProfiles'
import { WeightComparison } from './WeightComparison'
import { isAlphaEditingSettings, useSessionState } from './session-state'

export function AlphaLab({
  data,
  locale,
  onOpen,
  onDashboard,
}: {
  data: Overview
  locale: Locale
  onOpen: (symbol: string, scope: Scope, date: string) => void
  onDashboard: () => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [scope, setScope] = useSessionState<Scope>(
    'alphaview-lab-scope-v1',
    () => 'market',
    (value): value is Scope => value === 'market' || value === 'portfolio',
  )
  const [settings, setSettings] = useSessionState(
    'alphaview-lab-settings-v1',
    readAlphaSettings,
    isAlphaEditingSettings,
  )
  const [view, setView] = useSessionState(
    'alphaview-lab-view-v1',
    () => 'basket',
    (value): value is string => value === 'basket' || value === 'replay' || value === 'profiles',
  )
  const [message, setMessage] = useState('')
  const valid = validAlphaSettings(settings)
  function applyToDashboard() {
    if (!valid) return
    try {
      const current = readAlphaSettings()
      localStorage.setItem(
        ALPHA_SETTINGS_KEY,
        JSON.stringify({
          ...current,
          weights: settings.weights,
          threshold: settings.threshold,
          minMatches: settings.minMatches,
        }),
      )
      notifyAlphaPreferences()
      setMessage(
        t('已將這組權重套用到 Alpha Picks。', 'These weights are now applied to Alpha Picks.'),
      )
    } catch {
      setMessage(
        t(
          '無法保存首頁權重；實驗設定仍可使用。',
          'Could not save homepage weights; your experiment settings remain available.',
        ),
      )
    }
  }
  const names = {
    turtle: t('海龜突破', 'Turtle'),
    trend: t('均線趨勢', 'Trend'),
    pullback: t('回檔觀察', 'Pullback'),
    rps: t('相對強勢', 'Relative Strength'),
  }
  const total = STRATEGY_IDS.reduce((sum, id) => sum + settings.weights[id], 0)
  return (
    <div className="alpha-workspace alpha-lab" translate="no">
      <div className="page-title">
        <div>
          <div className="eyebrow">ALPHA RESEARCH LAB</div>
          <h1>{t('Alpha 實驗室', 'Alpha Lab')}</h1>
          <p>
            {t(
              '回看訊號，再檢驗配置。理解權重在不同交易日的表現。',
              'Replay the signals. Examine the allocation. Understand how your weights behave across sessions.',
            )}
          </p>
        </div>
        <button className="button" onClick={onDashboard}>
          {t('回到 Alpha Picks', 'Back to Alpha Picks')}
          <ArrowRight size={15} />
        </button>
      </div>
      <div className="alpha-lab-settings">
        {STRATEGY_IDS.map((id, index) => (
          <span key={id}>
            <i style={{ background: `var(--series-${index})` }} />
            {names[id]} <b>{num(total > 0 ? (settings.weights[id] / total) * 100 : 0, 0)}%</b>
          </span>
        ))}
        <span>
          {t('Alpha 門檻', 'Alpha Threshold')} {settings.threshold} · {settings.minMatches}{' '}
          {t('項策略', 'strategies')}
        </span>
      </div>
      <details className="alpha-lab-weight-editor">
        <summary>{t('調整實驗權重', 'Adjust Experiment Weights')}</summary>
        <p className="footnote">
          {t(
            '這裡的設定只用於實驗；按「套用到 Alpha Picks」才會更新首頁。',
            'These settings apply to experiments only. The homepage changes only when you apply them to Alpha Picks.',
          )}
        </p>
        <div className="actions">
          {Object.entries(WEIGHT_PRESETS).map(([id, weights]) => (
            <button
              className="button"
              key={id}
              onClick={() => setSettings({ ...settings, weights: { ...weights } })}
            >
              {id === 'balanced'
                ? t('均衡', 'Balanced')
                : id === 'momentum'
                  ? t('動能', 'Momentum')
                  : t('回檔', 'Pullback')}
            </button>
          ))}
        </div>
        <WeightProfiles
          configuration={{
            weights: settings.weights,
            threshold: settings.threshold,
            minMatches: settings.minMatches,
          }}
          locale={locale}
          onLoad={(configuration) => setSettings({ ...settings, ...configuration })}
        />
        <div className="alpha-basket-inputs">
          {STRATEGY_IDS.map((id) => (
            <label key={id}>
              {names[id]}
              <input
                type="number"
                min={0}
                max={100}
                value={settings.weights[id]}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    weights: { ...settings.weights, [id]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
          <label>
            {t('Alpha 分數門檻', 'Alpha Score Threshold')}
            <input
              type="number"
              min={1}
              max={100}
              value={settings.threshold}
              onChange={(e) => setSettings({ ...settings, threshold: Number(e.target.value) })}
            />
          </label>
          <label>
            {t('至少符合策略數', 'Minimum Matches')}
            <input
              type="number"
              min={1}
              max={4}
              value={settings.minMatches}
              onChange={(e) => setSettings({ ...settings, minMatches: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="actions">
          <button className="button" disabled={!valid} onClick={applyToDashboard}>
            {t('套用到 Alpha Picks', 'Apply to Alpha Picks')}
          </button>
          <button className="text-button" onClick={() => setSettings(readAlphaSettings())}>
            {t('重新讀取首頁權重', 'Reload Homepage Weights')}
          </button>
        </div>
      </details>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <div className="alpha-context">
        <div className="tabs">
          <button className={view === 'basket' ? 'active' : ''} onClick={() => setView('basket')}>
            {t('組合實驗', 'Basket Experiment')}
          </button>
          <button className={view === 'replay' ? 'active' : ''} onClick={() => setView('replay')}>
            {t('訊號回放', 'Signal Replay')}
          </button>
          <button
            className={view === 'profiles' ? 'active' : ''}
            onClick={() => setView('profiles')}
          >
            {t('權重方案比較', 'Weight Comparison')}
          </button>
        </div>
        <select
          aria-label={t('實驗範圍', 'Experiment scope')}
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
        >
          <option value="market">{t('市場探索', 'Market Discovery')}</option>
          <option value="portfolio">{t('我的清單', 'My List')}</option>
        </select>
      </div>
      {valid &&
        STRATEGY_IDS.filter((id) => settings.weights[id] > 0).length < settings.minMatches && (
          <p role="status" className="notice">
            {t(
              '啟用策略數少於最低符合數，這組設定不會產生 Alpha Pick。請降低最低符合數，或提高其他策略權重。',
              'Fewer strategies are enabled than the minimum match count, so these settings produce no Alpha Picks. Lower the minimum or enable more strategy weights.',
            )}
          </p>
        )}
      {!valid && (
        <p role="alert" className="notice">
          {t(
            '請修正權重與門檻，權重合計須大於零。',
            'Correct the weights and thresholds; total weight must be above zero.',
          )}
        </p>
      )}
      <div hidden={view !== 'profiles'}>
        <WeightComparison
          data={data}
          scope={scope}
          locale={locale}
          onOpen={onOpen}
          onLoad={(configuration) => setSettings({ ...settings, ...configuration })}
        />
      </div>
      <div hidden={view !== 'basket'}>
        <AlphaBasket
          data={data}
          scope={scope}
          settings={settings}
          locale={locale}
          onOpen={onOpen}
          onRestoreSettings={(saved) => {
            setScope(saved.scope)
            setSettings({
              ...settings,
              weights: saved.weights,
              threshold: saved.threshold,
              minMatches: saved.min_matches,
            })
          }}
        />
      </div>
      <div hidden={view !== 'replay'}>
        <AlphaReplay
          data={data}
          scope={scope}
          settings={settings}
          locale={locale}
          onOpen={onOpen}
          open
        />
      </div>
    </div>
  )
}
