"""Local feature-development ledger, deadline marker, and offline review page.

The watcher records the time boundary; it does not claim to develop software or
terminate collaborating agents. Agents must check STOP before each new wave.
Only project-level metadata belongs in this ledger, never personal portfolios.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import html
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = ROOT / "artifacts/harness-2026-09-20-agent-portfolio"


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def local_time(value):
    if not value:
        return "—"
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
        ZoneInfo("Asia/Taipei")
    ).strftime("%m/%d %H:%M:%S")


def read_json(path, fallback):
    return json.loads(path.read_text()) if path.exists() else fallback


def atomic_json(path, value):
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def event(directory, kind, title, detail):
    row = {"at": now(), "kind": kind, "title": title, "detail": detail}
    with (directory / "events.jsonl").open("a") as output:
        output.write(json.dumps(row, ensure_ascii=False) + "\n")


def status(directory):
    state = read_json(directory / "state.json", {})
    deadline = datetime.fromisoformat(state["deadline"].replace("Z", "+00:00"))
    return {**state, "remaining_seconds": max(0, int((deadline - datetime.now(timezone.utc)).total_seconds())),
            "stop_requested": (directory / "STOP").exists()}


def render(directory):
    state = status(directory)
    esc = lambda value: html.escape(str(value), quote=True)
    events = []
    for line in (directory / "events.jsonl").read_text().splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    def link(url, label):
        parts = urlsplit(str(url))
        allowed = parts.scheme in ("http", "https") or (not parts.scheme and not str(url).startswith("//"))
        return f'<a href="{esc(url)}">{esc(label)}</a>' if allowed else esc(label)

    def content(row):
        if isinstance(row, str):
            return esc(row)
        label = row.get("title", row.get("name", row.get("id", "")))
        title = link(row["url"], label) if row.get("url") else esc(label)
        detail = esc(row.get("detail", row.get("description", "")))
        evidence = row.get("evidence", [])
        if isinstance(evidence, str):
            evidence = [evidence]
        proof = ''.join(f'<small>{esc(item)}</small>' for item in evidence)
        badge = f'<span class="tag">{esc(row["status"])}</span>' if row.get("status") else ''
        return f'<h3>{title}{badge}</h3><p>{detail}</p>{proof}'

    def section(key, title, subtitle=""):
        items = state.get(key, [])
        if not items:
            return ""
        cards = ''.join(f'<article>{content(row)}</article>' for row in items)
        return f'<section id="{esc(key)}"><div class="section-head"><h2>{esc(title)}</h2><p>{esc(subtitle)}</p></div><div class="cards">{cards}</div></section>'

    stopped = state.get("stopped_at")
    stage = "已設斷點 · 等待檢閱" if state["status"] in ("complete", "checkpointed") else "已到截止時間" if state["stop_requested"] else "功能開發中"
    document = '''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>AlphaView · Portfolio Agent Harness Review</title><style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#172b2a;background:#f4f6f3;--muted:#576866;--line:#d4ddd7;--card:#fff;--accent:#17634d}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0}main{max-width:1200px;margin:auto;padding:56px 32px 80px}h1{font-size:clamp(34px,5.2vw,66px);line-height:1.12;letter-spacing:-.055em;max-width:900px;margin:16px 0 22px}h2{font-size:26px;letter-spacing:-.025em;margin:0}h3{font-size:17px;margin:0 0 10px;line-height:1.5}p{color:var(--muted);line-height:1.8;white-space:pre-line;margin:8px 0}a{color:var(--accent);text-underline-offset:4px;overflow-wrap:anywhere}.eyebrow{font-size:12px;letter-spacing:.15em;color:var(--accent);font-weight:700}.hero{border-bottom:1px solid var(--line);padding-bottom:30px}.hero>p{max-width:800px}.links,nav{display:flex;gap:12px 24px;flex-wrap:wrap;margin-top:24px}nav a{font-size:14px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin:30px 0}.metric{padding:22px;background:var(--card)}.metric span{color:var(--muted);font-size:12px}.metric strong{display:block;font-size:19px;margin-top:10px}section{padding-top:42px;scroll-margin-top:12px}.section-head{margin-bottom:20px}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}article{border:1px solid var(--line);padding:22px;background:var(--card);min-width:0}small{display:block;line-height:1.6;color:var(--muted);overflow-wrap:anywhere}.tag{font-size:11px;display:inline-block;margin-left:10px;padding:3px 8px;border:1px solid var(--line);color:var(--accent);font-weight:500}.process{display:flex;flex-wrap:wrap;gap:10px;margin:28px 0}.process span{border:1px solid var(--line);padding:9px 14px;font-size:13px;background:var(--card)}.process span::after{content:' →';color:var(--muted)}.process span:last-child::after{content:''}details{border-bottom:1px solid var(--line);padding:14px 0}summary{cursor:pointer;line-height:1.6}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace;color:var(--muted);max-height:520px;overflow:auto}.table-wrap{overflow:auto;border:1px solid var(--line)}table{border-collapse:collapse;width:100%;background:var(--card);font-size:14px}td,th{padding:14px 18px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;line-height:1.7}th{font-size:12px;color:var(--muted)}.task{display:flex;gap:14px;border:1px solid var(--line);background:var(--card);padding:20px;margin:10px 0;cursor:pointer}.task input{width:18px;height:18px;flex:0 0 auto;margin-top:4px;accent-color:var(--accent)}.task h3{margin-bottom:5px}.task p{margin:0}.task:has(input:checked){border-color:var(--accent)}textarea{width:100%;display:block;font:inherit;line-height:1.7;background:var(--card);color:inherit;border:1px solid var(--line);padding:16px;margin:12px 0 20px}button{font:inherit;border:0;padding:13px 22px;background:var(--accent);color:white;cursor:pointer}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #cd9950;outline-offset:3px}footer{border-top:1px solid var(--line);padding-top:24px;margin-top:50px;font-size:12px;color:var(--muted)}figure{margin:16px 0}img{max-width:100%;border:1px solid var(--line)}figcaption{font-size:13px;color:var(--muted);line-height:1.7}@media(max-width:720px){main{padding:28px 18px 50px}.metrics{grid-template-columns:repeat(2,1fr)}.cards{grid-template-columns:1fr}article{padding:18px}th,td{min-width:130px;padding:12px}.metric{padding:16px}.metric strong{font-size:15px}}@media(prefers-color-scheme:dark){:root{background:#111a18;color:#e0eae5;--card:#18231f;--muted:#a1b4aa;--line:#30463a;--accent:#8ddbb4}button{color:#10251b}}@media print{details{display:block}.cards{display:block}article{break-inside:avoid;margin-bottom:12px}nav,button,textarea{display:none}}
</style></head><body><main><header class="hero"><div class="eyebrow">ALPHAVIEW / FIVE-HOUR DEVELOPMENT HARNESS</div><h1>從研究工作台，走向<br>可追溯的 Portfolio Agent。</h1><p>本輪依 GitHub 專案設計逐步加入 Agent 規劃、組合限制、模擬執行與決策紀錄。這份本機報告區分已交付功能、驗證證據與下一輪任務。</p><div class="links"><a href="http://127.0.0.1:8879/#agent-portfolio">開啟合成示範工作區</a><a href="state.json">工作帳本 JSON</a><a href="events.jsonl">開發事件</a><a href="source-checkpoint.zip">下載原始碼斷點</a></div><nav aria-label="檢閱導覽"><a href="#completed">已交付</a><a href="#benchmark">GitHub 對標</a><a href="#review_steps">操作檢查</a><a href="#evidence">驗證紀錄</a><a href="#next_tasks">下一輪任務</a></nav></header>'''
    # Keep historical reports reproducible while allowing a new local run to
    # identify its own scope and exported task source.
    report_id = state.get("run_id", directory.name)
    title = state.get("title", "AlphaView · Portfolio Agent Harness Review")
    heading = state.get("heading", "從研究工作台，走向可追溯的 Portfolio Agent。")
    introduction = state.get("introduction", "本輪依 GitHub 專案設計逐步加入 Agent 規劃、組合限制、模擬執行與決策紀錄。這份本機報告區分已交付功能、驗證證據與下一輪任務。")
    document = document.replace("AlphaView · Portfolio Agent Harness Review", esc(title))
    document = document.replace("從研究工作台，走向<br>可追溯的 Portfolio Agent。", esc(heading))
    document = document.replace("本輪依 GitHub 專案設計逐步加入 Agent 規劃、組合限制、模擬執行與決策紀錄。這份本機報告區分已交付功能、驗證證據與下一輪任務。", esc(introduction))
    if not (directory / "source-checkpoint.zip").exists():
        document = document.replace('<a href="source-checkpoint.zip">下載原始碼斷點</a>', '')
    for key, label in (("completed", "已交付"), ("review_steps", "操作檢查"), ("evidence", "驗證紀錄")):
        if not state.get(key):
            document = document.replace(f'<a href="#{key}">{label}</a>', '')
    metrics = [("執行狀態", stage), ("開始 · 臺灣時間", local_time(state["started_at"])), ("截止 · 臺灣時間", local_time(state["deadline"])), ("已記錄事件", len(events))]
    document += '<div class="metrics">' + ''.join(f'<div class="metric"><span>{esc(label)}</span><strong>{esc(value)}</strong></div>' for label, value in metrics) + '</div>'
    if state.get("interruption_note"):
        document += f'<article role="note"><h3>執行時間與中斷紀錄</h3><p>{esc(state["interruption_note"])}</p></article>'
    if stopped:
        document += f'<p>斷點時間：{esc(local_time(stopped))}（臺灣時間）。截止後未展開新功能；恢復後只收束原有工作、驗收及整理交付。</p>'
    document += '<div class="process"><span>資料與研究</span><span>Agent 規劃</span><span>風險審核</span><span>提案確認</span><span>Paper 執行</span><span>帳本與追溯</span></div>'
    document += section("completed", "本輪交付", "每項功能附實際完成範圍；規劃文件不算產品交付。")
    benchmark = read_json(directory / "github-benchmark.json", None)
    if not benchmark:
        document = document.replace('<a href="#benchmark">GitHub 對標</a>', '')
    if benchmark:
        document += '<section id="benchmark"><div class="section-head"><h2>GitHub 對標與功能取捨</h2><p>熱門度是查核時的公開數值，並非績效、品質或適合度保證。比較的是有關聯的候選專案，不宣稱涵蓋所有 GitHub 專案。</p></div>'
        rows = benchmark if isinstance(benchmark, list) else benchmark.get("repositories", benchmark.get("repos", []))
        if rows:
            document += '<div class="table-wrap"><table><thead><tr><th>專案</th><th>Stars</th><th>可參考設計</th><th>授權</th></tr></thead><tbody>'
            for row in sorted(rows, key=lambda row: row.get("stars", row.get("stargazers_count")) or -1, reverse=True):
                name = row.get("full_name", row.get("repo", row.get("name", "")))
                source = row.get("url", row.get("html_url", f"https://github.com/{name}"))
                adopted = [item["title"] for item in benchmark.get("recommended_features", []) if name in item.get("references", [])]
                feature = "、".join(adopted) or row.get("category", row.get("description", ""))
                if isinstance(feature, (dict, list)):
                    feature = json.dumps(feature, ensure_ascii=False)
                document += f'<tr><td>{link(source, name)}</td><td>{esc(row.get("stars", row.get("stargazers_count", "—")))}</td><td>{esc(feature)}</td><td>{esc(row.get("license_display", row.get("license", "—")))}</td></tr>'
            document += '</tbody></table></div>'
        adoption = state.get("feature_adoption", {})
        recommendations = benchmark.get("recommended_features", [])
        if recommendations:
            document += '<h3 style="margin-top:28px">從對標到本輪功能</h3><div class="table-wrap"><table><thead><tr><th>功能與價值</th><th>設計參考</th><th>本輪落地範圍</th></tr></thead><tbody>'
            for item in recommendations:
                refs = '、'.join(link('https://github.com/' + name, name) for name in item.get("references", []))
                result = adoption.get(item["id"], "尚待核對完成範圍")
                document += f'<tr><td><strong>{esc(item["id"])} · {esc(item["title"])}</strong><br>{esc(item.get("value", ""))}</td><td>{refs}</td><td>{esc(result)}</td></tr>'
            document += '</tbody></table></div>'
        document += '<details><summary>完整來源與查核資料</summary><pre>' + esc(json.dumps(benchmark, ensure_ascii=False, indent=2)) + '</pre></details></section>'
    for key, title in (("decisions", "本輪設計決策"), ("review_steps", "請從這裡檢查"), ("evidence", "必要驗證與證據"), ("in_progress", "斷點中的工作"), ("deferred", "保留的範圍與限制")):
        document += section(key, title)
    if state.get("screenshots"):
        document += '<section><h2>操作畫面 · 合成驗收工作區</h2>'
        for item in state["screenshots"]:
            filename = Path(item["file"])
            if filename.name == str(filename) and filename.suffix.lower() in {".png", ".jpg", ".webp"}:
                document += f'<figure><img loading="lazy" src="{esc(filename)}" alt="{esc(item["caption"])}"><figcaption>{esc(item["caption"])}</figcaption></figure>'
        document += '</section>'
    document += '<section id="next_tasks"><div class="section-head"><h2>下一輪 Agent Harness</h2><p>勾選要優先開發的項目，再匯出下一輪任務。這個頁面不會啟動 Agent，也不會送出任何資料。</p></div>'
    for index, row in enumerate(state.get("next_tasks", [])):
        document += f'<label class="task"><input type="checkbox" data-task="{index}"><div>{content(row)}</div></label>'
    document += '<label for="notes">檢閱備註與優先順序</label><textarea id="notes" rows="4" maxlength="12000" placeholder="記錄要調整的流程、功能或下一輪方向…"></textarea><button id="export" type="button">匯出下一輪任務</button><p id="export-status" role="status"></p></section>'
    document += '<section><h2>開發事件時間線</h2>'
    for row in reversed(events):
        document += f'<details><summary>{esc(local_time(row.get("at")))} · {esc(row.get("title", row.get("event", "事件")))}</summary><p>{esc(row.get("detail", ""))}</p></details>'
    document += '</section>'
    document += '<script>document.getElementById("export").addEventListener("click",()=>{const tasks=[...document.querySelectorAll(".task input:checked")].map(i=>i.parentElement.innerText.trim());const notes=document.getElementById("notes").value.trim();const status=document.getElementById("export-status");if(!tasks.length&&!notes){status.textContent="請勾選任務或填寫備註。";return;}const payload={schema_version:1,project:"AlphaView",source:__HARNESS_SOURCE__,created_at:new Date().toISOString(),tasks,notes};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="alphaview-next-agent-harness.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status.textContent="已匯出 "+tasks.length+" 項任務，請在下一輪交給 Agent。";});</script>'
    document += f'<footer>產生於 {esc(local_time(now()))} · 僅本機檢閱 · 不包含真實持股、成本或金鑰。<br>本輪不提交 Git、不推送、不部署、不呼叫付費模型，不連接券商或下真實訂單。</footer></main></body></html>'
    document = document.replace("__HARNESS_SOURCE__", json.dumps(report_id, ensure_ascii=True).replace("<", "\\u003c"))
    path = directory / "review.html"
    path.write_text(document)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["status", "event", "report", "watch"])
    parser.add_argument("--directory", type=Path, default=DEFAULT)
    parser.add_argument("--kind", default="feature")
    parser.add_argument("--title", default="")
    parser.add_argument("--detail", default="")
    args = parser.parse_args()
    directory = args.directory
    if args.command == "status":
        print(json.dumps(status(directory), ensure_ascii=False, indent=2))
    elif args.command == "event":
        event(directory, args.kind, args.title, args.detail)
        print(render(directory))
    elif args.command == "report":
        print(render(directory))
    else:
        deadline = datetime.fromisoformat(read_json(directory / "state.json", {})["deadline"].replace("Z", "+00:00"))
        while (remaining := (deadline - datetime.now(timezone.utc)).total_seconds()) > 0:
            time.sleep(min(10, remaining))
        marker = directory / "STOP"
        if not marker.exists():
            marker.write_text(f"Deadline reached at {now()}. Stop new feature work and checkpoint.\n")
            event(directory, "deadline", "五小時截止 · 停止新開發", "保留目前程式與工作帳本；開始整理 HTML 與交接斷點。")
        print(render(directory), flush=True)


if __name__ == "__main__":
    main()
