# 固定股票池歷史前綴回放：可行性與驗收契約

2026-09-29，R0 設計已審閱並完成純計算實作。**只有 `replay_prefix.evaluate_prefix` 與合成測試已交付；沒有 replay API、會計 runner、資料表或投資績效功能。** 下文 R1 介面、會計政策及效能上限仍是待審設計。

## 結論與最小交付

已有可接受顯式日期與資料框的指標／訊號核心，因此「用每個歷史日期之前的原始日線重新計算」可做小型隔離驗證。完整紙上回放仍缺少三個邊界：固定股票池的歷史輸入介面、不依賴最新工作區快照的配置核心、與現行 paper 帳戶完全分離的會計狀態。不能把現有每日掃描或 next-open 委託直接改一個日期便稱為歷史回放。

本輪完成的最小單位為 **R0：純計算歷史前綴證據**。交付顯式 raw DataFrame 前綴介面、逐日前綴與未來擾動測試、明確 coverage／缺口輸出；不建立帳戶、不寫 scans、不下委託、不輸出投資績效。R1 的固定股數、成本與每日 NAV 隔離帳本仍需另外審閱。

這個產品仍是「今天取得的固定股票池資料之歷史情境」。日期限制只限制程式讀取哪些日期；資料庫沒有保留每一筆日線當年可見的版本、觀測時間或歷史成分，不能因此宣稱真正 point-in-time、消除倖存者偏誤、完全無前視偏誤或可實際成交。

## 已核對的程式能力

| 現有入口 | 已有行為 | 可重用與限制 |
| --- | --- | --- |
| [`research.indicators(frame)`](../alphaview/panel/research.py) | 用 `adj_close / close` 調整 OHLC；均線／區間、前日 shift、Wilder RSI 皆在傳入 frame 上計算；保存原始日線品質資訊 | R0 應先切原始前綴再呼叫。RSI 從首 14 次變化初始化後遞迴，任意截成最後 200 筆會改變語意。 |
| [`research.evaluate(frames, as_of)`](../alphaview/panel/research.py) | 再切 `date <= as_of`；品質錯誤按日期過濾；RPS 僅使用該日具 121 筆且有效的同日同池標的，至少 3 檔 | 可作逐日訊號核心，輸入必須是明確固定池。未知日期的錯誤仍會阻擋，不能猜成「未來資料」後排除。 |
| [`market.history_quality(frame, as_of, check_sessions)`](../alphaview/panel/market.py) | 可按日期檢查；保留未知日期錯誤；檢查 OHLC、有限值、重複日期與首末觀測間的 XNYS 缺口 | 缺口不補值。它以首個觀測日為起點，不能證明上市日期或首個觀測日之前的完整性。 |
| [`research.scan(...)`](../alphaview/panel/research.py) | 讀目前 `store.universe(scope)`、完整 history、最新已完成日；只發布最近 60 個觀測日期；會寫 `scans`，並核對全庫 revision | 不用作 replay runner。它的目前股票池、全庫 token、60 日上限與寫入行為都不符合隔離歷史契約。 |
| [`portfolio_agent.preview`／`_source`／`_candidate`](../alphaview/panel/portfolio_agent.py) | 讀最新 scan、目前成分與最新完成日；核對 raw close；固定策略權重、固定配置席位，未用份額留現金 | 排序與席位規則可在後續抽成純核心；目前 public preview 不是任意歷史日期函式。不可透過修改全域時鐘、偽造 scan/current token 繞過它。 |
| [`scan_context.decorate`、`scan_provenance.current_token`](../alphaview/panel/scan_context.py) | 以目前股票池與全庫 input revision 判定 scan 是否 current | 不作歷史前綴身份。歷史 run 應有自己固定池／前綴 fingerprint，不能借用 current 標記。 |
| [`alpha_replay.replay`](../alphaview/panel/alpha_replay.py) | 讀已儲存 scans，回顧規則共識 | 不是回報／帳本回放，也沒有逐日重新生成指標。 |
| [`alpha_basket.basket`／`simulate`／`rebalance_at_open`](../alphaview/panel/alpha_basket.py) | 目前池已保存訊號、前日選股、次日調整開盤價、等權配置與調整單位 | 會按當日開盤價重新求目標份額；與本提案「前日 close 凍結股數、次日 raw open」不同，不直接共用會計核心。 |
| [`paper_next_open._window`／`enqueue`／`_prepare_process`](../alphaview/panel/paper_next_open.py) | 必須在指定未來交易日開盤前授權；指定日收盤後 15 分鐘才處理；來源歷史修訂即失效 | 這是現行未來授權帳本。不能以 replay 日期回填、繞過 cutoff 或製造舊授權。 |
| [`paper_next_open._prefix_digest`／`_open_quotes`／`_evaluate`](../alphaview/panel/paper_next_open.py) | 前綴與資料身份 fingerprint、精確指定日 raw open、固定股數重驗、風險與成本上限 | 是可參考的契約；函式仍依賴現行帳戶及資料庫，不能直接拿 replay 狀態假扮 paper account。完整日線品質與調整因子檢查也不是開盤當下可見資料。 |
| [`store.read_snapshot`／`snapshot_read`](../alphaview/panel/store.py) | 同一同步執行緒共用 SQLite query-only 快照；worker 不繼承此快照 | 捕捉前綴資料時可重用；不能把 live connection 傳給 worker。應先完成有上限的不可變輸入捕捉，再交純計算。 |
| [`sessions.latest_completed_session`／`calendar`／`expected_sessions`](../alphaview/panel/sessions.py) | XNYS、收盤後 15 分鐘、時區／假日／提早收盤 | capture 時只用一次實際時鐘決定資料上限；回放迴圈顯式傳入歷史 session。日曆超出支援範圍應拒絕，不能換成平日。 |

