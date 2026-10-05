# 本機事前試驗登錄契約草稿

**狀態：未實作的未來設計，草稿日期 2026-10-05。** 本文件沒有新增資料表、API、登錄入口、攔截機制或試驗結果。現有「已保存試驗清單」仍是 `saved_receipts_only`，完整試驗登錄仍未交付。以下路由、欄位、事件與限制都是擬議契約，不代表已存在的產品能力或新增授權。

下一輪的目標，是讓使用者在一批本機研究開始之前，明確宣告候選設定及來源範圍，並留下每個候選的去向。即使未執行、研究不可用、執行失敗、取消或後來捨棄，候選都留在原始分母內。登錄只改善界定範圍內的可追溯性；不證明使用者沒有做過其他探索，也不消除選擇偏差。

## 1. 依據與現有缺口

本草稿以目前實際契約為起點：

| 現有來源 | 已有能力 | 登錄仍缺少的部分 |
| --- | --- | --- |
| [trial inventory](../alphaview/panel/workflow_path_trial_inventory.py) 與[說明](workflow-path-trial-inventory.md) | 一致快照下盤點全部已保存回條，保留不可驗證列、精確基礎分組及設定重複次數 | 無事前宣告，未保存／捨棄探索數與完整搜尋分母是 unknown |
| [CSCV](../alphaview/panel/workflow_path_cscv.py) 與[說明](workflow-path-cscv.md) | 手動選取 3–8 筆保存路徑，核對完整基礎及重複設定，保留不可用試驗 | 母體由事後選取構成，不知道原本宣告或實際探索的全部候選 |
| [path receipts](../alphaview/panel/workflow_path_receipts.py) 與[說明](workflow-path-receipts.md) | 不可變原件、相同請求重播、來源與版本核對、缺值原樣保存 | 回條通常在研究已檢閱後保存，不能證明研究之前已宣告候選 |
| [path comparison](../alphaview/panel/workflow_path_receipt_comparison.py) 與[說明](workflow-path-receipt-comparison.md) | 完整方法、資料、期間、股票池、覆蓋與成本基礎相符才列差額 | 相容性不等於完整搜尋涵蓋，也不決定登錄母體 |
| [path validation](../alphaview/panel/workflow_path_validation.py) | 使用保存工作流與本機歷史資料的固定方法研究 | 尚無先宣告、再計算的受控入口，也沒有已凍結原始資料的重播服務 |

`workflow_path_cscv._configuration` 的定義是完整 `settings`、`workflow_request`、`workflow_kind`、`candidate_symbols`、`rps_universe`。登錄須與這個精確口徑一致，不能改用回條 ID、畫面標題、部分參數或相同報酬推斷設定相同。

還有一個必須先解決的原件綁定問題：`workflow_path_receipts.save_receipt` 會先按原規範化請求尋找歷史回條。找到有效原件時直接重播，建立時間與內容都不改。因此，重播成功不能證明宣告後重新計算，更不能把宣告前的回條改稱本次試驗。未解決這點以前，不能把「多一張登錄表」當作可用的 prospective registry。

## 2. 最小範圍與開始時刻

第一版只涵蓋一個帳戶範圍內、使用者明確建立的本機 deterministic path 研究批次。候選設定可來自既有保存工作流；不自動產生參數、不跑網格搜尋、不建立供應商或模型呼叫。成本情境回條不自動算成新的路徑候選；其他研究種類需另訂契約。

開始時刻 `T0` 定義為：伺服器在單一寫入交易中，核對來源、完整保存宣告及全部候選槽位，成功提交 `batch_declared` 事件的時刻。使用者選檔、開啟草稿、按下尚未成功的請求、客戶端提供的時間，以及較早的回條時間，都不是 `T0`。第一個研究計算必須在這次提交成功之後才可啟動。

- 未提交的草稿可在介面修改，不是已登錄試驗，不能顯示登錄成功。
- 提交後，候選數量、順序、設定、來源、方法及分析 attempt 規則都不可改寫。
- 增減候選、換資料或改方法，要另建新批次；原批次完整保留。可用 `parent_batch_ids` 記錄後續適應性探索，但不能回填較早的宣告時間。
- 時間由伺服器寫入 UTC；事件順序用伺服器遞增序號。這是本機系統紀錄，不是外部可信時間戳，也不保證管理者無法修改資料庫。
- `capture_scope` 固定明示為 `registered_entrypoint_only`。未走該入口的既有計算、其他程式、先前探索與人工作業仍不在可證明涵蓋範圍內。

