# 研究證據區塊的頁內導覽

`ResearchEvidenceNavigation` 為已選定工作流程或風險工作區提供短按鈕，讓使用者直接跳到規則、配置路徑、成本、分段、歸因、配置回條，或公司行動預覽／歷史。`ResearchEvidenceSection` 可把長工作區分成原生可收合區塊；使用者可先全部收合，再用捷徑開啟所需證據。兩者不切換頁面、帳戶或研究來源，也不重設表單草稿。

## 整合契約

```tsx
const workspaceRef = useRef<HTMLDivElement>(null)
const prefix = useId()
const tools = [
  {
    targetId: `${prefix}-rules`,
    label: t('單規則', 'Rules'),
    purpose: t('檢查獨立規則證據', 'Inspect standalone rule evidence'),
  },
  {
    targetId: `${prefix}-path`,
    label: t('配置路徑', 'Path'),
    purpose: t('檢查保存配置的研究路徑', 'Inspect the saved allocation path'),
  },
]

return (
  <div ref={workspaceRef}>
    <SavedRunSummary />
    <ResearchEvidenceNavigation
      workspaceRef={workspaceRef}
      scopeKey={`${account.id}:${run.id}`}
      tools={tools}
      collapsible
      t={t}
    />
    <ResearchEvidenceSection id={`${prefix}-rules`} title={t('單項規則證據', 'Rule evidence')}>
      <WorkflowValidation />
    </ResearchEvidenceSection>
    <ResearchEvidenceSection id={`${prefix}-path`} title={t('保存配置路徑', 'Saved allocation path')}>
      <WorkflowPathValidation />
    </ResearchEvidenceSection>
  </div>
)
```

上例省略既有研究元件的實際 props。主頁從 `./ResearchEvidenceSection` 匯入 wrapper，提供唯一且穩定的 ID、已翻譯的標題與捷徑短標籤、可選的一句用途；導覽元件不猜測區塊名稱，不依文字尋找目標。一般 `div`／`section` wrapper 仍可使用；風險頁可傳入公司行動預覽與歷史的兩個 wrapper。

Props：

- `workspaceRef: RefObject<HTMLElement | null>`：唯一可查找的 DOM 工作區；目標必須在其中。
- `scopeKey: string`：帳戶／來源身分。帳戶、工作流程或工作區容器替換時必須改變，讓舊引用與進行中的焦點裝飾清除。
- `tools: { targetId, label, purpose? }[]`：顯示順序與明確目標。
- `collapsible?: boolean`：預設 `false`。啟用後顯示「全部展開」與「全部收合」，只處理本導覽 tools 指定且在此工作區內唯一的 `ResearchEvidenceSection`。
- `t(zh, en)`：導覽標題與不可用原因的翻譯。

空的 tools 不渲染導覽。未找到目標時按鈕停用，旁邊顯示「此區塊目前未顯示」；工作區內同 ID 有多個目標時顯示重複識別原因。只有實際解析到唯一目標的按鈕才有 `aria-controls`。工作區外即使有同 ID，也不會被取用。

## 保留草稿的收合區塊

`ResearchEvidenceSection` 的 props 是 `id: string`、`title: ReactNode`、`children: ReactNode` 與可選的 `defaultOpen: boolean`。預設展開，保留原頁面剛進入時的行為；`defaultOpen={false}` 可指定首次掛載收合。這個值只決定首次掛載，不會在之後的父元件重繪或 prop 改變時覆蓋使用者的收合選擇。

元件始終渲染原生 `<details data-research-evidence-section>`、第一個 `<summary>`、其中的 h3 標題及完整 children。標題應為純文字或非互動內容，不要在 summary 中加入另一個按鈕或連結。瀏覽器處理 summary 的 Tab 焦點、Enter／Space 啟動及展開狀態；沒有自製鍵盤攔截、role 模擬或額外 accordion 群組。

收合只變更原生 `open` 狀態，沒有條件式卸載 children、重建 input 節點或改變 React key，因此未儲存輸入、子元件 state、已接受證據與既有請求身分保留。再次展開使用同一個 DOM 與子元件實例。這也表示收合不會暫停既有子元件的背景行為。帳戶或來源變更的重設仍由主頁既有 keys 與驗證處理，wrapper 不自行猜測帳戶身分。

