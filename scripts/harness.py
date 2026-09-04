"""Local time-boxed development ledger and standalone HTML review.

This records work performed by the collaborating agents. It is not a claim that
an unattended timer itself implements or verifies code. Runtime state stays out
of Git. The watchdog creates a stop marker at the deadline; agents must check it
before starting another change wave.
"""
import argparse
import base64
import html
import json
import os
import time
from urllib.parse import urlsplit
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = ROOT / "artifacts" / "harness-2026-09-05"


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def receipt_lines(path):
    """Read complete append-only receipts while a worker may still be writing."""
    if not path.exists():
        return [], 0
    records, incomplete = [], 0
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            incomplete += 1
    return records, incomplete


def taipei(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
        ZoneInfo("Asia/Taipei")).strftime("%Y-%m-%d %H:%M:%S")


def render(directory):
    state = json.loads((directory / "state.json").read_text())
    events, incomplete_events = receipt_lines(directory / "events.jsonl")
    esc = lambda value: html.escape(str(value))
    cards = "".join(f'<article><div class="meta">{esc(e["at"])} · {esc(e["kind"])}</div><h3>{esc(e["title"])}</h3><p>{esc(e["detail"])}</p></article>' for e in reversed(events))
    def entry(value):
        if not isinstance(value, dict):
            return f'<span>{esc(value)}</span>'
        title = esc(value.get("title", ""))
        detail = esc(value.get("detail", ""))
        url = str(value.get("url", ""))
        parsed = urlsplit(url)
        # Keep the report standalone; never render executable URLs from ledger text.
        safe = parsed.scheme in {"http", "https"} or (not parsed.scheme and not url.startswith("//"))
        link = f'<a href="{esc(url)}">{title or "查看證據"}</a>' if url and safe else title
        return f'<div><strong>{link}</strong>{f"<p>{detail}</p>" if detail else ""}</div>'

    def section(key, title, empty):
        values = state.get(key, [])
        content = "".join(f"<li>{entry(value)}</li>" for value in values)
        return f'<section><h2>{esc(title)}</h2>' + (f'<ul>{content}</ul>' if content else f'<p>{esc(empty)}</p>') + '</section>'

    backlog = state.get("next_tasks", [])
    items = "".join(f'<li><label class="review-task"><input type="checkbox"> {entry(task)}</label></li>' for task in backlog)
    document = '''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AlphaView · Agent Harness Review</title><style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#e8eceb;background:#101312;color-scheme:dark}*{box-sizing:border-box}body{max-width:1160px;margin:0 auto;padding:48px 28px 80px}header{border-bottom:1px solid #34403a;padding-bottom:28px}h1{font-size:clamp(32px,6vw,56px);letter-spacing:-.04em;margin:12px 0}h2{margin-top:42px}h3{font-size:18px;margin:8px 0}p{color:#b9c5bf;line-height:1.7;white-space:pre-wrap}.eyebrow,.meta{font-size:12px;letter-spacing:.06em;color:#8caf9f}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:28px 0}.stat,article{border:1px solid #34403a;border-radius:8px;padding:20px;background:#151b18}.stat strong{display:block;font-size:20px;margin-top:9px}article{margin:12px 0}.links{display:flex;gap:24px;flex-wrap:wrap}a{color:#78d5ad}ul{list-style:none;padding:0}li{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid #34403a;line-height:1.6}input{accent-color:#008557}.review-task{display:flex;gap:12px;align-items:flex-start;cursor:pointer;width:100%}.review-task input{margin-top:6px;flex-shrink:0}li p{margin:6px 0}a{overflow-wrap:anywhere}footer{margin-top:50px;color:#8caf9f;font-size:13px}@media print{body{background:white;color:black}.stat,article{break-inside:avoid;background:white}p{color:#333}}
</style><header><div class="eyebrow">ALPHAVIEW / DEVELOPMENT REVIEW</div><h1>Agent Harness 開發檢閱</h1><p>動態子代理協作、逐項修正與驗證。這份靜態報告僅記錄實際開發結果；未完成事項保留為下一輪任務。</p><div class="links"><a href="http://127.0.0.1:8876">開啟本機 AlphaView</a><a href="https://github.com/tentenco/AlphaView">GitHub Repo</a><a href="https://tentenai.com">Powered by Tentenai.com</a></div></header>'''
    status = {"running": "開發與驗證中", "deadline_reached": "已到時限，停止新任務", "complete": "已設斷點，等待檢閱"}.get(state["status"], state["status"])
    document += f'<div class="stats"><div class="stat">狀態<strong>{esc(status)}</strong></div><div class="stat">開始（臺灣時間）<strong>{esc(taipei(state["started_at"]))}</strong></div><div class="stat">截止（臺灣時間）<strong>{esc(taipei(state["deadline"]))}</strong></div><div class="stat">已記錄事件<strong>{len(events)}</strong></div></div>'
    if incomplete_events:
        document += f'<p>有 {incomplete_events} 筆尚未完整寫入的事件，未列入本次報告。</p>'
    soak, incomplete_soak = receipt_lines(directory / "soak.jsonl")
    if soak:
        passed = sum(row.get("status") == "pass" for row in soak)
        failures = len(soak) - passed
        document += f'<section><h2>長時間執行檢查</h2><p>{len(soak)} 次已完成檢查 · {passed} 次通過 · {failures} 次失敗。<br>檢查期間（臺灣時間）：{esc(taipei(soak[0]["at"]))} — {esc(taipei(soak[-1]["at"]))}。<br>健康 API、持股估值加總與訊號日期／狀態一致性；不等同所有互動功能都已驗證。</p>'
        if failures:
            document += '<ul>' + ''.join(f'<li>{esc(taipei(row["at"]))} · {esc(row.get("error", "檢查失敗"))}</li>' for row in soak if row.get("status") != "pass") + '</ul>'
        if incomplete_soak:
            document += f'<p>{incomplete_soak} 筆未完整寫入的檢查紀錄暫不計入。</p>'
        document += '</section>'
    document += section('completed', '已完成的開發', '尚未整理完成項目；以下事件紀錄保留目前進度。')
    document += section('evidence', '驗證證據', '尚未附上驗證證據。')
    document += section('active', '斷點中的工作', '目前沒有進行中的項目。')
    document += section('deferred', '未完成事項與限制', '尚未整理限制；請以事件紀錄與下一輪待辦核對。')
    document += section('review_steps', '使用者檢查步驟', '請開啟本機 AlphaView，依本輪已完成項目進行檢查。')
    for filename, caption in (("market-overview.png", "市場概況：實際股票池、資料涵蓋率與各指標分母"),):
        screenshot = directory / filename
        if screenshot.exists():
            encoded = base64.b64encode(screenshot.read_bytes()).decode("ascii")
            document += f'<section><h2>介面檢閱</h2><p>{esc(caption)}</p><img style="display:block;width:100%;height:auto;border:1px solid #34403a;border-radius:8px" alt="{esc(caption)}" src="data:image/png;base64,{encoded}"></section>'
    document += '<h2>開發與驗證紀錄</h2>' + (cards or '<p>正在進行第一輪工作。</p>')
    document += '<h2>下一輪 Agent Harness · Review 清單</h2><p>勾選供本次 review 使用；此 HTML 不會將勾選寫回專案。</p><ul>' + (items or '<li>下一輪待辦會在結束前整理。</li>') + '</ul>'
    document += f'<footer>AlphaView · Powered by Tentenai.com · 報告產生於 {esc(now())}<br>本機檢閱檔案；不包含持股明細、成本或 API secrets。</footer></html>'
    (directory / "review.html").write_text(document)
    return directory / "review.html"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["status", "event", "report", "watch"])
    parser.add_argument("--directory", type=Path, default=DEFAULT)
    parser.add_argument("--kind", default="development")
    parser.add_argument("--title", default="")
    parser.add_argument("--detail", default="")
    args = parser.parse_args()
    directory = args.directory
    directory.mkdir(parents=True, exist_ok=True)
    state_path = directory / "state.json"
    if args.command == "event":
        event = {"at": now(), "kind": args.kind, "title": args.title, "detail": args.detail}
        with (directory / "events.jsonl").open("a") as output:
            output.write(json.dumps(event, ensure_ascii=False) + "\n")
        print(render(directory))
    elif args.command == "report":
        print(render(directory))
    elif args.command == "status":
        state = json.loads(state_path.read_text())
        remaining = datetime.fromisoformat(state["deadline"].replace("Z", "+00:00")) - datetime.now(timezone.utc)
        print(json.dumps({**state, "remaining_seconds": max(0, int(remaining.total_seconds())), "stop_requested": (directory / "STOP").exists()}, indent=2, ensure_ascii=False))
    else:
        deadline = datetime.fromisoformat(json.loads(state_path.read_text())["deadline"].replace("Z", "+00:00"))
        while True:
            remaining = (deadline - datetime.now(timezone.utc)).total_seconds()
            if remaining <= 0:
                break
            time.sleep(min(30, remaining))
        (directory / "STOP").write_text(f"Deadline reached at {now()}. Stop new work and checkpoint.\n")
        state = json.loads(state_path.read_text())
        if state["status"] == "running":
            state["status"] = "deadline_reached"
            atomic_json(state_path, state)
        print(render(directory), flush=True)


if __name__ == "__main__":
    main()
