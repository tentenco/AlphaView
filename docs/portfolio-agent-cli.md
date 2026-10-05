# 本機 Portfolio Agent JSON CLI

`scripts/portfolio_agent_cli.py` 讓外部本機 Agent 使用 AlphaView 已有的研究、候選池、紙上帳戶與自動化 API。只依賴 Python 標準函式庫，沒有模型 SDK、付費供應商或券商介面。所有資料操作經由 HTTP API；CLI 不直接讀寫工作區 SQLite、不啟動伺服器，也不自行保存輸出檔案。

先啟動本機 AlphaView，再執行：

```sh
python3 scripts/portfolio_agent_cli.py --help
python3 scripts/portfolio_agent_cli.py --pretty capabilities
python3 scripts/portfolio_agent_cli.py status
```

預設 API 為 `http://127.0.0.1:8876`。全域參數必須放在子命令之前，例如 `--base-url http://127.0.0.1:8876 --timeout 10 --pretty status`。只接受 HTTP loopback origin；拒絕外部主機、HTTPS、帳密、query、fragment 與額外路徑。`localhost` 直接轉成 `127.0.0.1`，不經 DNS；支援 `[::1]`。不使用 proxy 環境變數、不帶驗證資訊、不跟隨任何 redirect。

| 命令 | 作用 | 寫入 |
| --- | --- | --- |
| `capabilities` | 不連網，輸出工具 manifest、作用、readonly 屬性、OpenAPI schema URL | 無 |
| `status` | 工作區資料版本及狀態 | 無 |
| `accounts [--account-id ID]` | 紙上帳戶列表或單一帳戶完整快照 | 無 |
| `runs [--run-id ID]` | 已保存的 Agent run 列表或完整證據 | 無 |
| `candidates [--input FILE或-]` | 從已驗證的本機選股池挑選候選；省略輸入使用 selector 預設值 | 無 |
| `preview --input FILE或-` | 計算 deterministic 四角色 trace | 無 |
| `run --input FILE或-` | 預設與 preview 相同 | 無 |
| `run --save --input FILE或-` | 保存 immutable Agent run | 研究紀錄 |
| `proposal --account-id ID ...` | 保存紙上提案，等待檢閱；不接受提案 | 紙上提案 |
| `accept --paper --account-id ID ...` | 明確接受既有紙上提案 | 紙上模擬帳本 |
| `automation-state` | 任務設定、cadence、最近嘗試與等待原因 | 無 |
| `automation-state --mandate-id ID` | 一個任務的設定與當期 readiness | 無 |
| `automation-attempts --mandate-id ID [--limit N]` | 每日嘗試紀錄；limit 1–100 | 無 |
| `automation-create --input FILE或-` | 保存任務；省略設定時為 disabled、proposal_only | 任務設定 |
| `automation-update --mandate-id ID --expected-version N --input FILE或-` | 按目前版本更新 JSON 明確指定的設定 | 任務設定 |
| `automation-run --mandate-id ID --expected-version N` | 手動嘗試最新交易日一次，預設只建立提案 | 研究紀錄與紙上提案 |
| `automation-run ... --allow-paper-simulation` | 任務本身允許 auto_simulate 時，明確允許此次紙上成交 | 可能寫入紙上模擬帳本 |
| `local-models` | 已安裝本機模型、可用性與排除原因；不下載或推論 | 無 |
| `local-runs [--run-id ID 或 --limit N]` | 本機模型 job 列表或完整結果；limit 1–100 | 無 |
| `local-analyze --source-run-id ID --model NAME --mode MODE --idempotency-key KEY` | 明確啟動並保存本機分析，立即回傳 job，不輪詢 | 模型分析紀錄 |
| `local-cancel --run-id ID` | 保存分析取消要求，回傳實際狀態 | 分析取消旗標 |
| `local-paper-preview --run-id ID --account-id ID --expected-version N` | 檢閱本機模型目標的紙上調倉 | 無 |
| `local-paper-proposal ... --idempotency-key KEY` | 保存本機模型來源綁定的紙上提案，不接受 | 紙上提案 |

