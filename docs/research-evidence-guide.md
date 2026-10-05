# 研究證據使用指南

從主選單開啟 **Agent 投資組合／Portfolio Agent**，先選紙上帳戶。除另行標示的「回測研究台」前綴診斷外，以下工具都以這個帳戶為範圍；英文介面可依括號中的按鈕名稱尋找。

研究結果、保存回條與人工檢閱各有用途：研究顯示某次假設下的結果；回條把當時的請求、來源與證據保存下來；人工檢閱記錄「我看過了」或疑慮。這些動作都不會送出委託，也不會自動改配置或解除既有交易限制。

## 先找到要看的工作區

| 想做的事 | 開啟位置 |
| --- | --- |
| 檢視工作流的歷史路徑、分段、損益與保存證據 | **Agent 工作流／Agent workflow** → **工作流歷程／Workflow history** → 選一筆已保存工作流 |
| 研究保存提案的單日容量、開盤限價或多日到期 | **配置與提案／Allocation & proposals** → **調倉提案／Rebalance proposals** → 選提案 → **提案明細／Proposal details** → 展開 **執行情境研究（唯讀）／Execution scenario research (read only)** |
| 記錄對既有本機模型分析的人工判斷 | **本機模型分析／Local model analysis** → **已保存分析／Saved analyses** → 點分析日期與識別碼 |

工作流與提案研究區內有工具捷徑，可直接跳到對應區段；不會切帳戶或自動執行研究。收合工具可保留仍在此工作區內的草稿與結果；重新整理頁面不能視為已保存。

## 看工作流路徑，並保存當時證據

1. 選取工作流後，跳到 **投組路徑／Portfolio path**，按 **檢查保存設定的歷史路徑／Inspect historical path of saved settings**。先看來源日期、涵蓋數與不可用原因，再看路徑數值。這一步需要當期可用的保存工作流。
2. 要在資料更新後仍保留這次結果，於下方 **保存與重讀歷史路徑／Save and reread historical paths** 按 **保存這次路徑證據／Save this path evidence**。保存時會重新核對來源；畫面有結果不等於已保存回條。
3. 日後按 **讀取此工作流回條歷史／Load receipt history for this workflow**，再按 **讀取路徑回條／Load path receipt**。需要離線原件時，使用 **下載保存路徑回條原始 JSON／Download original saved path receipt JSON**。

同一工作流還有以下檢視。**成本、分段與損益歸屬使用當期工作流重新建立研究結果，不是讀取你剛選的歷史回條。**

| 工具捷徑 | 操作與讀法 |
| --- | --- |
| **成本情境／Cost scenarios** | 填單邊費用與滑價，按 **比較成本情境／Compare cost scenarios**。各情境保留相同歷史決策，成本仍會影響模擬股數與後續本金。結果下方可另存成本回條。 |
| **時間分段／Time segments** | 按 **檢查四段歷史路徑／Inspect four historical segments**，看同一條連續路徑的四段表現；每段接續前段本金，並非四個獨立樣本。 |
| **損益歸屬／P&L attribution** | 按 **檢查逐標的損益／Inspect per-symbol PnL**，看各標的損益、費用與核對差額。貢獻百分點以整段原始模擬資金為分母，不是該標的自身報酬率。 |

這些結果可用各自的 JSON 按鈕下載。分段與歸屬目前沒有獨立保存回條按鈕，離線留存需自行下載。

歷史路徑使用保存的候選與設定，有事後選擇偏差；它不重建當年真正可得的股票池，也不代表完整自動化、風控或實際成交表現。

## 用保存回條看回撤、月份與滾動期間

這三個工具讀取同帳戶的已保存路徑原件，清單可跨工作流。先手動載入清單、選回條，再按檢視；它們不會用新行情改寫舊路徑。

| 工具捷徑 | 依序點擊 | 看結果時留意 |
| --- | --- | --- |
| **回撤歷程／Drawdown episodes** | **載入歷史路徑回條／Load historical path receipts** → 選回條 → **檢視保存回撤區段／Inspect saved drawdown episodes** | 尚未恢復的回撤保留未恢復狀態，不推測未來恢復日期。 |
| **月報酬／Monthly returns** | **載入月報酬來源回條／Load monthly return receipts** → 選回條 → **檢視保存月報酬／Inspect saved monthly returns** | 首尾可能是部分月份；期間外月份顯示 `—`，不是 0%。月報酬不能直接相加。 |
| **滾動期間／Rolling windows** | **載入滾動視窗來源回條／Load rolling-window receipts** → 選回條 → **檢視保存滾動視窗／Inspect saved rolling windows** | 21、63、126 個交易日不是曆月、季或半年。所有視窗來自同一路徑且互相重疊，不是獨立樣本。 |

