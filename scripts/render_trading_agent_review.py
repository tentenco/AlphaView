"""Render a self-contained review page for a Trading Agent harness folder.

Reads state.json, events.jsonl and optional benchmark.json / gates.json from the
folder and writes review.html next to them. The self-contained review form
stores selections in this browser and exports a text handoff; no network
requests or execution actions. Private workspace data is never read.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

if __package__:
    from .harness_review_catalog import render_delivery_catalog
else:
    from harness_review_catalog import render_delivery_catalog

TAIPEI = ZoneInfo("Asia/Taipei")


def esc(value):
    return html.escape("" if value is None else str(value))


def local(value):
    if not value:
        return "—"
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(TAIPEI).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(value)


def lines(path):
    rows, broken = [], 0
    if not path.exists():
        return rows, broken
    for raw in path.read_text().splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            rows.append(json.loads(raw))
        except json.JSONDecodeError:
            broken += 1
    return rows, broken


def items(values, empty):
    if not values:
        return f"<p class='muted'>{esc(empty)}</p>"
    parts = []
    for value in values:
        if isinstance(value, dict):
            title = esc(value.get("title") or value.get("unit") or "")
            detail = esc(value.get("detail") or "")
            evidence = value.get("evidence") or []
            evidence = "；".join(str(item) for item in evidence) if isinstance(evidence, list) else str(evidence)
            status = esc(value.get("status") or "")
            parts.append(f"<li><strong>{title}</strong>{f'<p>{detail}</p>' if detail else ''}"
                         f"{f'<p><small>{esc(evidence)}</small></p>' if evidence else ''}"
                         f"{f'<p><small>狀態：{status}</small></p>' if status else ''}</li>")
        else:
            parts.append(f"<li>{esc(value)}</li>")
    return "<ul>" + "".join(parts) + "</ul>"


def review_form(state):
    tasks = []
    for value in state.get("next_tasks", []):
        item = value if isinstance(value, dict) else {"title": str(value)}
        title = str(item.get("title", ""))
        tasks.append({"id": str(item.get("id") or hashlib.sha256(title.encode()).hexdigest()[:16]),
                      "title": title, "detail": str(item.get("detail") or ""),
                      "start_from": str(item.get("start_from") or ""),
                      "acceptance": [str(value) for value in item.get("acceptance", [])[:8]]
                      if isinstance(item.get("acceptance"), list) else []})
    rows = ""
    for task in tasks:
        criteria = ""
        if task["start_from"] or task["acceptance"]:
            criteria = "<details><summary>接續位置與驗收條件</summary>"
            if task["start_from"]:
                criteria += f"<p>接續位置：{esc(task['start_from'])}</p>"
            criteria += "<ul>" + "".join(f"<li>{esc(value)}</li>" for value in task["acceptance"]) + "</ul></details>"
        rows += (f"<li><label><input type='checkbox' data-task-id='{esc(task['id'])}'> "
                 f"<strong>{esc(task['title'])}</strong></label><p>{esc(task['detail'])}</p>{criteria}</li>")
    payload = json.dumps({"run": state.get("run_id") or state.get("started_at") or "review",
                          "title": state.get("title") or "Agent Harness Review", "tasks": tasks,
                          "started_at": state.get("started_at"), "deadline": state.get("deadline")}, ensure_ascii=False)
    # JSON is data inside a script element; escaping '<' prevents a task title
    # from closing that element, including when a saved task contains HTML.
    payload = payload.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    markup = f"""<p>勾選下一輪候選事項並留下驗收意見。選擇只保存在這個瀏覽器；下載後可交給下一輪 Agent，不會自行啟動工作。</p>
