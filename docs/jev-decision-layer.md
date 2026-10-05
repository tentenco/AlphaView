# Jev 決策閘（TypeSafe System One）

版本：`alphaview-jev-decision-v1`，問題集 `alphaview-jev-questions-v1`，釘選模型 `jev-1.13.0`。2026-09-30 使用者授權將 TypeSafe 的 Jev 模型接入 AlphaView，作為 Agent 投資組合工作區的**決策閘**：對已保存的規則工作流入選標的，以固定結果的問題取得校準機率，再由本機程式依版本化門檻決定哪些標的可以進入紙上提案。入口 `#agent-portfolio` → 選擇帳戶 → **Jev 決策閘**。

這不是實盤交易、不是新的行情來源、也不會產生文字。Jev 只回傳機率；所有數字事實、門檻、配置與帳本仍由 AlphaView 程式擁有。

## 概念來源與對應

整合的概念來自一份「opus-5.5 + jev / trading_bot.xml」提示：思考型模型負責**一次性**的策略設計與回測，System One 模型負責**持續發生**的判斷（讀取市場狀態、回傳每個固定結果的機率），交易所只負責執行；規則先寫進 `strategy.md`、每條規則改寫成固定結果問題、所有機率都過門檻才觸發、先 paper 再 live、風險規則（部位上限、日損上限、kill switch、金額以上人工核准）優先，並在上線前回答「什麼會炸掉這個帳戶」。

| 提示的五個階段 | AlphaView 對應 | 狀態 |
| --- | --- | --- |
| 01 STRATEGY：設計與回測規則書 | 四策略（`alphaview-scan-v1`）、回測（`alphaview-backtest-v5`）、規則工作流 `alphaview-portfolio-agent-v1` 的排序與固定席位 | 既有 |
| 02 QUESTIONS：規則變成固定結果問題 | `jev_decision.QUESTIONS`，版本 `alphaview-jev-questions-v1`；問題與門檻集中在一個檔案供檢閱 | 本輪新增 |
| 03 JEV：資料進、機率出 | 一次 `POST https://api.typesafe.ai/v1/systemone`，狀態為程式分桶後的技術事實 | 本輪新增 |
| 04 SIGNAL：門檻與風險限制 | 本機閘門（每個門檻機率都要過）＋既有紙上帳戶限制（單檔上限、最低現金、換手、允許標的、暫停開關） | 本輪新增閘門；限制既有 |
| 05 EXECUTE：paper 先、live 後 | 紙上預覽／提案／明確接受（`alphaview-paper-portfolio-v2`） | 只有 paper；本專案不做實盤 |

提示中**沒有**採用的部分：Vercel／VPS／Mac Mini 24/7 部署、Telegram 推播、實盤下單、對新聞標題發問（本專案沒有新聞來源）、日損上限與金額以上人工核准（見「可接續的功能」）。本機排程與「所有帳戶待辦」仍是唯一的提醒面。

## 使用流程

1. 在 **Jev 決策閘** 貼上 TypeSafe API Key（`apikey_` 開頭），按「驗證並保存金鑰」。後端先呼叫 `GET /v1/models` 驗證，再原子寫入本機檔案。
2. 先在 **Agent 工作流** 保存一個當期有效、已提出、最多 10 個入選標的的規則工作流（可帶帳戶允許標的政策）。
3. 檢閱固定問題與門檻：通過門檻（預設 0.70，範圍 0.50–0.99）與過度延伸風險上限（預設 0.50，範圍 0.01–0.50）。門檻隨每次決策紀錄保存。
4. 選擇來源工作流，按「執行 Jev 決策閘」。這是一次付費外部呼叫；回傳延遲、token 與估算費用會顯示並保存。
5. 檢閱逐標的機率、閘門結果、原配置→目標；通過的標的保留原規則席位，未通過或不可用的歸零並保留現金。
6. 「預覽紙上配置」交給紙上帳戶獨立驗算，「保存紙上提案」後仍要在**配置與提案**明確接受才會更新模擬帳本。
7. 之後可按「查看後續走勢」，看每個標的自決策日以來的調整收盤變動；這是量測，不是回測，也不是閘門可靠性的證明。

## 送出的狀態與固定問題

狀態只包含來源選股快照（`scans.result`）中每個入選標的的技術欄位，全部在程式內轉成英文命名的區間，再附上四捨五入的數值：

| 欄位 | 內容 |
| --- | --- |
| `trend_structure` | 收盤與 MA50／MA200 的相對位置（多頭排列、僅在 MA200 之上、在 MA200 之下…） |
| `close_vs_ma50`、`close_vs_ma200` | 收盤相對均線的百分比 |
| `breakout_20d` | 是否高於前 20 日高點 |
| `distance_from_120d_high` | 距 120 日高點 2% 內／10% 內／超過 10% |
| `volume` | 量比分為 very heavy（≥2×）、heavy（≥1.2×）、normal（≥0.8×）、light |
| `rsi_14` | 超買（>70）、強勢（55–70）、中性、回檔區（30–45）、超賣（<30） |
| `momentum_120d` | 120 日報酬分為強勁上漲（≥30%）、上漲（≥10%）、持平、下跌 |
| `relative_strength` | 股票池 RPS 前 20%／上半／下半；不足 3 檔則標示未排名 |
| `strategy_signals` | 四策略 matched／not matched／unavailable |