各工具的完整 JSON 下載保留原回條與衍生分析。要放進試算表閱讀，可另外按：

- **下載已觀察月份 CSV／Download observed months CSV**：包含所有已觀察月份與部分月涵蓋資訊，不把年度表中期間外的空格補成零值。
- **下載全部期間與視窗 CSV／Download all horizons and windows CSV**：包含三種期間的全部 549 個視窗；畫面篩選最低／最高或翻頁，都不會縮小下載範圍。

CSV 保留來源識別與有限原值，必要欄位缺漏時不提供不完整的檔案。它是閱讀副本；需要完整原件、全部欄位與原始數字文字時，保留原始 JSON。下載不會重跑研究或再保存一筆資料庫紀錄。

## 先盤點保存試驗，再選 CSCV

在 **保存試驗清單／Saved trial inventory** 按 **載入完整已保存試驗清單／Load complete saved trial inventory**。先看完整帳戶計數、不可用數、比較基礎分組與重複設定次數，再用分類、搜尋和每頁 25 筆清單找原件。篩選不改完整統計；**下載完整試驗清單 JSON／Download complete trial inventory JSON** 也不只下載目前這一頁。

同一設定保存多次仍保留全部回條識別，不會悄悄當成多個不同設定。成本回條另計，不當成路徑試驗。清單只知道「已保存的試驗」；未保存、捨棄或在別處做過的嘗試，以及完整搜尋分母，都仍未知。

接著開 **試驗集排序／Trial-set ranks**：

1. 按 **載入此帳戶的路徑回條／Load path receipts for this account**。
2. 手動選 3–8 筆不同完整設定、比較基礎相符的路徑回條；盤點清單不會替你勾選。
3. 按 **檢查選取試驗的 CSCV／Inspect selected-trial CSCV**，查看完整選取與切分涵蓋，再讀排名穩定性。需要留存時按 **下載完整 CSCV 證據 JSON／Download complete CSCV evidence JSON**。

缺必要設定或比較基礎不符時，不能把剩下可用幾筆當成完整結果；依畫面原因重新檢查選取。CSCV 只描述這次所選試驗，不代表完整搜尋的過度擬合機率、獨立樣本外證明或策略通過。完整試驗登錄、CPCV 與由這些研究結果授予資格的新閘門，均不是此流程已提供的功能。

## 看保存提案的 DAY／GTD 情境

在提案明細展開 **執行情境研究（唯讀）**。三個工具都固定使用保存提案股數；修改研究假設不會改原提案。

| 工具捷徑 | 操作 | 結果範圍 |
| --- | --- | --- |
| **日成交量容量／Daily volume capacity** | 填參與率，按 **研究保存提案容量／Study saved proposal capacity** | 以次一交易日開盤價與當日量估算單日容量，保留部分／未滿足股數及 DAY 情境剩餘量。 |
| **DAY 開盤限價／DAY opening limit** | 填參與率與選用限價，按 **研究保存提案限價情境／Study saved proposal limit scenario** | 只比較開盤價與限價。開盤不符合時的零股數是此情境輸出，不表示盤中一定未成交。 |
| **GTD 多日開盤／GTD multi-session opening** | 先按 **讀取 GTD 日期與來源／Load GTD dates and source**，選未來 1–5 個交易日內的明確到期日，填參與率／選用限價，再按 **研究固定股數 GTD 情境／Study frozen-quantity GTD scenario** | 逐日接續未滿足股數。必要中間資料缺失會停止該筆後續推演，已觀察部分與未知剩餘分開保留。 |

GTD 的候選到期日是相對提案訊號日的後續交易日。若所需日期尚未完成，不能聲稱剩餘股數已到期；若情境股數已提前全部消耗，可顯示 `scenario_full`，仍不代表已驗證未來到期事件。

全日成交量是事後才知道的容量代理，不能證明開盤有足夠流動性。這些工具不利用日線高低價推測盤中限價先後，不代表券商成交、取消或實際部分成交；缺價、缺量或無法解釋的調整因子變動會保留為不可用。

### 保存、比較與重讀研究

每個工具結果下方都有 **執行研究回條／Execution study receipts**：