`POST` 不代表寫入：candidates 與 preview 都是唯讀計算。`run` 必須加 `--save` 才會保存。

## JSON 輸入與工具發現

`--input` 接受 UTF-8 JSON 檔案路徑，或 `-` 讀 stdin。輸入必須是 JSON object，最多 1 MiB；拒絕重複 key、NaN、Infinity 與溢位浮點數。未知 API 欄位仍由伺服器的嚴格 schema 拒絕。回應上限 8 MiB；socket timeout 預設 10 秒，可設定為大於 0、最多 60 秒。

`capabilities` 的 `data.actions` 列出命令、HTTP method/path、`read_only`、作用與 request schema URL。schema URL 指向本機 `/openapi.json` 對應的 JSON pointer，外部 Agent 可以讀取當前 API 型別，無須把舊參數格式寫死。Manifest 的契約版本為 `alphaview-portfolio-agent-cli-v1`。

以下代碼均為合成示例；執行時使用目前工作區中的候選代碼：

```sh
python3 scripts/portfolio_agent_cli.py candidates --input - <<'JSON'
{"scope":"market","min_score":50,"min_matches":1,"limit":10}
JSON

python3 scripts/portfolio_agent_cli.py preview --input - <<'JSON'
{"scope":"market","candidate_symbols":["SYNTA","SYNTB"],"strategy_weights":{"turtle":25,"trend":25,"pullback":25,"rps":25},"constraints":{"min_score":50,"min_matches":1,"max_positions":5,"max_position_weight_pct":25,"cash_buffer_pct":20}}
JSON
```

預覽結果沿用後端規則：缺任一啟用策略時分數為不可用，權重不重分配；不足配置席位的額度留現金。缺少 verified scan 或沒有合格候選會回傳 blocked，不產生清空持倉目標。CLI 不會下載行情或重新掃描。

## 保存研究並建立紙上提案

可把自行準備的 workflow JSON 放在 `data/agent-workflow.json`，再明確保存：

```sh
python3 scripts/portfolio_agent_cli.py run --save --input data/agent-workflow.json
python3 scripts/portfolio_agent_cli.py runs
python3 scripts/portfolio_agent_cli.py accounts
```

回傳的 `data.id` 是 Agent run ID。確認 `data.status` 為 `proposed`，再使用目前紙上帳戶版本建立提案：

```sh
python3 scripts/portfolio_agent_cli.py proposal \
  --account-id ACCOUNT_ID \
  --run-id RUN_ID \
  --expected-version 1 \
  --idempotency-key agent-proposal-example-001
```

此路徑保留 Agent run 的來源檢查。來源過期、行情版本變更或帳戶版本衝突會拒絕。紙上帳戶會重新驗算完整目標、現金、費用、滑價、周轉及單檔限制；Agent 配置通過不保證紙上提案可執行。

若外部 Agent 已有明確的完整紙上目標，也可使用原生 ProposalInput：

```sh
python3 scripts/portfolio_agent_cli.py proposal --account-id ACCOUNT_ID --input - <<'JSON'
{"expected_version":1,"targets":[{"symbol":"SYNTA","weight_pct":20}],"rationale":"Synthetic local paper example","idempotency_key":"paper-proposal-example-001"}
JSON
```

這是完整組合目標，未列入的既有紙上持倉目標為零。先檢閱提案的逐筆變動與所有限制；此命令本身不接受或執行提案。

## 明確接受紙上模擬

接受命令要求 `--paper`、帳戶、提案、版本與冪等鍵全部明確提供：

```sh
python3 scripts/portfolio_agent_cli.py accept --paper \
  --account-id ACCOUNT_ID \
  --proposal-id PROPOSAL_ID \
  --expected-version 1 \
  --idempotency-key paper-accept-example-001
```

這只更新獨立紙上帳戶。CLI 沒有 live mode，也不把參數轉送至其他 endpoint。風險限制、暫停開關、來源新鮮度與 automation mandate 版本檢查仍在後端交易內執行。使用者接受了已保存的 automation 紙上提案後，automation state 會顯示實際模擬狀態。