必要指標（close、ma50、ma200、high20、high120、volume_ratio、rsi、return120）任一缺失或非有限數值，該標的不建立問題，閘門結果為 `unavailable` 並列出缺少的欄位；不用其他標的或舊值補。狀態**不含**持股股數、成本、筆記、公司名稱、帳戶識別或任何外部文字。代碼含 `.`／`-` 會轉成 `_` 作為狀態鍵；轉換後衝突會在送出前拒絕。

每個標的四個問題（英文，問題 ID 為 `<代碼>:<問題>`）：

| 問題 | 型別 | 閘門 |
| --- | --- | --- |
| `uptrend_intact`：是否處於完整的中長期上升趨勢 | noul | 機率 ≥ 通過門檻 |
| `buying_pressure`：買盤是否增強（上漲由高於均量的成交量確認） | noul | 機率 ≥ 通過門檻 |
| `overextended`：是否過度延伸（超買、急漲後回檔風險高） | noul | 機率 ≤ 風險上限 |
| `setup_quality`：技術面多頭設定有多完整（Weak／Mixed／Constructive／Strong） | score | 僅供參考，不參與閘門 |

問題文字、criteria 與型別隨 `QUESTION_SET_VERSION` 固定。改動任何問題或門檻語意必須升版，舊決策會標示 `question_set_changed`，不能再接續提案。

## 閘門語意

- 每個標的必須**全部**門檻問題通過，才是 `pass`；任一未過為 `fail`；任一答案缺失、型別錯誤、非有限或指標不完整為 `unavailable`。
- `pass` 保留原規則席位權重；`fail`／`unavailable` 目標為 0，釋出的權重保留為現金，**不重新分配**給其他標的。
- 沒有任何標的通過時，決策為 `blocked`（`no_passing_candidates`），不會產生清倉提案。
- 回應模型不是釘選版本、答案數量與問題不一致、或任何答案無效時，整次決策為 `blocked`（`answers_invalid`），保留原始答案供檢閱但不提供目標。
- 評估期間來源工作流、行情 revision、交易日或方法改變，結果保存為 `stale`，不可接續。
- 相同 `idempotency_key` 與相同內容回傳同一筆紀錄，不重複付費呼叫；相同 key 不同內容回 409。
- 紙上提案綁定 `jev_source: {run_id, engine_version}`；目標與已驗證結果不符、來源過期、或同時附加其他 Agent 來源都會被拒絕。此版**不支援**把 Jev 來源提案排入次日開盤佇列（會明確 409）。

## 連線與金鑰

設定存放於 `data/panel.jev.json`，權限 `0600`、Git 忽略，不進 SQLite 或備份。`PANEL_DB_PATH` 改變時，設定跟隨該資料庫位置；伺服器可用 `ALPHAVIEW_JEV_CREDENTIALS_PATH` 指定另一個本機路徑，不接受瀏覽器指定路徑。檔案非一般檔、權限過寬、擁有者不同或內容無效時，連線讀取回 503 且不回送任何金鑰。

「移除本機金鑰」只刪除本機檔案，不撤銷 TypeSafe 金鑰；撤銷或重建請到 `console.typesafe.ai/keys`。曾貼在對話、截圖或文件中的金鑰應視為已外洩並重建。金鑰不得出現在文件、測試、commit、報告或記憶檔；測試一律使用合成金鑰與 mocked 傳輸。

外部傳輸固定到 `https://api.typesafe.ai`，只允許 `GET /v1/models` 與 `POST /v1/systemone`；停用代理與 netrc 繼承、不跟隨重新導向、連線／讀取逾時 4／20 秒、回應上限 1 MB、拒絕非有限 JSON。429／529 只重試一次；401／403 回 `authentication_failed`；網路例外不回送任何例外文字。

## 費用、延遲與後續量測

每次決策保存 `latency_ms`、`usage.input_tokens`／`output_tokens` 與 `estimated_cost_usd = input_tokens × 0.042 / 1,000,000`。價格依據是 2026-09-30 的 TypeSafe 公開價目（每百萬輸入 token $0.042，輸出 token 免費）；這是估算，不是帳單。歷史清單另提供列出範圍內的平均延遲、平均輸入 token、每次估算費用與合計。

`GET /api/jev/runs/{id}/outcomes` 用本機 `bars.adj_close` 計算每個標的自決策日到最新可用已完成交易日的變動，並列出經過的交易日數；沒有後續日線、決策日收盤缺失或最新收盤無效時保持不可用。它沒有基準、成本、部位大小或紙上帳本，不是回測；閘門是否可靠需要累積多次決策後另行評估。