1. 要保存當下證據，按 **保存研究回條／Save study receipt**。來源需要仍符合這次請求；格式完整的不可用研究也可保存，其缺口與狀態不會變成通過。
2. 按 **讀取研究回條／Load study receipts**，再按 **檢閱研究回條／Review study receipt**。**下載原始研究 JSON／Download original study JSON** 保留研究原文；**下載完整回條 JSON／Download complete receipt JSON** 另包含保存身分與來源。兩種雜湊各自對應研究原文與完整回條，不能互換。
3. 要比較兩組已保存假設，在 **比較保存的執行研究／Compare saved execution studies** 選基準與另一份回條，按 **比較兩份研究／Compare two studies**。選項來自已載入的歷史清單，限同帳戶、同提案、同種類。

比較只讀原件，允許參與率或限價不同；方法、日期範圍或必要來源基礎不相容時保留雙方原值與原因，不提供看似可比的差額。已知成對數值才有「另一份減基準」差額，缺值不補零，也不產生勝出方案。

要在試算表閱讀差額，可按 **下載全部訂單與逐日比較 CSV／Download all order and daily comparisons CSV**。長格式列出全部訂單層指標及已保存逐日指標，不受搜尋或分頁影響；空白值附不可用標記，比較基礎不相容時仍保留原值與空白差額。CSV是閱讀副本，完整比較基礎與雙方原件仍以JSON保存。

## 整批封存，以及檢查手上的封存檔

要先查看已存筆數與上限，在 **配置與提案／Allocation & proposals** 展開 **研究回條容量／Research receipt capacity**，按 **讀取回條容量／Read receipt capacity**。**此帳戶／This account** 是選定帳戶的用量，**全工作區／Whole workspace** 是整個本機工作區的用量；**研究完整性診斷回條／Research integrity diagnostic receipts** 只有工作區範圍，帳戶欄顯示 `—`，不是 0。損壞或無法驗證的已存列也計入容量，匯出不會騰出空間。這是明確讀取時的計數快照，保存後可再次讀取；面板不掃描完整性、不授予保存權限，也沒有刪除功能。

四種封存區處理不同證據：

- 工作流內的 **配置與回條／Allocation and receipts** → **研究收據封存與預檢／Research receipt archive and preflight** → **準備完整帳戶封存／Prepare complete account archive** → **下載完整帳戶封存／Download complete account archive**。涵蓋此帳戶的配置研究收據。
- 主選單 **回測研究台／Research Desk** 的單股診斷區 → **前綴診斷封存與預檢／Prefix diagnostic archive and preflight** → **準備完整股票封存／Prepare complete symbol archive** → **下載完整股票封存／Download complete symbol archive**。只涵蓋所選股票的抽樣前綴診斷收據，不以紙上帳戶為範圍。
- 工作流內的 **路徑回條封存／Path receipt archive** → **準備完整路徑收據封存／Prepare complete path receipt archive** → **下載完整路徑收據封存／Download complete path receipt archive**。涵蓋此帳戶跨工作流的路徑與成本回條。
- **配置與提案** 中的 **執行研究回條封存／Execution study receipt archive** → **準備完整執行研究收據封存／Prepare complete execution study receipt archive** → **下載完整執行研究收據封存／Download complete execution study receipt archive**。涵蓋此帳戶所有提案的三種執行研究回條。

四者都涵蓋各自範圍的完整集合，不受目前收據清單頁次或選取項目限制。遇到整份大小／容量上限會明確拒絕，不下載悄悄少了幾筆的檔案。封存也保留損壞或未知格式的原始儲存內容，但不把它們標成有效研究。

要檢查既有檔案，在同一封存區選檔或貼上完整 JSON，再按 **唯讀預檢封存檔／Preflight archive read-only**。先看整份判定、原因、涵蓋與容量，再展開個別紀錄；搜尋或只看相容紀錄，不會解除整份受阻判定。

四種預檢的 **逐筆預檢紀錄／Individual preflight records** 都可按 **下載全部預檢紀錄CSV／Download all preflight records CSV**。CSV 包含當次已接受報告的全部中繼資料與原序紀錄；搜尋、相容性篩選、分頁或展開狀態都不縮減下載範圍。整份受阻或零筆紀錄時，仍可下載判定、原因、涵蓋與容量等報告內容。