紙上 `proposal` 與 `accept` 在重試時沿用同一冪等鍵與完全相同的內容；不同內容重用同一鍵會收到 409。`run --save` 是追加研究紀錄，每次成功都會新增 run，沒有同一鍵重試契約；若連線中斷，先用 `runs` 檢閱已保存紀錄。CLI 不自動重試任何寫入。

## 啟動與追蹤本機模型分析

先選擇已保存且仍有效的規則 run，再讀取可用的本機模型：

```sh
python3 scripts/portfolio_agent_cli.py runs
python3 scripts/portfolio_agent_cli.py local-models
python3 scripts/portfolio_agent_cli.py local-analyze \
  --source-run-id RULES_RUN_ID \
  --model qwen3.5:4b \
  --mode analysis \
  --idempotency-key local-analysis-example-001
```

`--model` 必須是 `local-models` 實際列出的已安裝模型名稱，範例名稱不保證本機已安裝。CLI 會先拒絕 cloud 名稱、URL 與遠端 registry 路徑，後端再驗證雲端已停用、模型 digest 及本機 metadata。CLI 只連 AlphaView API，沒有直接連 Ollama、下載模型或呼叫付費供應商的命令。

`local-analyze` 是明確的啟動與保存命令，沒有唯讀推論模式。四個參數都必須明確提供；`--mode` 只能是 `analysis` 或 `conservative`。分析模式保留原規則目標；保守模式只允許保留、減半或排除原已選標的。沒有合格結果時會 blocked，不自動補值或改用規則結果假裝模型成功。

HTTP 202 只表示 job 已建立。CLI 原樣輸出 queued/running/completed 等狀態，**不等待模型、不自動輪詢，也不自動建立紙上提案**。外部 Agent 可以分開檢閱狀態或提出取消：

```sh
python3 scripts/portfolio_agent_cli.py local-runs --run-id LOCAL_ANALYSIS_ID
python3 scripts/portfolio_agent_cli.py local-runs --limit 10
python3 scripts/portfolio_agent_cli.py local-cancel --run-id LOCAL_ANALYSIS_ID
```

取消回應中的 `cancel_requested: true` 不等於已停止推論；進行中的 HTTP 請求可能要等回應或逾時才捨棄結果。以回傳 `status` 為準。相同 `local-analyze` 請求重試時保留相同冪等鍵；若要明確重跑 failed、blocked 或 interrupted 分析，才用新鍵。

只有 `completed`、`current: true` 且 `proposal_ready: true` 的分析可以接續紙上預覽：

```sh
python3 scripts/portfolio_agent_cli.py local-paper-preview \
  --run-id LOCAL_ANALYSIS_ID --account-id ACCOUNT_ID --expected-version 1

python3 scripts/portfolio_agent_cli.py local-paper-proposal \
  --run-id LOCAL_ANALYSIS_ID --account-id ACCOUNT_ID --expected-version 1 \
  --idempotency-key local-paper-example-001
```

`local-paper-preview` 始終唯讀，不接受 `--save`；保存必須使用明確命名的 `local-paper-proposal`。此命令的 `data.paper_proposal` 直接包含紙上提案的 `id`、`status` 與完整 preview 欄位。若要接受，仍使用前述明確的 `accept --paper`，後端會重驗本機分析來源。模型工作流的詳細限制見 [本機模型文件](local-agent.md)。

## 每日任務設定與手動嘗試

建立命令接受既有 MandateInput JSON。省略 `enabled` 與 `mode` 時，CLI 明確送出 `false`、`proposal_only`，不啟動每日自動成交。範例使用自動候選池，依每次新的有效選股快照解析候選：

```sh
python3 scripts/portfolio_agent_cli.py automation-create --input - <<'JSON'
{"name":"Synthetic daily review","account_id":"ACCOUNT_ID","candidate_source":"scan_pool","selector_limit":10,"workflow":{"scope":"market","candidate_symbols":[]}}
JSON

python3 scripts/portfolio_agent_cli.py automation-state
python3 scripts/portfolio_agent_cli.py automation-state --mandate-id MANDATE_ID
python3 scripts/portfolio_agent_cli.py automation-attempts --mandate-id MANDATE_ID --limit 10
```

