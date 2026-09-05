export function ScanProvenanceNotice({
  status,
  busy = false,
  onRecalculate,
}: {
  status?: 'current' | 'stale' | 'unknown'
  busy?: boolean
  onRecalculate?: () => void
}) {
  if (!status || status === 'current') return null
  return (
    <div className="notice" role="status">
      <div>
        <strong>
          {status === 'stale'
            ? '資料或選股規則已變更，這份選股需要重算。'
            : '這份舊選股缺少完整版本紀錄，請重新計算。'}
        </strong>
        <p>下方保留原快照供檢閱，不能視為依目前行情重算的訊號。重新計算會使用目前已儲存的日線。</p>
        {onRecalculate ? (
          <button type="button" className="button" disabled={busy} onClick={onRecalculate}>
            以目前資料重算
          </button>
        ) : (
          <p>請前往每日選股，核對股票池後重新計算。</p>
        )}
      </div>
    </div>
  )
}
