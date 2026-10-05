# 指定下一交易日開盤的本機 paper 模擬

方法 `alphaview-paper-next-open-v1`。這是已完成日線的參考價模擬，沒有券商、即時委託、流動性或部分成交模型，不代表開盤時真的成交。既有 `alphaview-paper-portfolio-v2` 收盤模擬保留原語意。

使用者選擇仍有效的 v2 proposal，在指定下一個 XNYS session 的開盤前明確排隊，輸入兩個不可修改的授權上限：全部手續費加不利滑價，以及全部買入本金加買入手續費（不扣除賣出款）。來源收盤價算出的股數、來源、帳戶版本與執行政策一起凍結。每帳戶最多一批未結束委託，沒有資金預留；帳戶或政策改動會使原委託失效。

只有指定交易日收盤後 15 分鐘，且本機具有該日有效 raw open，才會處理。所需持股或委託缺價，整批等待；不使用前值或更晚日期，不重算股數、不縮單。已知資料下的現金、費用、買入扣款、周轉率、持倉比例、最低現金或最小交易金額違規都阻塞整批；疑似跨日調整因子改變也阻塞，沒有拆股或股息換算。股數精度沿用已凍結數量，金額為 8 位小數，買入成本含費用，賣出採移動平均成本並扣費。

`waiting_session`、`waiting_prices`、`blocked` 占用帳戶未結束名額。前兩種可由本機 runner 接續；`blocked` 只能由使用者明確重試。重試仍使用同日期、同股數與同授權上限。`filled`、`cancelled`、`invalidated` 是終態。相同 idempotency key 回放同一回應；不同 body 使用相同 key 回 409。

來源驗證採固定 workspace symbol manifest，雜湊其 signal 日及更早的完整 bars 數值與穩定資料身份，最多 10,000 symbols、500,000 rows，不截斷。新增未來日線及同值重載不會使來源失效；舊行情修正、刪除、歷史補入或身份改動會失效。此保守範圍包括未交易標的，可能因其他來源歷史修正而需重新授權。新加入 manifest 外的資料集不改變原先已批准的來源範圍。來源運算先在一致 read snapshot 完成，write transaction 再核對 input revision、queue/account/source 狀態。

Agent 來源保留生命週期與方法驗證。本機模型使用獨立 historical authorization validator；不把下一個交易日或合法行情追加當作取消授權。帳戶、來源取消或方法改動仍會阻止成交。

成功時，在同一 transaction 新建獨立 next-open execution proposal、寫完整 ledger、更新帳戶與 queue；原 v2 proposal 不改寫。兩種執行途徑由 account version 防止同一份資金重複成交。事後修正指定日開盤價會在 queue 顯示 `execution_reference_revised`，既有收據與帳本不重新定價。

`recorded_at` 是實際記錄時間；`effective_session` 是原先指定的假設執行日。若更晚才處理，標示 `late_recording`，不回填或覆寫舊 NAV snapshots。實驗分支不複製 queue。

整合入口為 `paper_next_open.init_schema(db)`、`paper_next_open.router`、`paper_next_open.Scheduler().start()/stop()`；runner 每 60 秒只讀本機資料，沿用 workspace lock，禁止自行下載。API 路徑為 `/api/paper/accounts/{account_id}/next-open-orders` 的 collection/enqueue，以及 `/{order_id}`、`/{order_id}/process`、`/{order_id}/cancel`。唯讀 collection 提供服務端 XNYS 時間窗、可選 proposal fingerprints、狀態及最近 20 次嘗試。