「先於這次受控計算宣告」不等於使用者從未看過相同設定或資料。已知先前原件可記為 prior evidence；不知道的前史維持 unknown，不能由使用者未填寫就推定不存在。

## 3. 批次、候選、設定與來源識別

以下是邏輯資料契約，**不是本輪 DDL**。

```text
BatchDeclaration
  contract_version: proposed registry definition version
  batch_id: server-created opaque ID
  declaration_fingerprint: SHA256(exact canonical finite declaration bytes)
  account_scope: exact account ID and declared binding role
  server_declared_at, declared_event_sequence
  parent_batch_ids: explicitly supplied prior batches, possibly empty
  capture_scope: registered_entrypoint_only
  prehistory: { coverage: unknown, unrecorded_trials: null }
  full_search_denominator: null
  candidate_set: ordered CandidateDeclaration[1..8]
  analysis_attempt_rule: first_started_attempt
  retry_policy: explicit_diagnostic_only, maximum 3 attempts per candidate
  policy: advisory_only=true, execution_authority=false,
          external_actions_authorized=false, automatic_search=false

CandidateDeclaration
  candidate_id: identity bound to batch_id + immutable ordinal
  ordinal: position in the declared candidate_set
  configuration_definition_version
  configuration: exact five-field definition used by CSCV
  configuration_fingerprint: existing canonical definition hash
  method_scope: exact versions and method text/fingerprints
  source_scope: complete declared input manifest and fingerprint
  duplicate_configuration_group: explicit group, if applicable
  prior_evidence_refs: original references only, never new attempt outcomes
```

候選 ID 是宣告槽位的識別，不是設定去重鍵，也不是原回條 ID。兩個槽位即使設定完全相同，仍是兩個宣告候選；另列重複群及 multiplicity，不刪掉其中一個。它們不因此成為統計上獨立的試驗。相同設定、不同資料基礎也不能當成相同同步分析母體。

完整設定必須在計算前從保存工作流、明示請求與方法常數確定。下一輪需抽出或建立無績效計算的純設定解析器，驗證其輸出與事後原件的 `_configuration` 五欄完全一致；禁止先計算結果再倒填宣告設定。無法確定必要設定就拒絕宣告，不補預設值。

`method_scope` 至少固定 receipt／path／workflow／scan／allocator 版本、路徑方法與定價說明、registry 設定定義版本及計算入口版本。未理解的版本不可默認等價。日後改變候選識別、重試規則或分析綁定語意，必須有新方法／契約版本，不覆寫舊宣告。

`source_scope` 至少固定：

- 保存工作流原件及請求指紋、帳戶綁定角色與當時政策上下文。
- 完整候選與 RPS 股票池，包含順序；預先確定的完整期間、訊號邊界及估值日期清單。
- 以 `sessions.latest_completed_session()` 取得的檢查交易日、當時輸入 revision、來源 manifest 的版本與指紋。
- 本機所需歷史資料的原始內容識別、逐標的涵蓋及必要欄位可用性。已知缺少的資料要有明示 absence／reason；不能用零列數掩蓋「尚未讀取所以未知」。
- 起始模擬資金、基準費率與滑價、symbol policy 等完整原始設定。文件與測試只用合成值，真實上下文只存核准的本機資料／artifact 範圍。

manifest 是來源範圍識別，不能假裝等於現有研究的 `history_fingerprint`。例如既有研究在缺歷史時可能沒有這個指紋；登錄可記下「此本機快照確知缺少該資料」及自己的 manifest 指紋，研究結果仍應為 unavailable。不可發明一個研究指紋代替缺值。

第一版不另建歷史資料重播庫。每次開始前必須核對宣告來源仍可精確讀取；來源／版本已變，就阻擋新的計算並保留該候選未嘗試的狀態，不能偷偷使用最新資料。未來若要從凍結快照重播，另訂儲存、容量及來源版本契約。

## 4. 固定分母與不能知道的範圍