## API

| 端點 | 功能 |
| --- | --- |
| `GET /api/jev/connection` | 本機連線狀態、釘選模型、能力；不呼叫 TypeSafe，不回送金鑰 |
| `POST /api/jev/connection` | `{api_key, expected_version}`；驗證後原子保存；第一次版本為 null |
| `DELETE /api/jev/connection` | 以 `expected_version` 核對後移除本機檔案 |
| `GET /api/jev/questions` | 版本化問題集、預設門檻、狀態欄位、方法與限制（離線） |
| `POST /api/jev/runs` | `{source_run_id, policy?, idempotency_key}`；一次評估並保存，回 201 |
| `GET /api/jev/runs?limit=20`、`GET /api/jev/runs/{id}` | 歷史與完整紀錄（狀態、問題、答案、閘門、費用） |
| `GET /api/jev/runs/{id}/outcomes` | 決策後的調整收盤變動量測 |
| `POST /api/jev/runs/{id}/paper-preview`、`/paper-proposal` | `{account_id, expected_account_version[, idempotency_key]}`；綁定 `jev_source` |

所有讀取端點共用 SQLite 一致快照，回傳 `engine_version`、`as_of`、`input_revision`；決策寫入不改變行情 `input_revision`。錯誤以 `{code, message}` 回傳，前端有對應英文說明。

## 這不是什麼，以及什麼會炸掉這個帳戶

- **不是報酬預測。** 機率是模型對「描述中的設定是否符合問題」的校準判斷；它與規則引擎讀同一份指標，不帶來新資訊，價值在於把多個因子合成一個可門檻化的判斷，而這個價值必須由後續量測證明。
- **不是實盤。** 沒有券商下單、Alpaca 仍為唯讀；紙上模擬價不等於可成交價。
- **不是市場風險或流動性模型。** 閘門不知道總經、事件、盤中路徑或成交量衝擊。
- **Jev 的已知邊界**（依官方 jaggedness 文件）：字面理解問題、不擅長數字精度與日期比較、大量無關內容會降低準確度、對抗性文字可能左右答案、英文以外語言準確度較低。本版因此只送英文命名的區間、不送自由文字、每題只問一件事。
- **版本漂移。** `jev-latest` 別名會隨新版移動；本版釘選 `jev-1.13.0`，回應版本不同即受阻。升級模型或改問題都必須升版並重新校準門檻。
- **門檻是假設。** 預設 0.70／0.50 只是保守起點，沒有在本專案資料上驗證；調高或調低都會改變通過率，需要用 outcomes 與 paper 紀錄觀察。
- **速率與可用性。** TypeSafe 公告速率限制會動態調整；429／529、逾時或無效回應都不會產生可接續配置。
- **金鑰。** 外洩的金鑰可被他人消耗額度；本機檔案權限、不入 Git 與不貼到對話是唯一防線。
- **會炸掉紙上帳戶的情境**：把 `pass` 當成買進指令而略過紙上限制；反覆調門檻直到歷史全部通過（過度擬合）；在指標過期或快照不一致時仍執行（本版會拒絕，但升版時要保留這些檢查）；把 outcomes 的短期漲跌當作閘門正確的證據。

## 已接續（2026-10-01）

- 自動化任務可啟用 `jev_gate`，在規則工作流之後、提案之前自動執行一次決策並以證據綁定提案；見 `docs/agent-portfolio.md`。
- 日損上限、最大回撤與當日成交筆數的自動暫停由 `docs/circuit-breakers.md` 提供；「金額以上需人工核准」以執行層的每筆金額上限與逐筆確認實作（`docs/execution.md`）。

## 可接續的功能

- Jev 來源提案的次日開盤歷史授權（`validate_historical_source` 對應版）。
- 以累積的決策與 outcomes 做校準表（各機率區間的後續勝率），再決定門檻。
- 市場風險溫度計區間作為狀態的市場脈絡欄位。

## 官方依據

- [API reference](https://docs.typesafe.ai/api)：端點、請求／回應結構、錯誤碼。
- [Models](https://docs.typesafe.ai/models)：`jev-1.13.0`、別名、價格、速率限制、上下文長度。
- [Confidence](https://docs.typesafe.ai/confidence)、[Noul](https://docs.typesafe.ai/primitives/noul)：門檻與三段式路由的建議。
- [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)：已知失敗模式。
- [Legal](https://docs.typesafe.ai/legal)：資料處理與不用客戶資料訓練的說明。

實作為 `alphaview/panel/jev_decision.py`，前端 `web/src/PortfolioJevGate.tsx`／`jev-model.ts`，測試 `tests/test_jev_decision.py` 與 `web/src/PortfolioJevGate.test.tsx` 全部使用合成資料、隔離 `PANEL_DB_PATH` 與 mocked 傳輸，不呼叫實際 TypeSafe、不讀取真實帳戶。
