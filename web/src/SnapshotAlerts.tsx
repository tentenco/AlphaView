import type { RiskAlert, RiskKind } from './alpha-model'
import type { Locale } from './locale'
import { num } from './ui'
const names: Record<RiskKind, [string, string]> = {
  concentration: ['持倉集中度', 'Position Concentration'],
  daily_drop: ['單日跌幅', 'Daily Decline'],
  below_ma200: ['低於 MA200', 'Below MA200'],
  below_ma50: ['低於 MA50', 'Below MA50'],
  overbought: ['RSI 高檔', 'Elevated RSI'],
  data_gap: ['報價待更新', 'Quotes Need Updating'],
  signal_gap: ['訊號待更新', 'Signals Need Updating'],
  price_below: ['自訂收盤下限', 'Custom Closing-Price Floor'],
  price_above: ['自訂收盤上限', 'Custom Closing-Price Ceiling'],
}
function validAlert(value: unknown): value is RiskAlert {
  if (!value || typeof value !== 'object') return false
  const r = value as RiskAlert
  return (
    typeof r.id === 'string' &&
    typeof r.symbol === 'string' &&
    /^[A-Z][A-Z0-9.-]{0,9}$/.test(r.symbol) &&
    Object.hasOwn(names, r.kind) &&
    ['high', 'medium', 'data'].includes(r.severity) &&
    (r.date === null || (typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date))) &&
    [r.value, r.threshold].every((v) => v === null || (typeof v === 'number' && Number.isFinite(v)))
  )
}
export function SnapshotAlerts({ alerts, locale }: { alerts: unknown[]; locale: Locale }) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const valid = alerts.filter(validAlert)
  const format = (value: number | null, kind: RiskKind) =>
    value === null
      ? '—'
      : kind.startsWith('price_')
        ? `USD ${num(value)}`
        : `${num(value)}${kind === 'overbought' ? ' RSI' : kind.endsWith('_gap') ? '' : '%'}`
  return (
    <section className="alpha-snapshot-alerts">
      <h4>
        {t('保存時的持倉提醒', 'Holding Alerts at Save Time')} · {valid.length}
      </h4>
      <p className="footnote">
        {t(
          '以下條件與數值來自保存時刻，不代表目前仍成立。提醒消失也可能來自持倉、門檻或資料變更。',
          'These conditions and values belong to the saved snapshot, not the current session. A missing alert can also reflect changes in holdings, thresholds, or data.',
        )}
      </p>
      {alerts.length > valid.length && (
        <p role="status">
          {t(
            `${alerts.length - valid.length} 筆歷史提醒格式無法讀取。`,
            `${alerts.length - valid.length} historical alerts have an unreadable format.`,
          )}
        </p>
      )}
      {!alerts.length ? (
        <p>{t('保存時沒有觸發提醒。', 'No alerts were triggered at save time.')}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  t('代碼', 'Symbol'),
                  t('提醒條件', 'Condition'),
                  t('嚴重度', 'Severity'),
                  t('當時數值', 'Saved Value'),
                  t('門檻', 'Threshold'),
                  t('資料日', 'Data Session'),
                ].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {valid.map((alert, index) => (
                <tr key={`${alert.id}:${index}`}>
                  <td>
                    <strong>{alert.symbol}</strong>
                  </td>
                  <td>{names[alert.kind][locale === 'en' ? 1 : 0]}</td>
                  <td>
                    {alert.severity === 'high'
                      ? t('高', 'High')
                      : alert.severity === 'medium'
                        ? t('中', 'Medium')
                        : t('資料', 'Data')}
                  </td>
                  <td>{format(alert.value, alert.kind)}</td>
                  <td>{format(alert.threshold, alert.kind)}</td>
                  <td>{alert.date || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