```text
D_declared = len(original immutable candidate_set)
D_distinct_configurations = exact configuration groups, reported separately
N_attempts = number of actual started attempts, including explicit diagnostic retries
N_receipts = number of separately preserved original evidence records
```

這四個計數不可互換。傳輸重試不增加任何候選或 attempt；相同設定的兩個宣告槽位不減少 `D_declared`；捨棄、失敗、取消與未嘗試也不減少它。篩選或分頁只改變畫面，完整下載與涵蓋計數必須依原宣告集合取得。

每個候選的分析狀態必須落在以下互斥桶之一，所有桶之和恆等於 `D_declared`：

| 候選分析狀態 | 是否有分析 attempt 開始紀錄 | 已知的是什麼 |
| --- | --- | --- |
| `not_attempted_pending` | 否 | 已宣告，尚未開始；績效未知 |
| `not_attempted_cancelled` | 否 | 已明確取消開始；不是計算失敗 |
| `not_attempted_discarded` | 否 | 未計算便捨棄，保留原槽位與理由 |
| `in_progress` | 是 | 已記錄開始，尚無已接受的終態 |
| `evaluated` | 是 | 綁定分析 attempt 的研究完成；原結果仍需各自完整性核對 |
| `unavailable` | 是 | 研究方法明確回傳 unavailable；保留原缺值、原因及涵蓋 |
| `failed` | 是 | 已知執行錯誤，沒有可接受的研究結果；數值不可用 |
| `cancelled_after_start` | 是 | 執行器已確認中止；不是只送出取消要求 |
| `outcome_unknown` | 是 | 有開始紀錄，但無法證明結果；不猜成失敗、成功或未嘗試 |

缺值一律帶原因與覆蓋計數，UI 顯示 `—`；只有實際知道的零才顯示 0。沒有試驗紀錄，不代表試驗數為 0。若紀錄損壞，原宣告槽位仍存在，以 unavailable integrity／unknown outcome 呈現，不能從分母移除。

`declaration_complete=true` 只表示全套宣告已原子保存；`outcomes_resolved` 表示候選去向已明示；`metric_coverage` 表示有哪些可讀研究值。三者不能共用一個「完整」標籤。取消前未執行可能有已知去向，仍沒有績效；技術失敗也不能轉成零報酬。

無論本批次有多少候選完成，以下欄位仍保留：

```text
unrecorded_prehistory_trials = null
unrecorded_outside_entrypoint_trials = null
full_search_denominator = null
full_search_coverage = unknown
```

已知 prior saved receipt 數可另列為已觀察下限，不能補滿 unknown 前史。可主張的分母是「這份宣告的全部候選」，不是全部探索、所有可能設定或完整策略發現搜尋。跨批次加總可作操作盤點，但不能自動當成共同統計母體。

## 5. Attempt、重試與捨棄

第一版每個候選採 `first_started_attempt`：第一個通過 source preflight、由伺服器提交開始紀錄的受控 attempt，就是該候選的分析綁定。該紀錄是允許開始計算的邊界；若程序在提交後、真正呼叫計算前就中止，不能假裝已計算完成，仍按 outcome_unknown 處理。source preflight 拒絕不算 attempt，也不能製造 failed 結果；候選仍為 not_attempted，讀取時另顯示來源阻擋原因。

- 相同 idempotency key 與完全相同指令是傳輸重播，回覆原 batch／attempt／事件，不啟動第二次研究。
- 原 attempt 已失敗或結果未知，使用者可明確請求診斷重試；每次有新 attempt ID、序號、原因及父 attempt ID，保留全部結果。
- 診斷重試不自動取代分析 attempt，也不挑最好、最後成功或最好看的回條。若想換用其他重試政策，必須在新批次開始前明示並另訂方法版本；不能看結果後修改這批規則。
- `discard` 是處置事件，與結果分開。對 evaluated 候選加 discard，不刪除原件、不清空原值，也不把候選排除於原宣告母體。原結果、捨棄時間與理由全部可見。
- 已開始的取消先寫 `cancellation_requested`；只有執行器在可中止點確認，才寫 `cancelled_after_start`。若結果已先提交，取消不能改寫成未完成。
- 程序消失或逾時，不自動判定 failed。經本機核對確認無可恢復執行者後，可追加 `outcome_unknown` 及證據缺口；不得由客戶端補交績效數字。