這是供試算表閱讀的長格式副本：`record_index` 從 0 起算，`field_path` 指出原欄位位置，`value_type` 區分有限數值、布林、字串、`null`、空容器與缺席欄位。`missing` 只表示欄位未出現在報告，不代表零值，也不推論缺席原因。完整內容無法安全轉換或超過上限時，下載會拒絕，不產生部分檔案。需要原封存的全部內容、原始數字文字與校驗依據時，仍保留封存 JSON；CSV 不取代原件，也不觸發重算或保存。

「相容」表示此版本能核對保存格式與內容，不表示研究成功、來源仍當期或有交易資格。**預檢不會匯入、還原、刪除或修復資料；預覽匯入尚未提供。** 這也不是整個應用程式資料庫的備份。

## 對本機模型分析留下獨立人工檢閱

從 **已保存分析／Saved analyses** 開啟一筆已結束的分析。可先在 **保存證據驗證／Saved evidence verification** 按 **驗證保存證據／Verify saved evidence**，重驗已保存內容；這不會再呼叫模型。

在下方 **獨立人工檢閱／Independent human review**：

1. 按 **載入檢閱狀態／Load review status**，分別看程式證據、來源有效性與人工狀態。
2. 在 **人工判斷／Human judgment** 選 **待檢閱／Review required**、**已檢閱／Reviewed** 或 **人工不採納／Rejected by reviewer**；依需要勾選固定疑慮。不採納至少需一項理由。
3. 按 **保存檢閱註記／Save review annotation**。按 **載入檢閱歷史／Load review history** 可重讀過去各次判斷。

**已檢閱只表示看過，不表示已驗證或批准。** 即使保存此註記，失敗的程式證據與原有資格仍維持失敗。人工不採納也是研究註記，不會自行改動執行控制。來源或帳戶脈絡改變後，舊判斷保留在歷史，不能直接沿用成目前已檢閱。此處沒有自由文字筆記，也不重跑模型。

## 遇到 `—`、過期或損壞時

| 狀態 | 意義與可做的事 |
| --- | --- |
| **缺值／不可用（Unavailable）** | 必要資料、涵蓋或計算條件不足。先看原因與已知／所需數量；`—` 是未知，不是 0。格式完整的不可用證據仍可作為缺口紀錄保存。 |
| **來源已過期（Stale source）** | 保存原件可能完整，但來源已不是目前版本。支援歷史讀取的工具仍可檢視原件；新研究或新保存可能要求重新取得當期來源。歷史可讀不等於有目前執行資格。 |
| **損壞／無法驗證（Integrity unavailable）** | 原件的內容、身分或格式無法核對。不提供作為有效證據的個別下載，不回退成更早的成功結果；封存可保留原始內容供後續檢閱。 |
| **來源或版本衝突（409）** | 操作期間脈絡改變，或所選證據不符合要求。依具體訊息重新載入來源／歷史或檢查選取；不能把尚未確認的保存當成成功。 |

真正已知的零值仍顯示 0。不要自行用零取代空白，也不要只挑可用列推論整份結果已完整。

## 哪些內容會留下來？

| 內容 | 保存位置與時機 |
| --- | --- |
| 已保存工作流、提案、研究回條、人工檢閱事件 | 在本機資料庫中；需各自的明確保存動作，重新整理後可由歷史重讀。保存回條不會隨新行情重寫。 |
| 當次檢視、尚未保存的研究結果、選取與表單草稿 | 留在目前介面生命週期內。收合可保留；換帳戶／提案、離開會卸載的工作區或重新整理可能清除。來源改變也可能撤下舊結果與下載，即使未送出的假設仍留著。 |
| 下載的 JSON、CSV、封存檔 | 留在瀏覽器指定的本機下載位置；不會自動回存資料庫。請自行保管，檔案可能包含帳戶與提案證據。 |
| 預檢、回撤／月報酬／滾動分析、試驗盤點與 CSCV 檢視 | 不會因為按檢視而新增保存紀錄。需要離線留存時下載完整結果；預檢不提供匯入。 |

方法細節可另讀：[歷史路徑](workflow-path-validation.md)、[月報酬](workflow-path-monthly.md)、[滾動視窗](workflow-path-rolling.md)、[試驗清單](workflow-path-trial-inventory.md)、[CSCV](workflow-path-cscv.md)、[GTD 情境](execution-gtd-study.md)、[執行研究回條](execution-study-receipts.md)、[人工檢閱](local-agent-review.md)、[預檢 CSV 格式](archive-preflight-csv.md)。
