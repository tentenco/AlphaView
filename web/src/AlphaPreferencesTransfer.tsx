import { useRef, useState } from 'react'
import { Download, Upload } from '@carbon/icons-react'
import type { Locale } from './locale'
import {
  applyResearchPreferences,
  captureResearchPreferences,
  capturedStorage,
  parseResearchPreferences,
  type ResearchPreferences,
} from './alpha-transfer'
import { notifyAlphaPreferences } from './alpha-preferences'

export function AlphaPreferencesTransfer({ locale }: { locale: Locale }) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [preview, setPreview] = useState<{
    data: ResearchPreferences
    before: ResearchPreferences
    storage: Record<string, string | null>
  } | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const sequence = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  function failure(err: unknown) {
    const code = (err as Error).message
    setError(
      code === 'changed_since_preview'
        ? t(
            '研究設定在預覽後已變更，請重新選取檔案預覽。',
            'Research preferences changed after preview. Select the file again to review current changes.',
          )
        : code === 'rollback_failed'
          ? t(
              '套用失敗，而且無法完整恢復原設定。請保留備份檔並重新開啟此頁檢查。',
              'Apply failed and the original preferences could not be fully restored. Keep your backup and reopen this page to inspect the state.',
            )
          : code === 'storage_unavailable'
            ? t(
                '瀏覽器無法保存匯入資料，已恢復原設定。',
                'Browser storage could not save the import; original settings were restored.',
              )
            : t(
                '無法讀取有效的 Alpha 研究備份。請使用此區匯出的 JSON，檔案上限 8 MB。',
                'Unable to read a valid Alpha research backup. Use JSON exported from this section, up to 8 MB.',
              ),
    )
  }
  function download() {
    setError('')
    setMessage('')
    try {
      const data = captureResearchPreferences()
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      )
      const link = document.createElement('a')
      link.href = url
      link.download = `alphaview-research-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage(t('Alpha 研究備份已下載。', 'Alpha research backup downloaded.'))
    } catch (err) {
      failure(err)
    }
  }
  async function read(file: File | undefined) {
    const current = ++sequence.current
    setPreview(null)
    setError('')
    setMessage('')
    if (!file) return
    setReading(true)
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('file_too_large')
      const data = parseResearchPreferences(await file.text())
      if (current !== sequence.current) return
      setPreview({ data, before: captureResearchPreferences(), storage: capturedStorage() })
    } catch (err) {
      if (current === sequence.current) failure(err)
    } finally {
      if (current === sequence.current) setReading(false)
      if (input.current) input.current.value = ''
    }
  }
  function apply() {
    if (!preview) return
    try {
      applyResearchPreferences(preview.data, preview.storage)
      notifyAlphaPreferences()
      setPreview(null)
      setMessage(
        t(
          '已套用 Alpha 研究資料。重新開啟 Alpha Picks 即可使用；實驗室保留分頁中的設定，可按「重新讀取首頁權重」更新。',
          'Alpha research data applied. Reopen Alpha Picks to use it. Alpha Lab preserves this tab’s experiment settings; use Reload Homepage Weights to update them.',
        ),
      )
    } catch (err) {
      failure(err)
    }
  }
  return (
    <section className="alpha-preferences-transfer" translate="no">
      <div className="section-heading">
        <div>
          <h2>{t('Alpha 研究資料搬家', 'Move Your Alpha Research')}</h2>
          <p>
            {t(
              '備份權重與命名方案、研究清單與進度、比較組合、已檢閱提醒、每日快照與實驗摘要。',
              'Back up weights and named profiles, shortlist and progress, comparison groups, reviewed alerts, daily snapshots, and experiment summaries.',
            )}
          </p>
        </div>
        <div className="actions">
          <button type="button" className="button" onClick={download}>
            <Download size={16} />
            {t('匯出研究備份', 'Export Research Backup')}
          </button>
          <button
            type="button"
            className="button"
            disabled={reading}
            onClick={() => input.current?.click()}
          >
            <Upload size={16} />
            {t('選擇備份預覽', 'Choose Backup to Preview')}
          </button>
          <input
            ref={input}
            type="file"
            name="alpha-research-backup"
            accept=".json,application/json"
            hidden
            onChange={(event) => void read(event.target.files?.[0])}
          />
        </div>
      </div>
      <p className="footnote">
        {t(
          '這份 JSON 只包含瀏覽器內的 Alpha 研究資料。行情、持倉和筆記請使用上方的工作區 ZIP 備份。預覽不會修改資料；套用時會取代這九類 Alpha 設定。較舊備份沒有研究進度、比較組合或權重方案時，會清空對應資料。',
          'This JSON contains browser-side Alpha research only. Use the workspace ZIP backup above for quotes, holdings, and notes. Preview changes nothing; applying replaces these nine Alpha preference categories. Older backups without progress, comparison groups, or weight profiles will clear those categories.',
        )}
      </p>
      {reading && <p role="status">{t('正在讀取研究備份…', 'Reading research backup…')}</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message} <a href="#alpha">Alpha Picks →</a>
        </p>
      )}
      {preview && (
        <div className="alpha-transfer-preview">
          <h3>{t('即將取代的研究資料', 'Research Data to Replace')}</h3>
          <p>
            {t('檔案匯出時間', 'Backup exported')} {preview.data.exportedAt}
          </p>
          <div>
            {(
              [
                'shortlist',
                'reviewed',
                'snapshots',
                'experiments',
                'tracking',
                'comparisons',
                'profiles',
              ] as const
            ).map((key, index) => (
              <p key={key}>
                {
                  [
                    t('研究清單', 'Shortlist'),
                    t('已檢閱提醒', 'Reviewed Alerts'),
                    t('每日快照', 'Daily Snapshots'),
                    t('實驗摘要', 'Experiments'),
                    t('研究進度', 'Research Progress'),
                    t('比較組合', 'Comparison Groups'),
                    t('權重方案', 'Weight Profiles'),
                  ][index]
                }{' '}
                <b>
                  {preview.before[key].length} → {preview.data[key].length}
                </b>
              </p>
            ))}
          </div>
          <div className="alpha-table-scroll">
            <table className="alpha-transfer-settings">
              <caption>{t('研究與提醒設定的變更', 'Research and Alert Setting Changes')}</caption>
              <thead>
                <tr>
                  <th>{t('設定', 'Setting')}</th>
                  <th>{t('目前', 'Current')}</th>
                  <th>{t('匯入後', 'After Import')}</th>
                </tr>
              </thead>
              <tbody>
                {(['turtle', 'trend', 'pullback', 'rps'] as const).map((id, index) => (
                  <tr key={id}>
                    <td>
                      {
                        [
                          t('海龜權重', 'Turtle Weight'),
                          t('趨勢權重', 'Trend Weight'),
                          t('回檔權重', 'Pullback Weight'),
                          'RPS ' + t('權重', 'Weight'),
                        ][index]
                      }
                    </td>
                    <td>{preview.before.settings.weights[id]}</td>
                    <td>{preview.data.settings.weights[id]}</td>
                  </tr>
                ))}
                {(
                  ['threshold', 'minMatches', 'concentration', 'dailyDrop', 'overbought'] as const
                ).map((id, index) => (
                  <tr key={id}>
                    <td>
                      {
                        [
                          t('Alpha 分數門檻', 'Alpha Score Threshold'),
                          t('最低符合策略數', 'Minimum Matches'),
                          t('集中度提醒 %', 'Concentration Alert %'),
                          t('單日跌幅提醒 %', 'Daily Decline Alert %'),
                          t('RSI 提醒', 'RSI Alert'),
                        ][index]
                      }
                    </td>
                    <td>{preview.before.settings[id]}</td>
                    <td>{preview.data.settings[id]}</td>
                  </tr>
                ))}
                <tr>
                  <td>{t('個別持倉價格門檻數', 'Per-Holding Price Rules')}</td>
                  <td>{preview.before.settings.priceRules?.length || 0}</td>
                  <td>{preview.data.settings.priceRules?.length || 0}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {!!preview.data.settings.priceRules?.length && (
            <details>
              <summary>{t('查看匯入的價格門檻', 'Inspect Imported Price Rules')}</summary>
              {preview.data.settings.priceRules.map((rule) => (
                <p key={rule.symbol}>
                  {rule.symbol} · {rule.below !== null ? `≤ USD ${rule.below}` : ''}{' '}
                  {rule.above !== null ? `≥ USD ${rule.above}` : ''}
                </p>
              ))}
            </details>
          )}
          <div className="actions">
            <button type="button" className="button primary" onClick={apply}>
              {t('套用 Alpha 研究資料', 'Apply Alpha Research Data')}
            </button>
            <button type="button" className="button" onClick={() => setPreview(null)}>
              {t('取消匯入', 'Cancel Import')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