批次不得在 active attempt 或未處理的 pending 候選存在時宣稱已關閉。使用者需明確決定未嘗試候選的去向；關閉不自動捨棄、不刪列。因損壞或中斷而 unknown 的紀錄可隨已知理由結案，但 `metric_coverage` 仍不完整。

## 6. 擬議事件與 API

**以下均未實作。** 這裡的端點僅描述責任邊界，下一輪不能直接把名稱當成已存在服務。

| 擬議介面 | 效果與必要條件 |
| --- | --- |
| `POST /api/paper/accounts/{account_id}/trial-registry/batches` | 明確提交完整宣告及全部候選；核對帳戶版本、來源 revision／manifest、方法、容量及 idempotency；原子寫入宣告，成功後才有 T0 |
| `POST .../batches/{batch_id}/candidates/{candidate_id}/attempts` | 只開始該一候選的本機研究；先驗證 frozen scope，再提交 attempt_started，之後才計算；不展開其他候選 |
| `POST .../attempts/{attempt_id}/cancel-request` | 記錄明確取消要求；不假裝已取消，不授權別的工作 |
| `POST .../batches/{batch_id}/candidates/{candidate_id}/dispositions` | 追加 keep／discard 或未開始前的 cancel，保留原結果與理由 |
| `POST .../attempts/{attempt_id}/resolve-interruption` | 只可記錄經核對的中斷觀察與 outcome_unknown；不能上傳研究值或把未知轉成成功 |
| `POST .../batches/{batch_id}/close` | 檢查每個宣告槽位都有可交接去向；不自動省略 unresolved 候選 |
| `GET .../batches/{batch_id}`、`GET .../batches/{batch_id}/evidence.json` | 同一唯讀快照返回完整宣告、所有槽位／attempt／處置與計數，及完整性／目前來源觀察；超限拒絕，不輸出看似完整的前幾筆 |

每個使用者批次命令要求明確 `expected_batch_revision`（建立批次除外）、`expected_account_version`、`expected_declaration_fingerprint` 及 idempotency key。歷史來源的凍結 account context 與這次寫入所核對的當前 account version 分開，不能以修改備註之名替換宣告來源。

找不到同帳戶範圍的批次或候選回 404；revision、指紋、idempotency 內容、來源或狀態衝突回 409；未知欄位、非有限值或不支援的指令回 422；位元組上限回 413。容量或已有 active attempt 的拒絕須有具體原因，不觸發部分候選。這些是擬議錯誤契約，不是已完成路由。

擬議事件至少有：`batch_declared`、`attempt_started`、`attempt_completed_evaluated`、`attempt_completed_unavailable`、`attempt_failed`、`cancellation_requested`、`attempt_cancelled`、`attempt_outcome_unknown`、`candidate_disposition_recorded`、`batch_closed`。全部由伺服器按已驗證命令或執行結果追加。終態與原件綁定在同一交易提交；不提供任意客戶端 `set_status` 或上傳績效來完成試驗。

```text
start_one_candidate(command):                    # DESIGN PSEUDOCODE
  validate command structure, finite values and sizes; do not check freshness before replay
  begin immediate
    replay same idempotency key + exact command if already accepted
    reject key reuse with different command
    compare batch revision + declaration fingerprint + account version
    verify original candidate membership and exact frozen source
    reserve terminal-event and evidence capacity
    append attempt_started; bind analysis_attempt if this is the first start
    commit                                      # computation has not begun before this

  compute one existing local method inside a consistent read snapshot
  # no provider/model/broker calls; no automatic next candidate

  begin immediate
    reject changed input revision/session/account/policy/method for result publication
    if stable: append terminal event + immutable attempt evidence binding atomically
    if changed: publish no research result; append only bounded conflict failure metadata
    commit
```

當來源變更時，失敗 metadata 只證明此 attempt 未能提交結果；它不是研究原件，不包含可用的績效，不讓半份結果冒充完整成功。開始事件保留是必要的執行紀錄，不是半份已發布研究。

登錄 revision 與金融資料 `input_revision` 必須分域。登錄自己的 append 不能使自己的 frozen source 失效；也不能把真實資料變更從 `input_revision` 排除。這個界線須先由測試明確證明，再接計算入口。