已有局部因果性證據：[`test_future_prices_cannot_change_historical_indicators_or_signals`](../tests/test_indicator_audit.py) 檢查追加極端未來價格與一筆有日期的未來壞價不改變舊訊號；[`test_actual_signal_backtest_equity_prefix_is_causal`](../tests/test_research_metamorphic.py) 檢查三種單標的回測的前綴結果。這些不是新多標的 raw-open replay 的驗收，不能替代下面的測試矩陣。

## 固定輸入與時間口徑

### 已實作的 R0 Python 契約

[`evaluate_prefix(raw_by_symbol, as_of, *, identities)`](../alphaview/panel/replay_prefix.py) 接收呼叫端已凍結的明確 symbol→原始 DataFrame，以及完全相同符號集合的 identity map。每個 identity 必須恰有 `source`、`currency`、`exchange` 三欄，前兩欄是非空字串，exchange 可為 null。函式不替呼叫端捕捉資料、不查 store、不查目前股票池、不讀現在時間，也不接受配置策略、目標股數或帳戶。

日期使用嚴格 `YYYY-MM-DD` 字串 session label。`as_of` 必須是 1990–2100 年間的 XNYS 交易日；它不與實際現在時間比較。有日期且大於 `as_of` 的列，在價格轉換、品質驗證、指標及指紋之前移除。日期無法辨認的列留下並使該 symbol 不可用；date／datetime 物件也屬於未知日期，不會在 cutoff 之後才轉為有效 ISO 字串。輸入 attrs 與額外衍生欄位忽略；必要原始欄位是 `date/open/high/low/close/adj_close/volume`，缺欄保留明確 data_error。

R0 的 admission 上限為 1–50 檔、整個 capture 合計 500,000 列、每個純量字串至多 256 字元、整數至多 1024 bits；只接受可轉成 Python int／float 的 NumPy 數字、Python int／float、字串、日期或缺值，其他物件數值型別拒絕。超限／錯誤請求拋 `ValueError`。每檔被選中的可辨日期範圍最多跨六個年份差，符合既有 `sessions.calendar(last_year)` 的 `last_year - 6` 起點；超出支援範圍回該檔 unavailable，不截短暖機歷史。這些是保守 admission 界限，不是效能承諾。未來資料無影響的保證適用於通過 admission 的輸入；未來新增列導致總 capture 超限會明確拒絕。

