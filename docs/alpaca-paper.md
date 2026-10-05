# Alpaca Paper 連線

版本：`alphaview-alpaca-paper-connection-v1`。2026-09-21 使用者授權將已登入的 Alpaca Paper 服務接入 AlphaView。本版採用官方 REST API，提供帳戶、持倉、最近委託與市場時鐘；尚未把 Agent 提案送往 Alpaca。

## 使用

1. 啟動 AlphaView：`uv run --extra web python -m alphaview.panel serve`。
2. 進入 `http://127.0.0.1:8876/?connection=alpaca#agent-portfolio`，或在 Agent 投資組合選擇 **Alpaca Paper**。
3. 使用 Alpaca **Paper** 帳戶的 API Key 與 Secret，點「驗證並保存 Paper 連線」。後端先向 Paper `/v2/account` 驗證，再寫入本機設定。
4. 點「更新 Alpaca 資料」重新擷取；委託可切換全部、未結束或已結束，最多顯示最近 50 筆。

Secret 只在 Alpaca 建立時顯示。已有 Key 而沒有 Secret 時，需要使用者提供現有 Secret，或先確認可以重建金鑰，再在 Alpaca 操作；重建後其他使用舊憑證的程式也需更新。不要將 Secret 貼在對話、文件、指令列參數或截圖報告中。

設定存放於 `data/panel.alpaca-paper.json`，檔案權限 `0600`、Git 忽略；不進 SQLite 或資料庫備份。`PANEL_DB_PATH` 改變時，設定預設跟隨該資料庫位置。伺服器可用 `ALPHAVIEW_ALPACA_CREDENTIALS_PATH` 指定另一個本機路徑，私人憑證仍必須留在忽略的 `data/` 或 `artifacts/`。不接受瀏覽器指定路徑。

「移除本機連線」只刪除本機憑證檔案，不撤銷 Alpaca Key，也不更動帳戶與委託。需要停用外部 Key 時，請另至 Alpaca 管理。

## API

| 本機端點 | 功能 |
| --- | --- |
| `GET /api/alpaca-paper/connection` | 僅讀本機連線狀態、版本及能力，不傳回 Key 或 Secret，不呼叫 Alpaca |
| `POST /api/alpaca-paper/connection` | 接受 `api_key`、`secret_key`、`expected_version`，驗證帳戶後原子儲存；第一次版本為 null |
| `DELETE /api/alpaca-paper/connection` | 以 `expected_version` 核對後移除本機設定 |
| `GET /api/alpaca-paper/snapshot?status=all&limit=50` | 讀取帳戶、持倉、最近委託、時鐘；`status` 為 all/open/closed，limit 為 1–100 |

外部傳輸固定到 `https://paper-api.alpaca.markets`，僅允許 `GET /v2/account`、`/v2/positions`、`/v2/orders`、`/v2/clock`。停用代理／netrc 繼承，不跟隨重新導向；設定逾時與回應大小上限。更新連線以版本避免覆蓋；讀取期間連線改變，該次資料會丟棄。

所有回應使用 `Cache-Control: no-store`。Secret 不回送前端，表單不使用 localStorage/sessionStorage。API 仍依專案單一使用者、loopback 信任模型運作；不要公開此伺服器。

## 資料口徑

- 四個資源各有 `fetched_at`、status、error；它們依序擷取，並非跨端點原子快照。`coverage` 計算成功資源數，並不代表每個欄位皆可用。
- 帳戶身份與設定時不一致、無法驗證時，不再擷取其餘資源。持倉或委託失敗則保留其他成功資源。
- 金額、股數保留供應者十進位文字，不轉成本機浮點績效。缺值與非有限值為 null，前端顯示 `—`。
- 委託依提交時間倒序、`nested=false`，不包含完整歷史匯入或分頁；傳回數達 limit 時標示可能截斷，`total` 保持 null。
- `/v2/clock` 是美股市場時鐘，不適用於判定所有商品是否可交易。
- 資料不寫入研究持股、行情、input revision 或本機 paper 帳本。本機提案、接受與排程仍只操作原本的本機模擬。

2026-10-01 起連線設定另有 `order_style`（`market`／`limit` 與限價帶基點），由交易代理分頁的委託政策設定，舊設定檔視為市價；限價與到期部分成交的語意見 `docs/execution.md` 的「委託型態與限價帶」。

## 可接續的功能

使用 Alpaca 執行 Agent 調倉還需要獨立的執行階段：由已驗證帳戶建立調倉草稿、資產交易資格與數量檢查、以 client_order_id 避免重複委託、部分成交／撤單／拒單追蹤，以及雲端帳本對帳。這些尚未實作，不能把目前唯讀連線視為自動交易。

官方也有 [Alpaca MCP Server](https://github.com/alpacahq/alpaca-mcp-server)。本版沒有安裝或啟用 MCP，使用直接 REST 接入，讓專案能力維持明確且可檢查。

## 官方依據

- [Paper Trading](https://docs.alpaca.markets/us/docs/paper-trading)：Paper 憑證與 endpoint。
- [Connect to Alpaca API](https://alpaca.markets/learn/connect-to-alpaca-api)：Key、Secret 與重新產生金鑰。
- [Account](https://docs.alpaca.markets/us/reference/getaccount-1)、[Positions](https://docs.alpaca.markets/us/reference/getallopenpositions)、[Orders](https://docs.alpaca.markets/us/reference/getallorders-1)、[US Market Clock](https://docs.alpaca.markets/us/reference/legacyclock)：讀取端點與資料語意。

測試僅使用合成帳戶、憑證與隔離資料庫，不呼叫實際 Alpaca。實際連線狀態請查看本機頁面，不在文件保存帳戶值或憑證。
