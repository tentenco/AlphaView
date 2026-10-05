# 本機模型分析與紙上提案

`alphaview-local-agent-v1` 會把已保存、仍有效的規則工作流交給已安裝的本機 Ollama 模型。模型在**一次推論中提供三種角色觀點**：研究分析、配置檢閱與風險檢閱。介面中的三種觀點來自同一個模型回應，不是三個獨立模型的共識。

模型可選擇有證據支持的判斷，以及保留、減半或排除既有配置。行情、共識分數、配置上限與目標權重皆由程式提供或計算。模型不能新增標的、自由輸入數字、下載資料或呼叫交易工具。原有 `alphaview-portfolio-agent-v1` 仍是獨立的可重現規則引擎，不會被改稱為 LLM 分析。

## 使用流程

1. 在 Agent 組合頁保存一個有效的規則工作流。來源必須使用最新已完成交易日、相符的行情 revision 與掃描方法；至少一個、最多十個已選定標的，每個必要啟用策略都有完整資料。
2. 確認本機 Ollama 已停用雲端，選擇介面列出的已安裝模型。應用只會讀取模型狀態，不會替你安裝、下載或啟動模型服務。
3. 選擇「分析」或「保守配置」並啟動。分析模式必須保留全部原配置；保守配置可將每個既有固定配置保留、減半或設為零，釋出的權重留在現金，不重新分配。
4. 檢閱三種觀點、引用的事實、逐檔決策與程式驗證結果。全部設為零、模型放棄、缺少角色或標的、無效引用、結構不符都會阻擋接續提案。
5. 保存後可按「驗證保存證據」，離線重驗保存的規則、事實、引用、指紋與程式目標。模型原始文字預設不放入畫面，需按「顯示模型原始文字」才以跳脫後的純文字檢閱。
6. 使用紙上預覽查看完整虛擬組合的訂單與限制。建立紙上提案仍不會成交；後續必須在既有 paper 介面明確接受。接受時會重驗分析來源、帳戶版本、當期行情、風險限制、執行政策與暫停開關。

紙上目標是完整組合目標，因此原紙上持倉若未在規則目標中，可能在預覽中出現賣出。請以完整紙上預覽為準；模型的逐檔減半限制不是既有帳戶交易量的上限。

## 本機 Ollama 設定

應用固定連到 `http://127.0.0.1:11434`，使用標準 HTTP 連線，不讀取代理環境設定，不跟隨 redirect。它只使用 `/api/status`、`/api/version`、`/api/tags`、`/api/show`、`/api/chat`，沒有 pull、遠端 URL、API key、工具執行或付費 provider 設定。

在沒有其他 Ollama 服務占用該連接埠時，可於獨立終端啟動本機服務：

```sh
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NO_CLOUD=1 ollama serve
```