回傳 `engine_version/schema_version/fingerprint_version/scan_engine_version`、XNYS 及日曆／pandas／numpy 套件版本、`as_of`、SHA-256 `fingerprint`、排序的 `symbols` 與 `coverage`。每檔保留 identity、首個觀測日、日線品質、現有四策略訊號、指標與 `missing_reasons`。品質 issues 最多呈現 20 個例子，完整 `invalid_count` 及 `issues_truncated` 保留。輸出可經 `json.dumps(..., allow_nan=False)`，不含 targets、orders、NAV 或績效。

Coverage 的 `requested` 是固定請求分母；`valid` 是非空且原始日線品質有效；`current` 再要求末日等於 `as_of`；`complete` 要求四策略皆為 match/watch。`rps_peers`／`rps_peer_symbols` 是當日有效、至少 121 筆且 RPS 必要指標有限的實際比較池，最低 3 檔另列，不能混同 requested。`strategies` 列每個策略的可用檔數。資料有效但暖機不足，不會算成 complete。

指紋包含方法版本／套件版本、`as_of`、固定 symbol 集合、identity 與每檔允許的原始前綴。列、欄、symbol 的輸入順序不影響結果；可精確表示的整數／浮點數按相同數值正規化，缺值／無限值另有明確標記，在 numeric／object dtype 下保留相同純量值就不會因 dtype 改變舊指紋。float64 會失去精度的整數保留完整十進位身份；數字字串保留原文，避免不同溢位字串或高精度數字修訂被浮點轉換吞掉，`astype(str)` 因而不屬於保留原始純量值的操作。這是前綴內容身份，不是完整 capture 身份，也不表示歷史資料真正 point-in-time；identity 是呼叫端的凍結聲明，並未驗證外部來源或交易所相容性。呼叫端在計算期間不得並行修改傳入資料。

### 待審的 R1 時間契約

建議 R1 請求包含 `symbols`、`first_signal_session`、`last_valuation_session`、`initial_cash_usd`、固定策略權重／候選門檻／席位上限、執行成本政策、風險上限及明確的 symbol policy。symbols 由使用者顯式提供並正規化、去重；不自動讀真實持股、目前成分或今日排名補池。若 UI 讓使用者複製今日池，來源說明必須保存為「今日選定固定池」。

R1 提議初版上限為 50 檔、252 個估值交易日、500,000 筆捕捉原始日線；超限回明確錯誤，不能截斷後繼續。252 日 runner 尚未實作及實測，不能將 R0 admission 當成整段回放效能保證。每檔包含所需全部已保存暖機前綴，記錄實際首日；不假裝有首次觀測之前的資料。完整初始帳本只有使用者指定的虛擬現金，沒有既有持股、成本或存提款。

`first_signal_session` 是首個收盤決策日，第一批假設執行日為其**下一個 XNYS session**。`last_valuation_session` 是最後一個收盤估值日。最後一個可執行訊號日為最後估值日的前一交易日；最後估值日新形成的訊號不再成交，也不做終點強制清倉。日期必須是有效 session，且最後估值日不晚於 capture 時的最新已完成日。

對每個決策日 `d`：

1. prefix evaluator 只收到固定池的、日期可辨且 `date <= d` 的原始 OHLCV／adj_close，以及已凍結的純規則。未知日期資料產生明確診斷，不會被分配到某一個歷史日。
2. 從原始前綴重新做品質檢查、指標、同日 RPS 與固定權重候選評分。RPS 的 valid-peer 分母必須輸出；無資料的固定池成員仍出現在 coverage，不偷偷從請求池刪掉。
3. 配置使用與規則 Agent 相同的固定席位語意；未填席位留現金，symbol policy 排除的既有排名席位不補位。所有啟用策略不完整的候選標示不可用，不重分配策略權重。
4. 在 `d` 的 raw close 估值、依已固定規則形成目標股數、捨入與最低交易額。股數在這一步凍結；`d+1` 的開盤價不能用來重新選股、調大／調小股數或重新分配權重。
5. 純執行核只接收已凍結委託、帳本狀態與指定下一 session 的 raw open，按固定費率及不利滑價整批重驗。它沒有再呼叫配置器的能力。風險／現金／費用上限未通過時記錄整批拒絕，帳本不變；不能自動縮單。
6. 以該日 raw close 計算收盤 NAV。日線內的其他價格不作成交價。收盤訊號與估值最多讀到當日；下一日以後資料不得進入這些函式的輸入。

