# 本地備份預檢：只驗證，不還原

`check_backup.py` 檢查由 AlphaView 匯出的 ZIP 是否完整，並辨識已知資料庫 schema。它不提供上傳端點、不連網、不開啟目前工作區資料庫，也不把備份 SQL、持股、筆記或瀏覽器設定套用到應用程式。

## 使用

在專案根目錄、已安裝 web 依賴的 Python 3.12 環境執行：

```sh
uv run --extra web python scripts/check_backup.py /path/to/alphaview-backup.zip \
  --seconds 120 --output /path/to/new-preflight-report.json
```

不指定 `--output` 時將摘要輸出到終端機；指定的報告檔案若已存在會拒絕覆寫。輸入 ZIP 維持原樣。CLI 結束碼 0 表示預檢通過，1 表示未通過或未完成；參數錯誤使用 argparse 的結束碼 2。

`--seconds` 可設 1–180 秒，包含子程序啟動與檢查時間；預設 120 秒。父程序強制終止逾時 worker，回收子程序並清理暫存檔。`--stop-marker` 預設為專案根目錄的 `STOP`；可指定本輪 Harness 的檔案：

```sh
uv run --extra web python scripts/check_backup.py /path/to/alphaview-backup.zip \
  --stop-marker artifacts/harness-2026-09-05/STOP
```

STOP 在開始前存在則不啟動 worker；執行途中出現則在下一次父程序檢查時停止。檢查使用獨立私有暫存目錄，目錄權限 0700、檔案 0600；失敗、STOP、逾時及正常完成都清理。此工具沒有執行實際還原的選項。

## 判讀結果

- `valid: true`、`integrity: passed`：檔案內容、Manifest、SQLite 完整性及支援格式的交叉核對通過。
- `compatibility: current`：符合目前已登錄的精確 schema，包括 revision 單例資料表與 21 個合法計數 trigger。
- `compatibility: migration_required`：辨識為本輪早期九表版本（可信 commit `dd82732`，尚無排程／revision）或 revision 功能加入前的 v2 schema，需要另行遷移；本工具不執行遷移。
- `authenticity: not_authenticated`：檔案雜湊只能檢查與 Manifest 一致，不能證明誰建立備份。有人若同時修改內容和 Manifest，單靠 SHA-256 不構成來源認證。
- `restored: false`：沒有修改工作區。摘要提供日期、程式／引擎版本、資料表筆數、瀏覽器篩選設定數，以及執行中作業／排程狀態，不輸出持股代碼、成本或筆記內容。早期備份若沒有排程資料表，`schedule_enabled_in_snapshot` 回傳 null（未知／不存在），不當成已停用。

未知 schema 回傳 `unsupported_schema`，意思是需要相容性審查，不是宣稱檔案必定損壞。較新或客製 schema 不會因版本字串相同就自動獲准。`schema_user_version` 只用於核對 Manifest，目前不能單獨代表相容性。

通過預檢也不代表每筆行情或回測內容在財務上正確；舊引擎結果仍可能需要重算。若將來新增還原流程，必須另行處理執行中作業、啟用的排程、備份使用權及瀏覽器設定，不應直接恢復自動執行。

## 支援格式與資源上限

僅接受 format version 1，且恰有四個根目錄檔案：

| 檔案 | 最大解壓大小 |
| --- | ---: |
| `alphaview.db` | 1 GiB |
| `research-notes.json` | 10 MiB |
| `browser-settings.json` | 100 KiB |
| `manifest.json` | 1 MiB |

ZIP 本身最多 512 MiB、中央目錄最多 64 KiB；總解壓量不超過上述四項總和，單檔壓縮比不超過 2,000。筆記資料另限制最多 10,000 筆及 10 MiB 文字內容。這些是本工具支援上限，超限不等於備份損壞；較大備份需另安排資源充足的離線檢查。

拒絕重複／額外／缺少檔案、路徑穿越、絕對路徑、NUL 名稱、符號連結、特殊檔案、目錄、加密、多卷、ZIP64 及非標準壓縮格式。只支援 STORED 與 DEFLATED，不使用 `extractall`。先拒絕 ZIP64 locator 並確認中央目錄與結尾位置一致，避免解壓程式採用另一份較大的目錄長度；再檢查宣告大小，逐塊計算實際解壓位元組數、CRC 與 SHA-256，防止僅相信 ZIP metadata。

SQLite 只接受獨立 rollback-journal 備份檔；不接受依賴 WAL sidecar 的資料庫。以 `mode=ro&immutable=1` 開啟私有副本，設定 `query_only`、`trusted_schema=OFF`、停用 mmap、SQL 資源限制及進度逾時。先比對精確可信 schema 指紋，再查詢已知資料表；不執行上傳的 view、trigger 或 schema SQL。合法 revision trigger 只是已知 schema 的一部分，本工具沒有寫入操作去觸發它們。

Manifest 的檔案長度／SHA、schema SHA、版本與筆數都與實際內容比對；筆記 JSON 須和同份資料庫完全一致，瀏覽器設定使用既有 allowlist 驗證。JSON 拒絕重複欄位、NaN、Infinity、數字溢位及無效 UTF-8。

[SQLite 處理不可信資料庫建議](https://www.sqlite.org/security.html) · [Python ZIP 解壓注意事項](https://docs.python.org/3/library/zipfile.html#decompression-pitfalls)

## 開發與驗收

純函式入口是 `alphaview.panel.backup_preflight.check_backup(path, ...)`；直接呼叫具有協作式 SQL／串流期限。需要強制終止保障時應使用 CLI 的隔離 worker。

測試只建立合成持股與筆記的隔離備份，不使用實際使用者備份：

```sh
uv run --extra web --extra dev pytest -q tests/test_backup_preflight.py
```

涵蓋目前／舊 schema、雜湊／筆記／筆數不一致、惡意路徑與重複／連結／NUL 名稱、未知 view、損壞 SQLite、CRC、宣告與實際解壓限制、JSON 錯誤、私有權限、原始資料不變、CLI 報告不覆寫、STOP、逾時終止與暫存清理。