此命令只為該程序設定環境，不修改全域設定。若已有服務，先確認它的啟動設定與擁有者；應用不會自行停止其他程序。Ollama 官方文件說明 `OLLAMA_NO_CLOUD=1` 可停用雲端功能。[Ollama FAQ](https://docs.ollama.com/faq)

此版要求 `/api/status` 能明確回傳 `cloud.disabled: true`；舊版不提供這個實驗性欄位時，模型清單會顯示不可用與原因，不猜測雲端已關閉。端點定義可查官方程式的 `CloudStatusExperimental`。[官方客戶端原始碼](https://github.com/ollama/ollama/blob/main/api/client.go)

模型必須精確存在於本機清單、具有有效 digest 與大小、為 GGUF completion 模型，且名稱及 metadata 不含 cloud 或 remote model/host。模型 metadata 在推論前後都會重驗；內容改變時結果標成 stale。模型清單會顯示排除的模型與原因，不會自動選用雲端別名。

## 結構化結果與證據

推論使用 JSON Schema `format`、`stream: false`、`think: false`，以及固定選項 `temperature: 0`、`seed: 42`、`num_ctx: 8192`、`num_predict: 2048`。這些設定限制輸出格式，但仍需要程式驗證；固定 seed 也不宣稱跨硬體或模型版本完全重現。[Chat API](https://docs.ollama.com/api/chat)、[Structured outputs](https://docs.ollama.com/capabilities/structured-outputs)

模型輸出的每個 finding 包含固定判斷碼與事實 ID。例如 `complete_evidence` 必須引用覆蓋率為 100 的事實；`mixed_signals` 必須引用符合數小於啟用策略數的共識事實。配置決策必須引用該標的自己的分數或固定配置，必要時再引用現金限制、缺少預測的限制。介面的說明文字由程式依代碼產生，不把自由生成的數字當作行情。

每次分析保存來源工作流 ID、scan ID、as_of、input revision、原配置、完整事實、模型名稱與 digest、模型 metadata digest、prompt/schema digest、prompt 版本、推論選項、原始結構化結果、引用驗證與有限的執行統計。模型的 thinking 內容不保存。傳送的內容只包含規則候選與配置證據，不傳送私人持股股數、成本或研究筆記。

這一版是受限制的本機模型檢閱，不是未來報酬、波動、相關性或交易成功率預測。合法引用只能證明判斷使用了提供的證據，不能證明模型的保守選擇比原規則更有投資價值。模型若輸出不合契約的內容，結果保留為 blocked，不改用靜默預設目標。

## 作業與恢復

啟動回傳 HTTP 202 與已保存的 run。介面輪詢真實階段：來源核對、一次本機推論、輸出驗證、完成。每個工作區用獨立檔案鎖限制同時一個本機分析；SQL 的唯一 idempotency key 防止同請求重複保存。相同 key 與相同輸入會取回原作業；相同 key 改內容會得到 409。

推論上限 120 秒，metadata 每次查詢上限 3 秒，輸入與回應另有大小限制。推論等待期間不持有 DB transaction，行情更新仍可進行；如果來源交易日、revision 或方法改變，完成結果會標成 stale，不能建立紙上提案。

取消會先保存 `cancel_requested`。正在等待的本機 HTTP 推論可能繼續到回應或逾時，之後程式捨棄可用目標；介面不會把「提出取消」誤報為「已取消完成」。這個動作不取消或更改任何紙上提案。

程序中斷後，啟動時僅在能取得工作區分析鎖時，把遺留 queued/running 作業標為 interrupted；不自動重跑模型。歷史結果仍可檢閱。若要重試 interrupted、blocked 或 failed 結果，請明確建立新請求。

## API 與開發

- `GET /api/local-agent/models`：本機服務與已安裝模型。
- `POST /api/local-agent/runs`：`{source_run_id, model, mode, idempotency_key}`。
- `GET /api/local-agent/runs`、`GET /api/local-agent/runs/{id}`：歷史與完整紀錄。
- `GET /api/local-agent/runs/{id}/integrity`：按需產生只讀保存證據回條，不執行模型、不寫回分析。
- `POST /api/local-agent/runs/{id}/cancel`：保存取消要求。
- `POST /api/local-agent/runs/{id}/paper-preview`：`{account_id, expected_account_version}`。
- `POST /api/local-agent/runs/{id}/paper-proposal`：上述欄位加 `idempotency_key`。

OpenAPI 位於本機 `/docs` 與 `/openapi.json`。紙上提案附帶 `local_agent_source: {analysis_id, engine_version}`；直接修改該提案的 targets 或同時附加 automation_source 都會被拒絕。這一版沒有本機模型 auto-accept，也不將本機模型接入每日 auto_simulate 任務。

實作為 `alphaview/panel/local_agent.py`，測試 `tests/test_local_agent.py` 全部使用合成資料、隔離 `PANEL_DB_PATH` 與 mocked 本機模型回應，不啟動真實模型、不讀取私人帳戶。

內部函式 `validate_historical_source(db, source, expected_fingerprint=...)` 提供次日開盤紙上佇列使用的獨立授權檢查，方法 `alphaview-local-agent-historical-authorization-v1`。佇列建立時仍須先通過當期 `validate_source`，再凍結歷史授權指紋；之後重驗完整規則紀錄、分析來源、事實、prompt/schema 指紋、模型結構化輸出與目標，不因單純新增後續交易日而失效。這個 helper 不驗證行情歷史前綴或紙上帳戶狀態，必須由佇列另外檢查；它沒有放寬一般預覽、提案或手動接受的來源條件。


## 保存證據驗證

`alphaview-local-agent-integrity-v1` 使用一致的讀取快照，依序核對分析方法、規則資料列與完整指紋、來源摘要、由規則重建的事實、分析請求指紋、prompt/schema 指紋、原始輸出的嚴格結構與引用、輸出指紋、重新計算的觀點／決策／目標，以及完成與取消狀態。它與 `validate_source`、`validate_historical_source` 共用同一份重建證明；當期預覽、建立提案與來源重驗不再只信任保存的 `proposal_ready` 或 `validation.valid` 旗標。

回條包含每項檢查的 `passed`／`failed`／`unavailable`、確切原因代碼、已知／未知／重複引用計數，以及具有已知且不重複引用的判斷覆蓋率。結構或事實不足以計數時，覆蓋率保留不可用，介面顯示 `—`。引用覆蓋率不是判斷正確率；支持條件仍由獨立的輸出驗證檢查。回條不包含原始模型文字，結構錯誤只提供代碼，避免透過錯誤訊息自動揭露原始輸出。

`verified` 表示保存的歷史證據可重建且內部一致；`source_currentness` 另外說明來源是否仍符合當期條件。新增後續交易日或帳戶標的政策改變，可以使歷史證據仍然通過、但 `proposal_eligible` 為 false。紙上預覽與建立提案仍要求當期來源，且需要原有帳戶版本、風險限制與政策檢查。完整證據回條不會自動建立或接受提案。

缺少原始輸出、缺少必要證據、無法解析的保存欄位或沒有相容驗證器的舊版本，會留下明確的不可用原因；不補值、不重跑模型、不改寫或升級舊分析。保存的來源、事實、輸出或目標與重建結果不一致時，回條失敗，提案來源以 409 拒絕。既有合法輸出的計算與 `alphaview-local-agent-v1` 契約不變；成功的歷史授權 v1 payload 與 fingerprint 維持相容。

這不是數位簽章或外部事實查核：如果有人同時重寫所有本機證據與其指紋，單靠這些保存資料無法證明原始內容。離線重驗也不證明實際使用的模型身分、模型品質、未來報酬或實盤安全。它不呼叫 Ollama、券商或付費服務；原有模型清單與明確啟動分析仍使用既有本機模型流程。

合成驗證涵蓋 `tests/test_local_agent_integrity.py`：只讀性與 revision／筆數不變、歷史授權相容、有效提案路徑、引用／數字欄位／raw／目標／事實／指紋篡改、過期來源及舊證據不可用。介面測試檢查按需載入、回條身分、帳戶切換中止、歷史選擇隔離與原始文字跳脫。
