"""Offline, progressively enhanced presentation of original harness completion records."""
from __future__ import annotations

import html
from uuid import uuid4


def _text(value):
    return "" if value is None else str(value)


def _escape(value):
    return html.escape(_text(value), quote=True)


_STYLE = """<style>
.harness-delivery-catalog { overflow-wrap:anywhere; }
.harness-delivery-catalog [hidden] { display:none !important; }
.harness-delivery-catalog .delivery-controls { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr) auto; gap:12px; align-items:end; margin:16px 0; }
.harness-delivery-catalog label { display:flex; flex-direction:column; gap:6px; min-width:0; }
.harness-delivery-catalog input,.harness-delivery-catalog select,.harness-delivery-catalog button { box-sizing:border-box; min-width:0; max-width:100%; min-height:44px; font:inherit; padding:8px 12px; color:inherit; background:var(--card,#fff); border:1px solid var(--line,#d9ddd9); border-radius:4px; }
.harness-delivery-catalog input,.harness-delivery-catalog select { width:100%; }
.harness-delivery-catalog button { cursor:pointer; white-space:normal; }
.harness-delivery-catalog button:disabled { opacity:.5; cursor:default; }
.harness-delivery-catalog :focus-visible { outline:2px solid var(--ok,#1d7a4f); outline-offset:3px; }
.harness-delivery-catalog .delivery-list { margin:16px 0; padding:0; list-style:none; }
.harness-delivery-catalog .delivery-item { padding:16px; margin:12px 0; border:1px solid var(--line,#d9ddd9); background:var(--card,#fff); break-inside:avoid; }
.harness-delivery-catalog .delivery-title { display:block; font-size:1rem; }
.harness-delivery-catalog .delivery-original { white-space:pre-wrap; }
.harness-delivery-catalog .delivery-item p { margin:8px 0; }
.harness-delivery-catalog .delivery-category,.harness-delivery-catalog .delivery-count { color:var(--muted,#5d6763); }
.harness-delivery-catalog summary { cursor:pointer; padding:8px 0; }
.harness-delivery-catalog .delivery-pagination { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
.harness-delivery-catalog .delivery-print-evidence,.harness-delivery-catalog .delivery-print-count { display:none; }
@media(max-width:600px) { .harness-delivery-catalog .delivery-controls { grid-template-columns:minmax(0,1fr); } }
@media print {
  .harness-delivery-catalog .delivery-controls,.harness-delivery-catalog .delivery-pagination,.harness-delivery-catalog .delivery-count,.harness-delivery-catalog .delivery-empty,.harness-delivery-catalog details { display:none !important; }
  .harness-delivery-catalog .delivery-item[hidden] { display:list-item !important; }
  .harness-delivery-catalog .delivery-print-evidence,.harness-delivery-catalog .delivery-print-count { display:block !important; }
  .harness-delivery-catalog .delivery-item { background:transparent; color:inherit; }
}
</style>"""

# Original text is only emitted into escaped HTML text nodes. This fixed script
# reads those nodes and changes visibility/textContent; it never parses a payload
# as markup and cannot be terminated by a completion record containing </script>.
_SCRIPT = """<script>
(() => {
  const root = document.currentScript.parentElement;
  const controls = root.querySelector('[data-delivery-controls]');
  const search = root.querySelector('[data-delivery-search]');
  const category = root.querySelector('[data-delivery-category-filter]');
  const reset = root.querySelector('[data-delivery-reset]');
  const previous = root.querySelector('[data-delivery-previous]');
  const next = root.querySelector('[data-delivery-next]');
  const pagination = root.querySelector('[data-delivery-pagination]');
  const pageLabel = root.querySelector('[data-delivery-page]');
  const count = root.querySelector('[data-delivery-count]');
  const empty = root.querySelector('[data-delivery-empty]');
  const items = [...root.querySelectorAll('[data-delivery-item]')].map(node => ({
    node,
    category: node.dataset.deliveryCategory,
    query: [...node.querySelectorAll('[data-delivery-searchable]')]
      .map(part => part.textContent).join('\\n').toLocaleLowerCase()
  }));
  const pageSize = 12;
  let page = 0;
  function update() {
    const query = search.value.trim().toLocaleLowerCase();
    const matches = items.filter(item =>
      (category.value === 'all' || item.category === category.value) && item.query.includes(query));
    const pages = Math.ceil(matches.length / pageSize);
    page = Math.min(page, Math.max(0, pages - 1));
    const first = page * pageSize;
    const visible = new Set(matches.slice(first, first + pageSize));
    for (const item of items) item.node.hidden = !visible.has(item);
    count.textContent = '符合 ' + matches.length + ' / ' + items.length + ' 筆 · 顯示 ' +
      (matches.length ? first + 1 : 0) + '–' + (first + visible.size) + ' · 每頁 12 筆';
    pageLabel.textContent = '第 ' + (pages ? page + 1 : 0) + ' / ' + pages + ' 頁';
    previous.disabled = page === 0;
    next.disabled = pages === 0 || page >= pages - 1;
    reset.disabled = search.value === '' && category.value === 'all';
    empty.hidden = matches.length !== 0;
    empty.textContent = items.length ? '沒有符合條件的完成單位；原始清單保持完整。' : '尚無完成單位。';
  }
  function filter() { page = 0; update(); }
  search.addEventListener('input', filter);
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') event.preventDefault();
  });
  category.addEventListener('change', filter);
  reset.addEventListener('click', () => { search.value = ''; category.value = 'all'; filter(); });
  previous.addEventListener('click', () => { page = Math.max(0, page - 1); update(); });
  next.addEventListener('click', () => { page += 1; update(); });
  update();
  controls.hidden = false;
  pagination.hidden = false;
})();
</script>"""