「全部展開／收合」只變更 tools 明確列出的唯一、仍連接、位於 workspaceRef 內的受管理 details。未列入的區塊、一般 details、區塊內另行開關的方法說明與其他導覽的目標保持原本 open 狀態；若沒有符合條件的目標，兩個按鈕停用。控制按鈕的 `aria-controls` 只列實際受管理目標。點擊當下再次核對身分與唯一性，所以剛移除或變成重複 ID 的節點不會被修改。多組導覽可以共享工作區但指定不同 target IDs，也可以使用不同 workspaceRef；沒有全頁 details 查找或全部收合。

## 本機互動與焦點

沒有初次自動捲動、背景 fetch、路由／hash 更新、localStorage 或其他選取持久化。只有使用者明確點擊捷徑按鈕，或以原生按鈕的 Enter／Space 啟動，才會捲動與移動焦點。「全部展開／收合」不捲動、不另行移動焦點；原生 summary 依瀏覽器 disclosure 行為啟閉。

元件在提供的工作區內解析 ID，並以只監看 `childList`／`subtree` 的 MutationObserver 更新條件式掛載目標；不監看自己加上的 class 或 tabindex，因此沒有屬性回饋循環。更新可用性不會搶走正在編輯的草稿焦點。

啟動時再次檢查工作區身分、目標仍連接到頁面、包含關係與 ID 唯一性，避免 observer 尚未更新時跳到已移除或跨帳戶的舊節點。scopeKey 改變與卸載會中止舊 observer，清除舊引用與元件自己加上的 class。

捷徑先同步展開目標本身與工作區內包含它的受管理 details，確保隱藏目標可見，才捲動並移動焦點；不展開相鄰區塊或其他後代。這在沒有啟用批次收合按鈕時也有效。目標 wrapper 捲到可讀位置後，焦點移到其中第一個標題（h1–h6 或 role=heading）；`ResearchEvidenceSection` 的第一個標題就是 summary 中的 h3。沒有標題時以 wrapper 為焦點備援。沒有 tabindex 的目標暫時加 `-1`，在 blur 或卸載時移除；原有 tabindex 保留，外部在其間改過的值也不會被覆蓋。焦點使用 `preventScroll: true`，避免第二次跳動。標題的可見焦點外框只在明確導覽後出現。

預設 scroll margin 為 90px，對應面板固定頁首並留閱讀空間；整合頁可透過 `--research-evidence-scroll-offset` 覆寫。支援 `prefers-reduced-motion: reduce` 時使用 `instant`，未提供 matchMedia 時也以立即捲動處理，其他情況使用平滑捲動。

390px 寬使用兩欄可換行捷徑；批次控制可換列，summary 長標題可折行，不靠固定寬度造成橫向溢出；更窄的 340px 以下捷徑改為一欄。每個按鈕與原生 summary 都有可見鍵盤焦點。

## 這不是什麼

這不是新的頁面路由、研究執行器、結果刷新、草稿重設、背景請求暫停器或交易控制。導覽與收合本身不讀取 API、不重新計算證據、不保存選取或 open 狀態，也不替任何研究結果增加完整性、有效性或授權。區塊原有的請求、表單與來源驗證完全由既有元件處理。

測試涵蓋鍵盤與點擊、草稿／節點／子元件 state 保留、首次 defaultOpen、重繪不覆蓋原生 open 狀態、無 hash／儲存空間寫入、reduced motion、tabindex 保留與回收、多組導覽作用域隔離、巢狀收合目標先展開再聚焦、缺失／重複／晚掛載／移除目標，以及 scopeKey 改變後的舊按鈕與引用無效。jsdom 的 user-event 不會合成 summary 的 Enter／Space 原生預設動作，因此單元測試核對原生可 Tab summary、未攔截按鍵及鍵盤生成的 `detail: 0` click 路徑；實際 Enter／Space 折疊行為在瀏覽器驗證。
