import { useState } from 'react'
import type { Overview } from './types'
import type { Locale } from './locale'
import { money, num } from './ui'
import { positionScenario } from './scenario-model'

export function PositionScenario({
  data,
  locale,
  symbol,
  onClose,
}: {
  data: Overview
  locale: Locale
  symbol: string
  onClose: () => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const position = data.positions.find((item) => item.symbol === symbol)
  // Execution prices are deliberately user-entered: research closes are adjusted.
  const [price, setPrice] = useState(position?.price?.toString() || '')
  const [capital, setCapital] = useState('10000')
  const [decline, setDecline] = useState('10')
  const result = positionScenario(data, {
    symbol,
    capital: Number(capital),
    price: Number(price),
    decline: Number(decline),
  })
  return (
    <section className="alpha-scenario" aria-label={t('持倉情境試算', 'Position scenario')}>
      <div className="section-heading">
        <div>
          <div className="eyebrow">POSITION SANDBOX</div>
          <h2>
            {symbol} · {t('持倉情境試算', 'Position Scenario')}
          </h2>
        </div>
        <button className="text-button" onClick={onClose}>
          {t('關閉試算', 'Close Scenario')}
        </button>
      </div>
      <p>
        {t(
          '假設以額外資金買入整股，並只對這檔股票套用下跌情境。調整數字即可查看對目前股票持倉的影響。',
          'Model a whole-share purchase funded with additional capital, then apply a price decline to this symbol alone. Adjust the inputs to see the impact on your current stock holdings.',
        )}
      </p>
      <div className="alpha-thresholds">
        <label>
          {t('新增資金 USD', 'Additional capital USD')}
          <input
            type="number"
            min={0}
            max={1e12}
            value={capital}
            onChange={(e) => setCapital(e.target.value)}
          />
        </label>
        <label>
          {t('假設成交價 USD', 'Assumed execution price USD')}
          <input
            type="number"
            min={0.01}
            step="any"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label>
          {t('該股下跌情境 %', 'Symbol decline scenario %')}
          <input
            type="number"
            min={0}
            max={100}
            value={decline}
            onChange={(e) => setDecline(e.target.value)}
          />
        </label>
      </div>
      {result ? (
        <>
          <div className="alpha-stats">
            <div>
              <small>{t('可購入整股', 'Whole shares to add')}</small>
              <strong>{num(result.shares, 0)}</strong>
              <p>
                {t('投入', 'Invested')} {money(result.invested)} · {t('未使用', 'Unused')}{' '}
                {money(result.unused)}
              </p>
            </div>
            <div>
              <small>{t('該股集中度', 'Symbol concentration')}</small>
              <strong>
                {num(result.afterWeight, 1)}
                <span>%</span>
              </strong>
              <p>
                {t('原本', 'Before')} {num(result.beforeWeight, 1)}%
              </p>
            </div>
            <div>
              <small>{t('假設損失金額', 'Hypothetical loss')}</small>
              <strong>{money(result.loss)}</strong>
              <p>{t('包含這檔原有持倉與新增部位', 'Includes existing and added exposure')}</p>
            </div>
            <div>
              <small>{t('股票持倉總額影響', 'Total stock holdings impact')}</small>
              <strong>
                −{num(result.impact, 2)}
                <span>%</span>
              </strong>
              <p>
                {t('情境後股票市值', 'Stock value after scenario')} {money(result.afterShock)}
              </p>
            </div>
          </div>
          <p className="footnote">
            {t(
              '分母為目前可確認的股票市值＋新增買入金額；未使用資金與帳戶現金不計入。未包含手續費、稅、滑價或其他股票同步波動。只做算術情境，不會建立委託或修改持倉。',
              'The denominator is current stock value plus the added purchase; unused funds and account cash are excluded. Fees, taxes, slippage, and moves in other symbols are excluded. This is arithmetic only: no orders or holding changes.',
            )}
          </p>
        </>
      ) : (
        <p className="notice">
          {t(
            '請填入有效的資金、成交價與跌幅；目前所有持倉也需要同交易日的有效報價才能試算。',
            'Enter valid capital, execution price, and decline. All existing holdings also need valid quotes for the expected trading session.',
          )}
        </p>
      )}
    </section>
  )
}