## 7. 冪等、競爭與持久化邊界

同一命令的 canonical bytes 與 idempotency key 一起綁定帳戶及批次範圍。先檢查既有完全相同命令的重播，再處理當前來源資格；重播只返回當時接受的紀錄，另外呈現目前來源狀態，不重新執行或改寫歷史。key 相同而內容不同，回 409。指紋相同而 canonical 內容不同，也回 409。

批次 revision 為樂觀鎖。兩個客戶端同時使用同一 revision 改處置或開始試驗，只能有一個成功追加；另一個得到 409 與可重新讀取的 current revision，不得自動覆蓋。attempt 的完成與取消亦不可讓兩個互斥終態同時成立。

每次 attempt 的終態需要自己的預期 attempt revision，不能只依全批次 revision：另一候選的註記不應使已完成的計算失去記錄，但來源及該 attempt 的狀態仍須嚴格核對。若在同一交易同時更新 batch projection，應由事件序號推導或重讀更新，不能盲寫舊計數。

建議第一版的容量邊界是每批 1–8 個候選、每候選最多 3 次明確 attempt、同批最多一個 active attempt。宣告 metadata 上限 1 MiB，單一事件 metadata 上限 2 KiB；超限不截短設定或理由。完整原始研究 evidence 沿用所選原件契約的大小限制，獨立存放並以精確指紋引用，不塞進每個事件。帳戶／全域批次與 evidence 總量上限需在實作前與現有 50／250 回條上限一起定案。

開始前要保留足夠空間寫入最小終態及證據結果；容量不足便不啟動。若仍因磁碟故障而無法記錄結果，重啟後保留 started／outcome_unknown，不假裝此次沒有發生。資料庫交易、程序崩潰及備份還原各自要有故障測試。

原始宣告及歷次事件不覆寫、不自動刪除；projection 只是可重建讀取視圖。事件指紋可供完整性核對，但本機 hash 不是簽章、可信時間戳或外部不可否認證明。

## 8. 原件、既有回條與統計消費者

新的 attempt 證據必須綁定以下資訊，才能聲稱是宣告之後由受控入口產生：

```text
batch_id + declaration_fingerprint + candidate_id + attempt_id
server_started_event_sequence + declared configuration/source/method fingerprints
original complete evidence bytes + their fingerprint + terminal event identity
```

現有 v1 path receipt 沒有這個綁定。第一階段應選擇一個獨立的 registry attempt evidence envelope／關聯版本，或明確升版的 receipt 契約；兩者須在實作前擇一，不能默默追加 key 後仍沿用舊版語意。舊回條及其 byte-identical replay 必須完全不變。

既有回條可以作為 prior evidence 的唯讀參照，也可以用來證明後來的值是否相同；但即使指紋相同，也不能替代新的 attempt-start 證據。沒有已記錄的 after-declaration computation，就沒有新的受控 attempt 結果。舊回條不能批次匯入成「早已登錄」的候選執行紀錄，也不能回填 server time。

登錄本身不執行 CSCV，不自動選取回條。未來統計消費者應接收固定的 `batch_id + declaration_fingerprint + all candidate_id slots + analysis_attempt bindings`，而不是介面目前顯示的成功回條清單。第一個整合版本應對不完整候選矩陣或重複設定群回報不可用及完整原因，不刪槽位、不縮分母、不把多次 attempt 變成額外候選。

重複 seed／重複設定若要有新的統計分組規則，另訂方法；不能由 registry 自行去重。`D_declared` 是候選涵蓋分母，統計切分的 `K_declared_splits` 是不同分母，均不能用成功筆數替代。這與同輪規劃中的 [portfolio validation v2 草稿](portfolio-validation-v2-contract-draft.md) 的候選與切分識別分工相接；兩份都仍未實作。

登錄沒有統計 pass 門檻、勝出者、排名推薦或 `live_ready` 轉換。全部候選與切分都有資料，只代表相應範圍完整，不代表策略有效或消除了資料修訂、股票池、先前探索、適應性選擇及交易假設的偏差。

## 9. 五個合成驗收情境

以下全部是擬議測試，不是本輪已跑過的測試，也不包含真實帳戶、持股或來源識別。