`automation-update` 必須提供目前版本，JSON 只放要修改的欄位；不能同時在 JSON 裡放 `expected_version`。以下明確啟用每日提案，模式仍是 proposal_only：

```sh
python3 scripts/portfolio_agent_cli.py automation-update \
  --mandate-id MANDATE_ID --expected-version 1 --input - <<'JSON'
{"enabled":true,"mode":"proposal_only"}
JSON
```

使用 JSON 明確指定 `mode: "auto_simulate"` 且 `enabled: true`，會允許後端排程在符合條件時寫入紙上模擬帳本。更新命令不會默默切換模式、啟用任務或清除其他設定。每次修改都會增加版本，後續請求需使用回傳的新版本。

手動執行預設只建立提案，即使任務本身是 auto_simulate：

```sh
python3 scripts/portfolio_agent_cli.py automation-run \
  --mandate-id MANDATE_ID --expected-version 2
```

只有另外加 `--allow-paper-simulation` 才送出 `allow_auto_simulate: true`；任務本身也必須允許 auto_simulate，且帳戶、來源及風險限制都必須通過。此旗標不會把 proposal_only 任務轉成自動模擬，也不會啟用 disabled 任務。停用的任務仍可被明確手動執行。

每日嘗試沿用後端的 mandate/session 防重複規則：同一交易日只會有一次已認領嘗試，來源尚未就緒的 waiting 不消耗嘗試。`automation-create` 沒有冪等鍵契約；連線中斷後先讀 state，避免不確定時直接重建。update 由版本檢查保護，run 由 session claim 保護；CLI 不自動重試這些寫入。

## 輸出與退出碼

除了 `--help`，stdout 永遠輸出單一 JSON object：

```json
{"ok":true,"contract_version":"alphaview-portfolio-agent-cli-v1","command":"preview","read_only":true,"method":"POST","url":"http://127.0.0.1:8876/api/portfolio-agent/preview","data":{"status":"blocked"}}
```

`ok:true` 只表示 HTTP 請求成功；外部 Agent 仍須檢查 `data.status`、`executable`、blocking reasons 或 violations，不能將 blocked 當成可接受提案。`capabilities` 不發 HTTP 請求，所以沒有 method/url。

```json
{"ok":false,"contract_version":"alphaview-portfolio-agent-cli-v1","error":{"type":"http_error","message":"Local API returned HTTP 409","http_status":409,"detail":{"detail":"Synthetic version conflict"}},"exit_code":4}
```

| 退出碼 | 意義 |
| --- | --- |
| 0 | 請求成功或成功輸出 manifest |
| 2 | 參數、URL、輸入 JSON 或大小不符 |
| 3 | 本機連線失敗或 timeout |
| 4 | API 非 2xx 回應，或 redirect 被拒絕 |
| 5 | 回應 JSON 無效、非有限數值或超過大小上限 |

帳戶快照與紙上提案輸出可能含私人資料。CLI 只輸出至 stdout；如需保存，使用 `data/` 或 `artifacts/`，不要貼入文件、測試、commit 或記憶。

本次契約測試只使用合成資料、HTTP mock 與隨機埠的 loopback 測試伺服器，不操作真實帳戶或外網：

```sh
uv run --extra web --extra dev pytest -q tests/test_portfolio_agent_cli.py
```

## 調倉門檻與標的政策（2026-09-29）

`automation-create` / `automation-update` 的 JSON 可傳 `rebalance_trigger`，完整提供 `min_weight_drift_pp` 與 `min_completed_sessions_between_fills`（null 停用）。`automation-run` 仍遵守設定門檻；skipped 占當日次數，waiting 不占。`automation-attempts` 回傳凍結判斷證據。

規則工作流可傳 `account_context: {account_id, expected_policy_version}`，與帳戶允許標的政策綁定。政策改變後，任務需以完整 workflow PATCH 明確採用新版；普通改名或門檻修改不會重新授權。請先讀 [調倉門檻](rebalance-triggers.md) 與 [允許標的政策](paper-symbol-policy.md)。