def render_delivery_catalog(completed: list) -> str:
    """Render every record unchanged; optional category is explicit, never inferred.

    No source, evidence, status or category is interpreted as a verification
    claim. Missing categories form a distinct UI-only uncategorized group.
    Each call has its own IDs and DOM-scoped controls, including offline file URLs.
    """
    identifier = "delivery-catalog-" + uuid4().hex
    records, categories = [], {}
    for value in completed:
        item = value if isinstance(value, dict) else {"title": value}
        title = _text(item.get("title") or item.get("unit") or "")
        detail = _text(item.get("detail"))
        raw_evidence = item.get("evidence")
        evidence = "；".join(_text(part) for part in raw_evidence) if isinstance(raw_evidence, list) else _text(raw_evidence)
        status = _text(item.get("status"))
        # Whitespace, case and the supplied category label remain intact.
        category = _text(item.get("category"))
        if category not in categories:
            categories[category] = "category-" + str(len(categories))
        records.append((title, detail, evidence, status, category))

    rows = []
    for index, (title, detail, evidence, status, category) in enumerate(records):
        label = f'<p class="delivery-category">分類：<span data-delivery-searchable>{_escape(category)}</span></p>' if category else ""
        description = f'<p class="delivery-original" data-delivery-searchable>{_escape(detail)}</p>' if detail else ""
        original_status = f'<p class="delivery-original">狀態：{_escape(status)}</p>' if status else ""
        proof = (f'<details><summary>展開原始驗收紀錄</summary>'
                 f'<p class="delivery-original" data-delivery-searchable>{_escape(evidence)}</p></details>'
                 f'<div class="delivery-print-evidence" aria-hidden="true"><strong>原始驗收紀錄</strong>'
                 f'<p class="delivery-original">{_escape(evidence)}</p></div>') if evidence else ""
        rows.append(f'<li class="delivery-item" data-delivery-item data-delivery-index="{index}" '
                    f'data-delivery-category="{categories[category]}">'
                    f'<strong class="delivery-title delivery-original" data-delivery-searchable>{_escape(title)}</strong>'
                    f'{label}{description}{original_status}{proof}</li>')
    options = '<option value="all">全部類別</option>' + ''.join(
        f'<option value="{key}">{"分類：" + _escape(label) if label else "未分類（原紀錄未提供）"}</option>'
        for label, key in categories.items())
    total = len(records)
    return (
        _STYLE + f'<div class="harness-delivery-catalog" id="{identifier}" role="region" aria-label="完成單位查詢">'
        '<p>搜尋與分類只改變這份清單的顯示，不改寫完成內容或判定驗收狀態。列印保留全部紀錄。</p>'
        f'<div class="delivery-controls" data-delivery-controls hidden>'
        f'<label for="{identifier}-search">搜尋完成單位（標題、內容、驗收紀錄、分類）'
        f'<input id="{identifier}-search" data-delivery-search type="search" autocomplete="off" '
        f'aria-controls="{identifier}-list"></label>'
        f'<label for="{identifier}-category">分類'
        f'<select id="{identifier}-category" data-delivery-category-filter aria-controls="{identifier}-list">'
        f'{options}</select></label><button type="button" data-delivery-reset>重設篩選</button></div>'
        f'<p class="delivery-count" data-delivery-count role="status" aria-live="polite">全部 {total} / {total} 筆；未啟用分頁。</p>'
        f'<p class="delivery-print-count">完整清單：{total} 筆。</p>'
        f'<ul class="delivery-list" id="{identifier}-list">{"".join(rows)}</ul>'
        f'<p class="delivery-empty" data-delivery-empty{" hidden" if total else ""}>尚無完成單位。</p>'
        '<div class="delivery-pagination" data-delivery-pagination role="group" aria-label="完成單位分頁" hidden>'
        f'<button type="button" data-delivery-previous aria-controls="{identifier}-list">上一頁</button>'
        '<span data-delivery-page></span>'
        f'<button type="button" data-delivery-next aria-controls="{identifier}-list">下一頁</button></div>'
        '<noscript><p>未啟用指令碼；全部原始紀錄仍可閱讀、展開驗收內容及列印。</p></noscript>'
        + _SCRIPT + '</div>'
    )