### A. 四個宣告槽位，四種去向

宣告 `B-ALPHA` 的 `C-A`、`C-B`、`C-C`、`C-D`，設定皆不同。提交前無任何 attempt；提交後 `D_declared=4`，四個槽位都是 `not_attempted_pending`。

依序令 A 回傳 evaluated、B 回傳 unavailable 且保留「缺少合成歷史資料」原因、C 因已知合成引擎錯誤 failed、D 在開始前由使用者取消。最後各狀態計數為 1，`N_attempts=3`，`D_declared` 仍為 4。只有 A 有可用研究值；B、C、D 不能補成零。候選去向可完整交接，但統計候選矩陣不可用。

**證明：** 檢查原宣告 bytes 不變；四槽位全在 API／下載；狀態桶總和為 4；失敗／取消的來源與時序可讀；執行器只被呼叫三次。

### B. 相同設定、事後捨棄與完整分母

`B-BETA` 宣告四槽位，其中 A、B 是相同完整設定 X，C、D 為 Y、Z。故 `D_declared=4`、`D_distinct_configurations=3`，X 的 multiplicity 是 2。完成 A 後，使用者因檢閱結果而標記 discard。

A 的原件與分析 attempt 不變；discard 只追加處置，不刪 A，也不把母體變成 B、C、D。重複設定群持續可見；首版統計消費者回報重複設定而不自動選一筆代表。

**證明：** discard 前後宣告及 A 原件指紋相同；原始四個 candidate IDs 都在下載；過濾出「保留」時摘要仍顯示完整四槽位；不存在從結果高低決定 canonical attempt 的程式路徑。

### C. 雙擊、網路重試與兩個瀏覽器的衝突

同一宣告 key 與同一 payload 連送兩次，只建立一個 batch、同一 T0 與同一組候選。相同 key 改一個設定欄位，回 409。A 的 start 命令連送兩次，只呼叫一次計算，返回同一 attempt。

兩個瀏覽器都讀到 batch revision 3；第一個成功追加處置，第二個仍用 3 開始候選，回 409，沒有第二個開始事件。完成回應遺失後，重播相同命令返回原終態，不再計算。

**證明：** 以 barrier 控制交易順序，檢查唯一 ID、事件數與計算 spy 次數；衝突後的候選設定、原件與另一瀏覽器未儲存草稿不被覆寫。

### D. 來源變更、中斷與診斷重試

第一個子案例：batch 凍結來源 `S-ONE`，開始 A 前來源已變為 `S-TWO`。請求拒絕，A 保留 not_attempted，沒有 attempt-start 或研究值。不能把新資料灌進舊 batch；必須另建宣告。

第二個子案例使用仍相同的合成來源：A 的 attempt 1 開始已提交，但程序在寫結果前中止。恢復後沒有足夠證據證明結果，追加 outcome_unknown。使用者另請求診斷 attempt 2，成功得到完整原件；兩個 attempt 都保留，`D_declared` 不變。分析綁定仍為 attempt 1，不能因此改為成功或只留下 attempt 2。

**證明：** 在 start commit／計算／terminal commit 之間設故障點；核對不會產生半份成功原件、unknown 不會變為 failed 或 not_attempted；重試不修改舊 event bytes，統計消費者仍回報分析結果未知。

### E. 舊回條、批次擴充與未知前史

工作區已有數份合成 v1 回條，使用者現在才建立 `B-GAMMA`。嘗試把其中一份舊回條貼到新 attempt 的完成欄位，拒絕；只允許列為 prior evidence。使用者未提供其他探索資訊時，`unrecorded_prehistory_trials` 與 `full_search_denominator` 仍為 null，而不是已保存筆數或 0。

開始後再要求加入候選 E，拒絕修改原宣告。使用者可另外建立有 parent link 的 `B-DELTA`；兩個批次各保有自己的 T0、分母與事後脈絡。新批次不會覆蓋舊批次，也不把適應性選擇改稱獨立驗證。

**證明：** 所有舊回條 bytes／建立時間不變；沒有自動 backfill；原批次 candidate set 和 declaration fingerprint 不變；新批次的 parent link 與先前證據明示；完整搜尋分母在兩份匯出中仍為 unknown。