<ul class="review-tasks">{rows or '<li class="muted">工作仍在進行，下一輪候選事項尚待整理。</li>'}</ul>
<label class="notes-label" for="review-notes">你的驗收意見／優先順序</label>
<textarea id="review-notes" rows="6" placeholder="例如：先處理第 2 項；第 1 項需要補充這個測試…"></textarea>
<div class="review-actions"><button type="button" id="download-review">下載檢閱意見 .md</button><button type="button" id="download-tasks" disabled>下載所選任務 JSON</button><span role="status" id="review-status" aria-live="polite"></span></div>
<style>.review-import {{min-width:0;margin-top:1rem;padding:1rem;border:1px solid #68747e;border-radius:.5rem;overflow-wrap:anywhere}}.review-import label,.review-import input {{display:block;max-width:100%;box-sizing:border-box}}.review-import input {{width:100%;margin:.5rem 0 1rem}}.review-import button {{max-width:100%;white-space:normal}}.review-import pre {{white-space:pre-wrap;overflow-wrap:anywhere;max-height:16rem;overflow:auto;font:inherit}}@media print {{.review-import {{display:none}}}}</style>
<fieldset class="review-import">
<legend>載入先前檢閱草稿</legend>
<p id="review-import-help">選擇先前下載的所選任務 JSON，先檢查預覽，再按「載入檢閱草稿」取代目前勾選與備註。檔案只在本機讀取；不會啟動工作或授權外部操作。任務依本頁定義，依賴事項仍由你決定。</p>
<label for="review-import-file">先前下載的所選任務 JSON（上限 1 MiB）</label>
<input id="review-import-file" type="file" accept=".json,application/json" aria-describedby="review-import-help" disabled>
<div id="review-import-preview" hidden aria-live="polite">
<p id="review-import-summary"></p><ul id="review-import-tasks"></ul>
<p>即將載入的驗收意見／優先順序：</p><pre id="review-import-notes"></pre>
</div>
<button type="button" id="restore-review" disabled>載入檢閱草稿</button>
</fieldset>
<noscript><p>瀏覽器未啟用指令碼；仍可閱讀與列印本頁，勾選結果不會保存。</p></noscript>
<script type="application/json" id="review-data">{payload}</script>
<script>
(() => {{
  const data = JSON.parse(document.getElementById('review-data').textContent);
  const key = 'alphaview-harness-review:' + data.run;
  const notes = document.getElementById('review-notes');
  const status = document.getElementById('review-status');
  const boxes = [...document.querySelectorAll('[data-task-id]')];
  const taskDownload = document.getElementById('download-tasks');
  let storageAvailable = true;
  try {{
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && Array.isArray(saved.selected)) {{
      for (const box of boxes) box.checked = saved.selected.includes(box.dataset.taskId);
      notes.value = typeof saved.notes === 'string' ? saved.notes : '';
      status.textContent = '已載入此瀏覽器的檢閱草稿。';
    }}
  }} catch {{ storageAvailable = false; status.textContent = '瀏覽器無法保存草稿，請下載檢閱意見。'; }}
  function selection() {{ return boxes.filter(box => box.checked).map(box => box.dataset.taskId); }}
  taskDownload.disabled = selection().length === 0;
  function save() {{
    taskDownload.disabled = selection().length === 0;
    try {{
      localStorage.setItem(key, JSON.stringify({{selected: selection(), notes: notes.value}}));
      storageAvailable = true; status.textContent = '檢閱草稿已保存在此瀏覽器。';
    }} catch {{ storageAvailable = false; status.textContent = '瀏覽器無法保存草稿，請下載檢閱意見。'; }}
  }}
  const importFile = document.getElementById('review-import-file');
  const restoreButton = document.getElementById('restore-review');
  const preview = document.getElementById('review-import-preview');
  const previewSummary = document.getElementById('review-import-summary');
  const previewTasks = document.getElementById('review-import-tasks');
  const previewNotes = document.getElementById('review-import-notes');
  const maxImportBytes = 1024 * 1024;
  const maxNotesLength = 20000;
  const knownTasks = new Map(data.tasks.map(task => [task.id, task]));
  let importGeneration = 0, importReader = null, importDraft = null;
  function clearPreview() {{
    importDraft = null;
    restoreButton.disabled = true;
    preview.hidden = true;
    previewSummary.textContent = '';
    previewTasks.replaceChildren();
    previewNotes.textContent = '';
  }}
  function exactKeys(value, fields) {{
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === fields.length &&
      fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }}
  function boundedText(value, limit) {{ return typeof value === 'string' && value.length <= limit; }}
  function finiteTree(value) {{
    if (typeof value === 'number') return Number.isFinite(value);
    if (value && typeof value === 'object') return Object.values(value).every(finiteTree);
    return true;
  }}
  function validateDraft(value) {{
    const fields = ['format_version', 'kind', 'source_run', 'source_title', 'source_started_at',
      'source_deadline', 'exported_at', 'execution_requested', 'external_actions_authorized',
      'tasks', 'review_notes', 'notice'];
    if (!exactKeys(value, fields) || !finiteTree(value) || value.format_version !== 1 ||
        value.kind !== 'harness-review-task-selection' || value.source_run !== data.run ||
        value.execution_requested !== false || value.external_actions_authorized !== false ||
        !boundedText(value.source_title, 4096) || !boundedText(value.notice, 4096) ||
        !boundedText(value.review_notes, maxNotesLength) ||
        !['source_started_at', 'source_deadline'].every(field => value[field] === null || boundedText(value[field], 256)) ||
        !boundedText(value.exported_at, 32) || !/^\\d{{4}}-\\d{{2}}-\\d{{2}}T\\d{{2}}:\\d{{2}}:\\d{{2}}\\.\\d{{3}}Z$/.test(value.exported_at) ||
        !Number.isFinite(Date.parse(value.exported_at)) || new Date(value.exported_at).toISOString() !== value.exported_at ||
        !Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > data.tasks.length ||
        knownTasks.size !== data.tasks.length) throw new Error('invalid_review_draft');
    const selected = new Set();
    for (const task of value.tasks) {{
      if (!exactKeys(task, ['id', 'title', 'detail', 'start_from', 'acceptance']) ||
          typeof task.id !== 'string' || !knownTasks.has(task.id) || selected.has(task.id) ||
          !['title', 'detail', 'start_from'].every(field => boundedText(task[field], 20000)) ||
          !Array.isArray(task.acceptance) || task.acceptance.length > 8 ||
          !task.acceptance.every(item => boundedText(item, 20000))) throw new Error('invalid_review_task');
      selected.add(task.id);
    }}
    // Only IDs and plain notes are restored. All task descriptions come from this page.
    return {{selected, notes: value.review_notes}};
  }}
  importFile.disabled = false;
  importFile.addEventListener('change', () => {{
    const generation = ++importGeneration;
    if (importReader) importReader.abort();
    importReader = null;
    clearPreview();
    const files = importFile.files;
    if (!files || files.length === 0) {{ status.textContent = '尚未選擇草稿；目前勾選與備註未變更。'; return; }}
    if (files.length !== 1 || files[0].size <= 0 || files[0].size > maxImportBytes) {{
      status.textContent = '草稿未載入：請選擇一個不超過 1 MiB 的 JSON 檔案。目前勾選與備註未變更。'; return;
    }}
    const reader = new FileReader();
    importReader = reader;
    status.textContent = '正在本機檢查草稿；目前勾選與備註未變更。';
    reader.onload = () => {{
      if (generation !== importGeneration) return;
      importReader = null;
      try {{
        if (typeof reader.result !== 'string' || new Blob([reader.result]).size > maxImportBytes) throw new Error('invalid_review_size');
        const draft = validateDraft(JSON.parse(reader.result));
        importDraft = draft;
        previewSummary.textContent = '來源 Run：' + data.run + '；將載入 ' + draft.selected.size +
          ' 項候選工作、' + draft.notes.length + ' 字元備註。任務文字採用本頁版本；尚未套用。';
        for (const task of data.tasks.filter(task => draft.selected.has(task.id))) {{
          const item = document.createElement('li'); item.textContent = task.title; previewTasks.appendChild(item);
        }}
        previewNotes.textContent = draft.notes || '（沒有備註）';
        preview.hidden = false;
        restoreButton.disabled = false;
        status.textContent = '草稿已通過檢查。請檢查預覽，再按「載入檢閱草稿」取代目前勾選與備註；尚未啟動工作。';
      }} catch {{
        clearPreview();
        status.textContent = '草稿未載入：格式、來源 Run、任務識別、授權旗標或備註不符合要求。目前勾選與備註未變更。';
      }}
    }};
    reader.onerror = () => {{
      if (generation !== importGeneration) return;
      importReader = null; clearPreview();
      status.textContent = '草稿未載入：無法讀取本機檔案。目前勾選與備註未變更。';
    }};
    reader.readAsText(files[0], 'utf-8');
  }});
  restoreButton.addEventListener('click', () => {{
    if (!importDraft || restoreButton.disabled) return;
    const draft = importDraft;
    for (const box of boxes) box.checked = draft.selected.has(box.dataset.taskId);
    notes.value = draft.notes;
    save();
    clearPreview(); importFile.value = '';
    status.textContent = '已載入檢閱草稿；' +
      (storageAvailable ? '已保存在此瀏覽器。' : '瀏覽器無法保存，請下載檢閱意見。') +
      '沒有啟動工作或授權外部操作；依賴事項仍由你決定。';
  }});
  taskDownload.addEventListener('click', () => {{
    const selected = new Set(selection());
    if (!selected.size) return;
    const payload = {{
      format_version: 1, kind: 'harness-review-task-selection',
      source_run: data.run, source_title: data.title,
      source_started_at: data.started_at, source_deadline: data.deadline,
      exported_at: new Date().toISOString(),
      execution_requested: false, external_actions_authorized: false,
      tasks: data.tasks.filter(task => selected.has(task.id)),
      review_notes: notes.value,
      notice: '這是下一輪候選事項，必須由使用者另行指定工作範圍；匯出不會啟動Agent或授權外部操作。'
    }};
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2) + '\\n'], {{type: 'application/json;charset=utf-8'}}));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = String(data.run).replace(/[^a-zA-Z0-9_-]/g, '_') + '-selected-tasks.json';
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = '所選任務已匯出；下一輪尚未啟動。';
  }});
  for (const box of boxes) box.addEventListener('change', save);
  notes.addEventListener('input', save);
  document.getElementById('download-review').addEventListener('click', () => {{
    const selected = new Set(selection());
    const lines = ['# ' + data.title + ' · 使用者檢閱', '', 'Run: ' + data.run,
      '匯出時間: ' + new Date().toISOString(), '', '## 下一輪候選工作', ''];
    for (const task of data.tasks) {{
      lines.push('- [' + (selected.has(task.id) ? 'x' : ' ') + '] ' + task.title);
      if (task.detail) lines.push('  ' + task.detail);
      if (task.start_from) lines.push('  接續位置：' + task.start_from);
      for (const criterion of task.acceptance) lines.push('  - 驗收：' + criterion);
    }}
    lines.push('', '## 驗收意見與優先順序', '', notes.value || '（尚未填寫）', '',
      '這份檢閱不會自行啟動工作，也不授權外部操作。', '');
    const url = URL.createObjectURL(new Blob([lines.join('\\n')], {{type: 'text/markdown;charset=utf-8'}}));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = String(data.run).replace(/[^a-zA-Z0-9_-]/g, '_') + '-user-review.md';
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = storageAvailable ? '檢閱意見已匯出；草稿仍保留。' : '檢閱意見已匯出。';
  }});
}})();
</script>"""
    return markup


def screenshot_gallery(folder, state):
    cards = []
    for shot in state.get("review_screenshots", [])[:12]:
        name = shot.get("file", "")
        if not isinstance(name, str) or not re.fullmatch(r"[\w.-]+\.(?:png|jpg|jpeg|webp)", name):
            continue
        path = folder / name
        if not path.is_file() or path.is_symlink() or path.stat().st_size > 2_000_000:
            continue
        mime = "jpeg" if path.suffix in (".jpg", ".jpeg") else path.suffix[1:]
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        title = esc(shot.get("title") or name)
        cards.append(
            f"<figure><figcaption><strong>{title}</strong><p>{esc(shot.get('detail'))}</p></figcaption>"
            f"<details><summary>展開畫面</summary><img loading='lazy' src='data:image/{mime};base64,{data}' "
            f"alt='{title}'></details></figure>")
    if not cards:
        return ""
    return ("<section id='screenshots'><h2>實際操作畫面</h2>"
            "<p>以下皆使用本機合成資料，已由主代理檢查；不同功能使用各自隔離的測試帳戶。"
            "圖片嵌在這份 HTML，離線也能檢閱。完整操作結果與限制見驗收紀錄。</p>"
            "<div class='screenshot-grid'>" + "".join(cards) + "</div></section>")


def render(folder: Path):
    state = json.loads((folder / "state.json").read_text())
    events, broken = lines(folder / "events.jsonl")
    benchmark = json.loads((folder / "benchmark.json").read_text()) if (folder / "benchmark.json").exists() else None
    gates = json.loads((folder / "gates.json").read_text()) if (folder / "gates.json").exists() else None
    status_label = {"scheduled": "已排程", "running": "開發中", "deadline_reached": "已到時限，停止新功能", "complete": "已設斷點，等待檢閱"}.get(state.get("status"), state.get("status"))
    kinds = {"completed": "完成", "started": "開始", "decision": "決策", "interruption": "中斷", "note": "紀錄", "start": "啟動", "stop": "停止", "gates": "驗收"}
    kinds.update({"done": "完成", "running": "進行中", "deferred": "延後", "failed": "失敗", "replan": "重新規劃", "replanned": "重新規劃", "deadline": "到達時限"})

    def evidence_text(e):
        value = e.get("evidence")
        return "；".join(str(v) for v in value) if isinstance(value, list) else (value or e.get("detail") or "")

    done_rows = "".join(
        f"<tr><td>{esc(local(e.get('at')))}</td><td>{esc(e.get('unit') or '')}</td><td>{esc(e.get('owner') or '')}</td>"
        f"<td>{esc(e.get('note') or e.get('title') or '')}</td><td><small>{esc(evidence_text(e))}</small></td></tr>"
        for e in events if (e.get('status') or e.get('kind') or e.get('type')) in ('done', 'completed'))
    delivered_table = (f"<div class='scroll'><table><thead><tr><th>時間</th><th>單位</th><th>負責</th><th>內容</th><th>證據</th></tr></thead><tbody>{done_rows}</tbody></table></div>"
                       if done_rows else "<p class='muted'>事件帳本沒有完成紀錄。</p>")
    if state.get("compact_review"):
        delivered_table = "<details><summary>依時間展開完成紀錄與驗收證據</summary>" + delivered_table + "</details>"
    event_rows = "".join(
        f"<tr><td>{esc(local(e.get('at')))}</td><td>{esc(kinds.get(e.get('kind') or e.get('status') or e.get('type'), e.get('kind') or e.get('status') or e.get('type')))}</td><td>{esc(e.get('unit') or '')}</td>"
        f"<td>{esc(e.get('title') or e.get('note') or '')}{f'<br><small>{esc(evidence_text(e))}</small>' if e.get('evidence') or e.get('detail') else ''}</td></tr>"
        for e in events)
    event_open = "<details><summary>展開完整時間序列</summary>" if state.get("compact_review") else ""
    event_close = "</details>" if state.get("compact_review") else ""
    completed = state.get("completed", [e for e in events if e.get("kind") == "completed"])
    prior_html = ""
    prior = state.get("prior_conclusion", [])
    if prior:
        rows = "".join(
            f"<tr><td>{esc(item.get('id'))}</td><td>{esc(item.get('title'))}</td>"
            f"<td><strong>{esc(item.get('status'))}</strong><br>{esc(item.get('delivered'))}</td>"
            f"<td>{esc(item.get('remaining'))}</td></tr>" for item in prior)
        prior_html = (
            "<section id='prior'><h2>上輪 Conclusion 逐項對照</h2>"
            f"<p>接續 {esc(state.get('prior_conclusion_label') or '上一輪')} 的 {len(prior)} 項建議。完成單位數是本輪的交付紀錄，各項尚未涵蓋的範圍列在右欄。</p>"
            "<div class='scroll'><table><thead><tr><th>#</th><th>原始建議</th><th>本輪進展</th>"
            f"<th>仍需處理</th></tr></thead><tbody>{rows}</tbody></table></div></section>")
    bench_html = ""
    if benchmark:
        gap_status = state.get("benchmark_gap_status", {})
        deep = set(benchmark.get("deep_dive_repos", []))

        def delta(r):
            prior = r.get("stars_prior_2026_09_20")
            return "" if prior in (None, "") else f" <span class='muted'>({int(r.get('stars', 0)) - int(prior):+,} vs 09-20)</span>"

        repos = "".join(
            f"<tr><td><a href='{esc(r.get('url'))}'>{esc(r.get('name'))}</a>{' <strong>★</strong>' if r.get('name') in deep else ''}</td>"
            f"<td>{esc(f"{int(r.get('stars', 0)):,}")}{delta(r)}</td><td>{esc(r.get('license'))}</td>"
            f"<td>{esc(r.get('category_zh') or r.get('category'))}</td><td>{esc(r.get('tier'))}</td>"
            f"<td>{esc('；'.join(r.get('notable_features', [])[:3]))}</td></tr>"
            for r in sorted(benchmark.get("repos", []), key=lambda r: -int(r.get("stars", 0))))
        gaps = "".join(
            f"<tr><td>{esc(g.get('rank'))}</td><td><strong>{esc(g.get('title'))}</strong><br><span class='muted'>{esc(g.get('what', ''))}</span></td>"
            f"<td>{esc('；'.join(g.get('best_in', [])) if isinstance(g.get('best_in'), list) else g.get('best_in'))}</td>"
            f"<td>{esc(g.get('value'))}×{esc(g.get('feasibility'))}={esc(g.get('score'))}</td><td>{esc(g.get('effort'))}</td>"
            f"<td>{esc(g.get('mapping'))}<br><span class='muted'>{esc(g.get('caveat', ''))}</span></td>"
            f"<td>{esc(gap_status.get(str(g.get('rank')), '未排入'))}</td></tr>"
            for g in benchmark.get("gaps", []))
        bench_html = (
            f"<section id='benchmark'><h2>對標：熱門同類專案</h2>"
            f"<p class='muted'>方法 {esc(benchmark.get('method'))}；查核時間 {esc(benchmark.get('fetched_at'))}（{esc(benchmark.get('fetched_window_utc'))}）；"
            f"star 數來源 {esc(benchmark.get('stars_source'))}；★ 為深入對標的專案。{esc(benchmark.get('note', ''))}</p>"
            f"<div class='scroll'><table><thead><tr><th>專案</th><th>Stars</th><th>授權</th><th>類別</th><th>Tier</th><th>特色</th></tr></thead><tbody>{repos}</tbody></table></div>"
            f"<h3>高價值缺口排序（{esc(benchmark.get('scoring'))}）</h3>"
            f"<div class='scroll'><table><thead><tr><th>#</th><th>缺口</th><th>參考</th><th>價值×可行</th><th>工作量</th><th>對應 AlphaView</th><th>本輪狀態</th></tr></thead><tbody>{gaps}</tbody></table></div></section>")
    gates_html = ""
    if gates:
        def gate_log(gate):
            path = gate.get("log")
            return f" <a href='{esc(path)}'>完整輸出</a>" if isinstance(path, str) and re.fullmatch(r"gate-logs/[\w.-]+\.log", path) else ""

        rows = "".join(f"<tr><td>{esc(g.get('gate'))}</td><td class='{'ok' if g.get('passed') else 'bad'}'>{'通過' if g.get('passed') else '未通過'}</td><td>{esc(g.get('summary'))}{gate_log(g)}</td></tr>" for g in gates.get("results", []))
        gates_html = f"<section id='gates'><h2>驗收關卡</h2><p class='muted'>執行於 {esc(local(gates.get('at')))}。</p><table><thead><tr><th>關卡</th><th>結果</th><th>摘要</th></tr></thead><tbody>{rows}</tbody></table></section>"
    checkpoint_links = []
    for filename, label in (
        ("source-checkpoint.zip", "下載來源斷點 ZIP"),
        ("source-manifest.json", "來源檔案與 SHA-256"),
        ("run-change-manifest.json", "相對本輪起點的改動"),
        ("state.json", "任務狀態"),
        ("events.jsonl", "完整事件帳本"),
        ("gates.json", "五道關卡結果"),
        ("handoff.md", "下一個session交接文件"),
        ("browser-evidence.zip", "合成操作原件與畫面 ZIP"),
        ("browser-evidence-manifest.json", "操作原件 SHA-256 清單"),
    ):
        candidate = folder / filename
        if candidate.is_file() and not candidate.is_symlink():
            checkpoint_links.append(f'<li><a href="{filename}" download>{label}</a></li>')
    checkpoint_html = (
        '<section id="checkpoint"><h2>斷點檔案</h2>'
        '<p>來源 ZIP 保存這個工作樹的未提交來源，包含開始前既有改動；'
        '相對起點的改動另列於 manifest。這不是完整 checkout 或資料庫備份，沒有自動還原動作。</p>'
        '<ul>' + ''.join(checkpoint_links) + '</ul></section>'
    ) if checkpoint_links else ''
    changes_html = ""
    changes_path = folder / "run-change-manifest.json"
    if changes_path.is_file() and not changes_path.is_symlink():
        changes = json.loads(changes_path.read_text())
        change_names = {"added": "新增", "modified": "修改", "deleted": "刪除"}
        change_rows = "".join(
            f"<tr><td><code>{esc(row.get('path'))}</code></td>"
            f"<td>{esc(change_names.get(row.get('change'), row.get('change')))}</td>"
            f"<td>{'開始前已有未提交內容' if row.get('preexisting_dirty_path') else '本輪開始後變更'}</td></tr>"
            for row in changes.get("files", [])
        )
        counts = changes.get("counts", {})
        changes_html = (
            '<section id="source-changes"><h2>本輪來源改動</h2>'
            '<p>以開始時保存的工作樹為起點；不把開始前既有的未提交內容算成本輪開發。'
            f"新增 {esc(counts.get('added', 0))}、修改 {esc(counts.get('modified', 0))}、刪除 {esc(counts.get('deleted', 0))} 個檔案。"
            '來源 ZIP 另外保留完整的未提交來源快照，兩者檔案數不同。</p>'
            f"<p class='muted'>比較快照時間：{esc(local(changes.get('current_checkpoint_at')))}。</p>"
            '<details><summary>展開檔案清單</summary><div class="scroll"><table>'
            '<thead><tr><th>檔案</th><th>本輪改動</th><th>起點狀態</th></tr></thead>'
            f'<tbody>{change_rows}</tbody></table></div></details></section>'
        )
    guide_path = folder / "research-evidence-guide.html"
    guide_html = (
        '<section id="guide"><h2>研究證據使用指南</h2>'
        '<p>從保存工作流、路徑分析、執行情境到封存預檢，依畫面按鈕找到工具；'
        '區分缺值、過期、損壞與哪些內容已保存。</p>'
        '<p><a href="research-evidence-guide.html">開啟離線使用指南</a></p></section>'
    ) if guide_path.is_file() and not guide_path.is_symlink() else ''
    contracts_path = folder / "next-round-contracts.html"
    contracts_html = (
        '<section id="method-drafts"><h2>下一輪方法草稿 · 尚未實作</h2>'
        '<p>本輪另完成事前試驗登錄與Portfolio Validation v2的契約草稿，'
        '包含固定分母、時間邊界、重試／中斷與合成驗收設計。'
        '它們不計入本輪完成單位，也不代表登錄、CPCV或完整搜尋PBO已完成。</p>'
        '<p><a href="next-round-contracts.html">閱讀兩份完整離線契約草稿</a></p></section>'
    ) if contracts_path.is_file() and not contracts_path.is_symlink() else ''
    next_tasks = review_form(state)
    screenshots = screenshot_gallery(folder, state)
    interruptions = "".join(f"<li>{esc(local(i.get('from')))} → {esc(local(i.get('to')))}：{esc(i.get('cause'))}</li>" for i in state.get("interruptions", []))
    document = f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(state.get('title', 'AlphaView Harness Review'))}</title>
<style>:root{{color-scheme:light dark;--bg:#fbfaf7;--fg:#1c1f1e;--muted:#5d6763;--line:#d9ddd9;--ok:#1d7a4f;--bad:#b3261e;--card:#ffffff}}@media(prefers-color-scheme:dark){{:root{{--bg:#101312;--fg:#e8eceb;--muted:#9fb0a8;--line:#34403a;--ok:#78d5ad;--bad:#ff8a80;--card:#151b18}}}}
*{{box-sizing:border-box}}body{{margin:0 auto;max-width:1160px;padding:40px 24px 80px;font-family:ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--fg);line-height:1.6;overflow-wrap:anywhere}}h1{{font-size:clamp(28px,5vw,44px);letter-spacing:-.03em;margin:8px 0}}h2{{margin-top:40px;border-bottom:1px solid var(--line);padding-bottom:8px}}h3{{margin-top:24px}}.eyebrow{{font-size:12px;letter-spacing:.08em;color:var(--muted)}}.muted{{color:var(--muted)}}.stats{{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:24px 0}}.stat{{border:1px solid var(--line);background:var(--card);padding:16px}}.stat strong{{display:block;font-size:20px;margin-top:6px}}table{{width:100%;border-collapse:collapse;font-size:14px}}th,td{{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}}.scroll{{overflow-x:auto}}ul{{padding-left:20px}}li{{margin:8px 0}}li p{{margin:4px 0;color:var(--muted);font-size:14px}}.ok{{color:var(--ok);font-weight:600}}.bad{{color:var(--bad);font-weight:600}}label,summary{{cursor:pointer}}summary{{padding:8px 0}}nav a{{margin-right:16px}}.review-tasks{{list-style:none;padding:0}}.review-tasks li{{border:1px solid var(--line);background:var(--card);padding:16px;margin:12px 0}}.review-tasks label{{display:flex;gap:10px;align-items:baseline}}.notes-label{{display:block;font-weight:600;margin:24px 0 8px}}textarea{{box-sizing:border-box;width:100%;max-width:100%;font:inherit;padding:12px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--fg)}}.review-actions{{display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-top:12px}}button{{font:inherit;padding:10px 16px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--fg);cursor:pointer}}button:disabled{{opacity:.45;cursor:not-allowed}}input[type=checkbox]{{width:18px;height:18px;accent-color:var(--ok)}}a,button,input,textarea{{outline-offset:4px}}:focus-visible{{outline:2px solid var(--ok)}}.review-tasks p{{margin-left:28px}}a{{color:var(--ok)}}small{{color:var(--muted)}}.screenshot-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:20px}}.screenshot-grid figure{{margin:0;padding:16px;border:1px solid var(--line);background:var(--card)}}.screenshot-grid figcaption p{{font-size:14px;color:var(--muted)}}.screenshot-grid img{{display:block;width:100%;max-width:390px;height:auto;margin:16px auto 0;border:1px solid var(--line)}}.screenshot-grid summary{{cursor:pointer;color:var(--ok)}}@media(max-width:600px){{body{{padding:24px 16px}}}}</style></head><body>
<header><div class="eyebrow">ALPHAVIEW / TRADING AGENT HARNESS REVIEW</div><h1>{esc(state.get('heading') or state.get('title'))}</h1><p>{esc(state.get('introduction') or state.get('scope'))}</p>
<nav><a href="#delivered">交付</a><a href="#prior">上輪對照</a><a href="#gates">驗收</a><a href="#screenshots">操作畫面</a><a href="#guide">使用指南</a><a href="#checkpoint">斷點檔案</a><a href="#source-changes">來源改動</a><a href="#decisions">決策與限制</a><a href="#events">事件帳本</a><a href="#review">如何驗收</a><a href="#conclusion">Conclusion／下一輪</a></nav></header>
<div class="stats"><div class="stat">狀態<strong>{esc(status_label)}</strong></div><div class="stat">開始<strong>{esc(local(state.get('started_at')))}</strong></div><div class="stat">截止<strong>{esc(local(state.get('deadline')))}</strong></div><div class="stat">斷點<strong>{esc(local(state.get('stopped_at')))}</strong></div><div class="stat">完成單位<strong>{len(completed)}</strong></div><div class="stat">中斷（秒）<strong>{esc(state.get('paused_seconds', 0))}</strong></div></div>
<section id="highlights"><h2>本輪重點</h2>{items(state.get("highlights", []), "工作仍在進行，重點會隨驗收更新。")}</section>
<section id="delivered"><h2>本輪交付</h2><p class="muted">依事件帳本的完成紀錄（時間為台北時間）；下方清單為 state.json 的完成單位。</p>{delivered_table}<h3>完成單位清單</h3>{render_delivery_catalog(completed)}</section>
{prior_html}{bench_html}{gates_html}{screenshots}{guide_html}{contracts_html}{checkpoint_html}{changes_html}
<section id="decisions"><h2>決策、限制與已知未完成</h2><h3>決策</h3>{items(state.get('decisions', []), '無')}<h3>約束</h3>{items(state.get('constraints', []), '無')}<h3>延後／未交付</h3>{items(state.get('deferred', []), '無')}<h3>中斷紀錄</h3>{('<ul>' + interruptions + '</ul>') if interruptions else '<p class="muted">無</p>'}</section>
<section id="events"><h2>事件帳本</h2><p class="muted">{len(events)} 筆事件{f'，{broken} 筆未完整寫入' if broken else ''}。</p>{event_open}<div class="scroll"><table><thead><tr><th>時間</th><th>類型</th><th>單位</th><th>內容</th></tr></thead><tbody>{event_rows}</tbody></table></div>{event_close}</section>
<section id="review"><h2>本機驗收路徑</h2>{items(state.get("review_steps", []), "工作仍在進行，驗收路徑會隨交付更新。")}</section>
<section id="conclusion"><span id="next"></span><h2>Conclusion · 下一輪 Agent Harness 待辦</h2><p><a href="#highlights">本輪重點</a> · <a href="#prior">上輪對照</a> · <a href="#gates">驗收輸出</a> · <a href="#screenshots">操作畫面</a></p>{next_tasks}</section>
<footer class="muted"><p>本頁只用本機資源；檢閱表單不傳送資料、不啟動 Agent，也不執行交易。產品結果是紙上模擬或歷史回測，不是投資建議。</p></footer></body></html>"""
    (folder / "review.html").write_text(document)
    return folder / "review.html"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("folder")
    print(render(Path(parser.parse_args().folder)))