這套迴圈是使用已完成日線的回顧情境。借用現有 `valid_bar` 或調整因子偵測時，資料品質 gate 會使用執行日完整日線，應另外保存其 `observed_through_session`，並明確標示「完成日線後驗證」。不能把這個 gate 宣稱為開盤當下已知資訊，也不能隱藏它造成的停止／拒絕。

## 缺口、公司行動與停止

建議 R0 逐日輸出所有資料不足與原因，不計算績效。R1 初版採保守的明確停止規則：固定池任一啟用策略所需資料不完整、既有持倉估值缺價、指定日必要 raw open 缺失或存在無法處理的公司行動疑慮，停止該 run 的帳本路徑，保留最後已驗證前綴。可以輸出後續每日的資料診斷，但不能沿用不確定持倉狀態繼續製造 NAV。

「完整資料但沒有符合門檻的候選」須有獨立 `no_eligible_candidates` 決策：保留原持倉與現金、沒有新委託；與現行 `portfolio_agent.preview` 不自動建立清空持倉提案的原則一致。不能把缺資料混同於此狀態。權重席位不補位的規則仍保留，方便未來在另立方法版本後評估容許局部資料覆蓋的 replay。

價格調整因子的變化只能作「疑似公司行動／需停止」證據，不等同可靠的拆股或股息事件來源。初版不自行調整股數、倒推股息、重設成本或選用其他日期成交。調整後訊號與 raw 會計並用的限制，必須隨 run 保存。本機歷史 adj_close 本身也可能已包含事後修訂與後續資訊。

`status` 提議為 `complete`、`incomplete`、`cancelled`、`failed`。只有每個要求交易日及必要來源都驗證完整時才是 complete。中斷保留 `last_completed_session`、已完成／要求的 session 計數、每檔覆蓋及停止理由；完整期間報酬、CAGR、Sharpe 等不輸出。若另展示已完成前綴的數字，欄位名稱和區間必須明確指向前綴，不能當作原要求期間的績效。

## 身份、方法與保存

建議分開保存 capture manifest 與每日決策 fingerprint。Manifest 含固定池、request、原始資料內容 hash、實際資料首末日、資料來源／幣別身份、capture 的 input revision／UTC 時间、日曆套件版本及所有計算版本。每日 fingerprint 只包含該日允許前綴、固定規則與先前已驗證帳本狀態；在 `d` 之後追加價格可能改變整個 capture ID，卻不得改變 `d` 的決策 fingerprint 或輸出。

R0 已實作 `alphaview-paper-replay-prefix-v1`、`alphaview-paper-replay-prefix-schema-v1` 與 `alphaview-paper-replay-prefix-sha256-v1`，並納入既有 scan 方法版本。R1 方法 `alphaview-paper-replay-v1`（訊號→固定股數→raw-open 會計）仍只是提議，尚未存在。R1 應保存既有 scan、Agent、paper 成本／symbol-policy 等實際方法版本；若抽出共用核心時改變既有語意，必須為受影響方法升版，不能覆寫舊值。

R0 先回傳純 JSON 與合成測試證據，不新增工作區表。後續若保存 replay，採獨立 `replay_id` 與僅含 replay 狀態的 artifact／獨立資料庫；不得寫現行 `paper_accounts`、`paper_proposals`、`paper_ledger`、`paper_nav_snapshots`、next-open queue 或 scans。重跑新資料建立新 ID，舊結果不可覆寫；如果輸入指紋不同，舊 plan 必須失效。

## 提議 API 與最小驗收

R0 為已實作 Python 純函式；以下 HTTP 介面仍是後續設計，不是可呼叫端點：