## 10. 遷移與上線前必須定案的問題

1. **新原件放哪裡？** 建議採獨立 registry attempt evidence envelope，保持 v1 receipt 不變。若改採 receipt 新版，先定義版本、decode／replay 與容量；不得借用舊 idempotent replay 假造新 attempt。
2. **來源宣告如何取得？** 先完成無績效計算的設定／來源 manifest resolver，明確界定已知 absence、未知、內容指紋與 `input_revision`。現有 path evaluate 不能成為建立宣告的隱藏前置計算。
3. **捕捉哪些入口？** 第一版只保證 registered entrypoint；所有其他既有研究入口仍標 unregistered。若以後要聲稱覆蓋某帳戶的全部產品研究，需另外列舉、接線與驗證每個入口，仍不能宣稱覆蓋外部探索。
4. **容量與備份怎麼算？** 先定案 batch／attempt evidence 的帳戶與全域上限，以及與 50／250 舊回條上限的關係。遷移需更新 schema 簽章、`backup_preflight.KNOWN_SCHEMAS` 與相應 drop 清單，使用隔離資料庫驗證舊備份、還原與損壞拒絕；本草稿沒有執行這些動作。
5. **中斷誰來判定？** 需要可核對的本機執行者識別、取消確認點及人工 interruption resolution 流程。沒有活著的程序不能單獨證明計算失敗；不能把逾時當成績效不可用的唯一理由。
6. **如何展示前史？** 既有 inventory 繼續保留原功能。新介面清楚分開 registered batches、prior saved evidence、outside-entrypoint unknown；不替舊紀錄產生虛構開始時間或事前登錄標章。

以上問題須在各實作單元開始前固定選項與驗收；它們不授權新供應商、外部發布、批次自動搜尋或券商操作。

## 11. 可交給下一輪的分段工作與完成證據

| 次序／單元 | 邊界 | 必須出示的證據 |
| --- | --- | --- |
| 1. 純宣告契約與解析器 | 只做 canonical 配置／來源 manifest、完整候選清單、identity、容量與狀態 invariant；不啟動研究、不加統計方法 | 合成設定在計算前後與 `_configuration` 逐欄相等；缺欄位／未知／非有限保留原因或拒絕；宣告 resolver 的研究／provider／broker spy 呼叫為零 |
| 2. 不可變登錄儲存及遷移 | 主代理指定唯一 schema writer；宣告、槽位、事件、revision、idempotency、容量保留與 snapshot reads | 原子宣告／競爭／碰撞／故障／完整分母測試；schema 簽章和備份登錄更新；舊回條及帳戶資料不變 |
| 3. 單一明確計算入口與新 attempt 證據 | 先完成新 evidence envelope 決策；只接既有本機 path 方法的一次明確研究，沒有自動候選迴圈 | start 先於計算；source conflict 不發布值；evaluated／unavailable／failed／取消／unknown 都可追溯；傳輸重試只計算一次；舊 receipt replay 維持逐字一致 |
| 4. 人工檢閱與完整匯出 | 明確宣告、開始一筆、取消、discard、讀取／下載；完整分母始終可見；不自動送入 CSCV | 真瀏覽器空輸入、連點、重新整理、雙頁衝突、390px；晚回應隔離；完整未篩選 bytes／計數；預先存在的未儲存草稿不被背景核對清除 |
| 5. 統計消費者的另案契約 | 待前四項驗收後，才對 registry population adapter 與新方法版本另案設計 | 消費全部宣告槽位與固定分析 attempt；候選與切分分母分開；缺值、duplicate 或 unknown 時不可用且不縮分母；不改寫現有 selected-set CSCV v1 的語意 |

下一輪若只能交付前兩項，完成報告只能寫「宣告與登錄儲存已驗證」，不能寫「已捕捉全部試驗」；沒有第三項就尚未證明 after-declaration execution。沒有第四項就不能宣稱已完成使用者主路徑。第五項必須維持獨立方法工作，不把登錄狀態接成交易閘門。

每一單元依影響範圍完成合成測試；產品整合後由主代理跑專案五道關卡、讀輸出並檢查主路徑。**本文件只提供下一輪契約與驗收設計；本輪沒有實作、遷移、啟動或驗證任何 registry 產品功能。**
