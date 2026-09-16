import { useEffect, useState } from 'react'
import { Bookmark, Save } from '@carbon/icons-react'
import type { Locale } from './locale'
import type { ComparisonResult } from './Comparison'
import {
  addComparisonBookmark,
  COMPARISON_BOOKMARKS_KEY,
  readComparisonBookmarks,
  validComparisonSetup,
  type ComparisonBookmark,
  type ComparisonSetup,
} from './comparison-bookmarks'

export function ComparisonBookmarks({
  draft,
  result,
  locale,
  busy,
  members,
  onLoad,
}: {
  draft: ComparisonSetup
  result: ComparisonResult | null
  locale: Locale
  busy: boolean
  members: string[]
  onLoad: (setup: ComparisonSetup) => void
}) {
  const t = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [bookmarks, setBookmarks] = useState(readComparisonBookmarks)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [writing, setWriting] = useState(false)
  const [previous, setPrevious] = useState<ComparisonSetup | null>(null)
  const [removed, setRemoved] = useState<ComparisonBookmark | null>(null)
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === COMPARISON_BOOKMARKS_KEY || event.key === null)
        setBookmarks(readComparisonBookmarks())
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [])
  async function mutate(action: () => ComparisonBookmark[]) {
    if (writing) return false
    setWriting(true)
    try {
      const next = navigator.locks?.request
        ? await navigator.locks.request('alphaview-comparison-bookmarks', action)
        : action()
      setBookmarks(next)
      return true
    } catch (err) {
      setMessage(
        (err as Error).message === 'bookmark_limit'
          ? t('最多 20 組，請先刪除一組。', 'The limit is 20 groups. Remove one first.')
          : t(
              '無法儲存比較組合，請檢查瀏覽器儲存空間。',
              'Could not save comparison groups. Check browser storage.',
            ),
      )
      return false
    } finally {
      setWriting(false)
    }
  }
  async function save(source: 'draft' | 'result') {
    if (busy || writing || !name.trim()) return
    const setup =
      source === 'result' && result
        ? { symbols: result.series.map((row) => row.symbol), window: result.window }
        : draft
    if (!validComparisonSetup(setup) || (source === 'result' && !result)) return
    const item: ComparisonBookmark = {
      ...setup,
      id: crypto.randomUUID(),
      name: name.trim(),
      savedAt: new Date().toISOString(),
      source:
        source === 'result' && result
          ? {
              inputRevision: result.input_revision,
              engine: result.comparison_engine_version,
              asOf: result.as_of,
              start: result.anchor_date,
              end: result.end_date,
            }
          : null,
    }
    if (await mutate(() => addComparisonBookmark(item))) {
      setName('')
      setMessage(
        t(
          `已保存「${item.name}」的${source === 'result' ? '已計算結果設定' : '目前選擇'}。`,
          `Saved “${item.name}” from ${source === 'result' ? 'the calculated result settings' : 'your current selection'}.`,
        ),
      )
    }
  }
  function load(item: ComparisonSetup) {
    setPrevious({ ...draft, symbols: [...draft.symbols] })
    onLoad({ symbols: [...item.symbols], window: item.window })
    setMessage(
      t(
        '已載入設定。請按比較重新計算；先前的選擇可用下方按鈕恢復。',
        'Settings loaded. Press Compare to calculate again; you can restore the previous selection below.',
      ),
    )
  }
  return (
    <details className="comparison-bookmarks" translate="no">
      <summary>
        <Bookmark size={16} />
        {t('保存的比較組合', 'Saved Comparison Groups')} <span>{bookmarks.length} / 20</span>
      </summary>
      <p className="footnote">
        {t(
          '保存 2–5 檔與比較期間。只保存設定與來源摘要，重新開啟後需明確執行比較；不把舊結果當成目前績效。存於此瀏覽器，包含在 Alpha 研究備份。',
          'Save 2–5 tickers and the comparison window. Groups store settings and source context; explicitly run Compare after loading. Old results are not current performance. Saved in this browser and included in the Alpha research backup.',
        )}
      </p>
      <div className="actions">
        <label>
          {t('組合名稱', 'Group Name')}
          <input
            value={name}
            maxLength={60}
            disabled={writing}
            placeholder={t('例如：半導體候選', 'For example: Semiconductor candidates')}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={busy || writing || !name.trim() || !validComparisonSetup(draft)}
          onClick={() => void save('draft')}
        >
          <Save size={15} />
          {t('保存目前選擇', 'Save Current Selection')}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || writing || !name.trim() || !result}
          onClick={() => void save('result')}
        >
          {t('保存已計算結果的設定', 'Save Calculated Result Settings')}
        </button>
      </div>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {previous && (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => {
            onLoad(previous)
            setPrevious(null)
            setMessage(t('已恢復上一組選擇。', 'Previous selection restored.'))
          }}
        >
          {t('恢復載入前的選擇', 'Restore Previous Selection')}
        </button>
      )}
      {removed && (
        <button
          type="button"
          className="text-button"
          disabled={writing}
          onClick={async () => {
            if (await mutate(() => addComparisonBookmark(removed))) {
              setRemoved(null)
              setMessage(t('已復原比較組合。', 'Comparison group restored.'))
            }
          }}
        >
          {t(`復原刪除「${removed.name}」`, `Undo Removal of “${removed.name}”`)}
        </button>
      )}
      <div className="comparison-bookmark-list">
        {[...bookmarks].reverse().map((item) => {
          const missing = item.symbols.filter((symbol) => !members.includes(symbol))
          return (
            <article key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <small>
                  {item.symbols.join(' · ')} · {item.window} {t('交易日', 'sessions')}
                </small>
              </div>
              <p>
                {item.source
                  ? t(
                      `來源結果：${item.source.start} → ${item.source.end}；重開後需重新計算。`,
                      `Source result: ${item.source.start} → ${item.source.end}. Recalculate after loading.`,
                    )
                  : t(
                      '保存自選擇設定；沒有已計算结果。',
                      'Saved from selection settings; no calculated result attached.',
                    )}
              </p>
              {missing.length > 0 && (
                <p>
                  {t('已不在目前股票池：', 'No longer in the current universe: ')}
                  {missing.join(', ')}
                  {t('。載入後可移除或替換。', '. Remove or replace after loading.')}
                </p>
              )}
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy || writing}
                  onClick={() => load(item)}
                >
                  {t('載入設定', 'Load Settings')}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={writing}
                  onClick={async () => {
                    if (
                      await mutate(() => {
                        const next = readComparisonBookmarks().filter((row) => row.id !== item.id)
                        localStorage.setItem(COMPARISON_BOOKMARKS_KEY, JSON.stringify(next))
                        return next
                      })
                    ) {
                      setRemoved(item)
                      setMessage(
                        t(
                          `已移除「${item.name}」，可復原。`,
                          `Removed “${item.name}”. Undo is available.`,
                        ),
                      )
                    }
                  }}
                >
                  {t('移除', 'Remove')}
                </button>
              </div>
            </article>
          )
        })}
      </div>
      {!bookmarks.length && (
        <p className="footnote">
          {t(
            '選好標的並輸入名稱，就能保存第一組比較。',
            'Choose tickers and enter a name to save your first group.',
          )}
        </p>
      )}
    </details>
  )
}