| 階段 | 提議介面 | 回傳與副作用 |
| --- | --- | --- |
| R0，已實作 | Python 純函式 `evaluate_prefix(raw_by_symbol, as_of, *, identities)` | 每檔訊號、quality、coverage、RPS 分母、前綴 fingerprint；沒有 DB 或網路存取。 |
| R1 前置 | `POST /api/paper-replay/plan` | 唯讀 capture／估算上限，回 request hash、manifest hash、方法版本、coverage、缺口與可行性；不計績效、不寫帳戶。 |
| R1 | `POST /api/paper-replay/runs`，帶 `expected_plan_fingerprint` | 重新核對 capture 一致才進獨立 replay；不沿用 current Agent run 或已授權 queue。 |
| R1 | `GET /api/paper-replay/runs/{replay_id}`、明確 cancel | 讀隔離結果；取消只停止本 run，保留已完成前綴，不能終止正式 scheduler。 |

[`tests/test_replay_prefix.py`](../tests/test_replay_prefix.py) 的合成案例驗收涵蓋：

- 至少三檔合成歷史，包含 RPS 同分、缺同日資料、暖機不足、四策略可用分母與不足 3 檔 peers。R0 沒有配置器或可調策略權重。
- 對每個 `d` 比較完整 capture 經 prefix loader 的結果與只含 `<= d` 的獨立資料集；再追加、刪除、極端修改所有有日期的 `> d` 日線，該日結果與每日 fingerprint 都不變。
- 修改 `<= d` 的價量或 identity 會改變對應指紋或產生具體拒絕；未知日期錯誤保持不可用，不能靜默丟棄。
- 調換輸入符號／資料列／欄順序及 pandas dtype 不改變排序及結果；RPS 分母只反映該日有效 peers，完整請求分母另列。原始 DataFrame 與 identity 未改動。
- 日期跨 DST、週末、假日、提早收盤及日曆支援邊界；R0 只接受顯式 session，不計算下一日成交。
- monkeypatch 禁止 store connection／history／universe／revision／clock、目前 session 查詢、scan 與下載；隔離 DB 路徑在計算後仍不存在。計算不進入 scheduler、模型或券商路徑；`json.dumps(..., allow_nan=False)` 成功。

R1 才增加啟用／停用策略、固定權重不重分配、無合格候選的配置行為、固定股數在訊號日凍結、下一個交易日（非日期加一天）價格不改變股數、缺價整批停止、費用／滑價／捨入／現金與成本一致、公司行動停止、最後一日不可再成交、STOP／時間上限、失敗不發布 complete，以及全專案五道驗收和主要 UI 路徑。

本輪另有一次隔離合成 benchmark：50 檔 × 1,759 個 XNYS session＝87,950 列，2020-01-02 至 2026-12-31。這是年份差 6、含首尾共七個曆年的完整觀測上限樣本，並非 500,000 列都可成為有效六年份差歷史。四個 cutoff（暖機、DST 後、提早收盤、最長前綴）共 20 個 phase 的完整 capture、獨立截斷／刪除未來、修改未來、追加未來及 object dtype 污染結果與指紋皆相同，且 JSON 有限、原始 frame digest 不變、未建立 DB。該次總耗時 34.006 秒、最慢 phase 3.272 秒；程序全程 peak RSS 250.859 MiB，是高水位而非單次增量。這是本機一次樣本，不是未實作的 252 日 runner 效能承諾。合成 runner 與逐 phase 證據在本輪 gitignored Harness artifacts 中。

## 尚待設計審閱的取捨

1. 接受 R1 初版嚴格的固定池資料完整性及遇缺口停止，或另立版本容許哪些局部覆蓋；目前建議嚴格停止。
2. 回放風險重驗的原始授權上限如何由固定政策表達；不可臨時按觀測到的次日結果放寬。
3. 是否一開始納入調倉偏離／間隔。建議先以明確固定頻率驗證會計核心，再另加已驗證的 trigger 方法，避免把兩組尚未證明的時序合併驗收。
4. 純 prefix 指標重算的計算成本、最大暖機行數與取消粒度；沒有測量前不承諾長期間效能。

本輪完成上述來源核對、R0 純前綴 evaluator 與合成因果性證據。沒有執行真實資料回放，也沒有改寫既有計算方法；R1 不在本輪實作授權內。
