import { useState } from 'react'
import type { Locale } from './locale'
import type { Position } from './types'
import { validPriceRules, type PriceRule } from './alpha-model'
import { money } from './ui'

export function PriceAlertEditor({
  rules,
  positions,
  locale,
  onChange,
}: {
  rules: PriceRule[]
  positions: Position[]
  locale: Locale
  onChange: (rules: PriceRule[]) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const holdings = positions.filter((position) => position.shares > 0)
  const [symbol, setSymbol] = useState(holdings[0]?.symbol || '')
  const [below, setBelow] = useState('')
  const [above, setAbove] = useState('')
  const [message, setMessage] = useState('')
  const active = holdings.find((position) => position.symbol === symbol)
  const proposed = {
    symbol,
    below: below.trim() ? Number(below) : null,
    above: above.trim() ? Number(above) : null,
  }
  const valid =
    !!active &&
    validPriceRules([proposed]) &&
    (rules.some((rule) => rule.symbol === symbol) || rules.length < 100)
  function edit(rule: PriceRule) {
    setSymbol(rule.symbol)
    setBelow(rule.below == null ? '' : String(rule.below))
    setAbove(rule.above == null ? '' : String(rule.above))
    setMessage('')
  }
  return (
    <details className="alpha-price-alerts">
      <summary>
        {t('個別持倉價格提醒', 'Per-Holding Price Alerts')} <span>{rules.length}</span>
      </summary>
      <p className="footnote">
        {t(
          '用自己設定的 USD 收盤價門檻提醒複查。只檢查目前實際持倉的有效當期未調整收盤價；不是盤中觸價或自動停損。拆股後需自行檢查門檻。新增後仍要按下方套用設定。',
          'Set your own USD closing-price thresholds for review. Checks valid current unadjusted closes of existing holdings only; not intraday touches or automatic stop orders. Review thresholds after splits. Apply settings below after adding a rule.',
        )}
      </p>
      {holdings.length > 0 && (
        <>
          <div className="alpha-basket-inputs">
            <label>
              {t('持倉', 'Holding')}
              <select
                value={symbol}
                onChange={(event) => {
                  setSymbol(event.target.value)
                  setBelow('')
                  setAbove('')
                }}
              >
                {!active && <option value={symbol}>{symbol || '—'}</option>}
                {holdings.map((position) => (
                  <option key={position.symbol} value={position.symbol}>
                    {position.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('收盤低於或等於 USD', 'Close At or Below USD')}
              <input
                type="number"
                min="0.0001"
                max="100000000"
                step="any"
                value={below}
                onChange={(event) => setBelow(event.target.value)}
                placeholder={t('選填', 'Optional')}
              />
            </label>
            <label>
              {t('收盤高於或等於 USD', 'Close At or Above USD')}
              <input
                type="number"
                min="0.0001"
                max="100000000"
                step="any"
                value={above}
                onChange={(event) => setAbove(event.target.value)}
                placeholder={t('選填', 'Optional')}
              />
            </label>
          </div>
          {active && (
            <p className="footnote">
              {t('目前顯示收盤', 'Displayed Close')} {money(active.price)} ·{' '}
              {active.price_date || '—'}{' '}
              {active.quote_status !== 'ok' && active.quote_status !== 'partial'
                ? t('（先確認報價狀態）', '(check quote status)')
                : ''}
            </p>
          )}
          <button
            type="button"
            className="button"
            disabled={!valid}
            onClick={() => {
              onChange([...rules.filter((rule) => rule.symbol !== symbol), proposed])
              setMessage(
                t(
                  '已加入設定草稿，請套用後啟用。',
                  'Added to the settings draft. Apply settings to enable.',
                ),
              )
            }}
          >
            {rules.some((rule) => rule.symbol === symbol)
              ? t('更新此持倉門檻', 'Update Holding Thresholds')
              : t('加入價格門檻', 'Add Price Thresholds')}
          </button>
          {below && above && Number(below) >= Number(above) && (
            <p className="footnote">
              {t('下限必須小於上限。', 'The lower threshold must be below the upper threshold.')}
            </p>
          )}
        </>
      )}
      {message && (
        <p className="footnote" role="status">
          {message}
        </p>
      )}
      <div className="alpha-price-rule-list">
        {rules.map((rule) => (
          <article key={rule.symbol}>
            <div>
              <strong>{rule.symbol}</strong>
              <span>
                {rule.below !== null ? `≤ ${money(rule.below)}` : ''}
                {rule.below !== null && rule.above !== null ? ' · ' : ''}
                {rule.above !== null ? `≥ ${money(rule.above)}` : ''}
              </span>
              {!holdings.some((position) => position.symbol === rule.symbol) && (
                <small>{t('未持有，暫不檢查', 'Not held; inactive')}</small>
              )}
            </div>
            <div className="actions">
              <button
                type="button"
                className="text-button"
                disabled={!holdings.some((position) => position.symbol === rule.symbol)}
                onClick={() => edit(rule)}
              >
                {t('編輯', 'Edit')}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => onChange(rules.filter((item) => item.symbol !== rule.symbol))}
              >
                {t('移除門檻', 'Remove Thresholds')}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!holdings.length && (
        <p className="footnote">
          {t(
            '有實際持倉後即可設定個別價格提醒。',
            'Add an actual holding to configure a per-holding price alert.',
          )}
        </p>
      )}
    </details>
  )
}
