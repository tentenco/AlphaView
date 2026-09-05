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
        body = f'<ul>{content}</ul>' if content else f'<p>{esc(empty)}</p>'
        if content and key in {'completed', 'evidence', 'workflow'}:
            body = f'<details><summary>展開全部 {len(values)} 項</summary>{body}</details>'
        return f'<section id="{esc(key)}"><h2>{esc(title)}</h2>' + body + '</section>'

    backlog = state.get("next_tasks", [])
    items = "".join(f'<li><label class="review-task"><input type="checkbox"> {entry(task)}</label></li>' for task in backlog)
    document = '''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AlphaView · Agent Harness Review</title><style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#e8eceb;background:#101312;color-scheme:dark}*{box-sizing:border-box}body{max-width:1160px;margin:0 auto;padding:48px 28px 80px}header{border-bottom:1px solid #34403a;padding-bottom:28px}h1{font-size:clamp(32px,6vw,56px);letter-spacing:-.04em;margin:12px 0}h2{margin-top:42px}h3{font-size:18px;margin:8px 0}p{color:#b9c5bf;line-height:1.7;white-space:pre-wrap}.eyebrow,.meta{font-size:12px;letter-spacing:.06em;color:#8caf9f}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:28px 0}.stat,article{border:1px solid #34403a;border-radius:8px;padding:20px;background:#151b18}.stat strong{display:block;font-size:20px;margin-top:9px}article{margin:12px 0}.links{display:flex;gap:24px;flex-wrap:wrap}a{color:#78d5ad}ul{list-style:none;padding:0}li{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid #34403a;line-height:1.6}input{accent-color:#008557}.review-task{display:flex;gap:12px;align-items:flex-start;cursor:pointer;width:100%}.review-task input{margin-top:6px;flex-shrink:0}li p{margin:6px 0}a{overflow-wrap:anywhere}footer{margin-top:50px;color:#8caf9f;font-size:13px}@media print{body{background:white;color:black}.stat,article{break-inside:avoid;background:white}p{color:#333}}
summary{cursor:pointer;line-height:1.7;color:#b9c5bf}section{scroll-margin-top:20px}.review-nav{margin-top:20px}</style><header><div class="eyebrow">ALPHAVIEW / DEVELOPMENT REVIEW</div><h1>Agent Harness 開發檢閱</h1><p>動態子代理協作、逐項修正與驗證。這份靜態報告僅記錄實際開發結果；未完成事項保留為下一輪任務。</p><div class="links"><a href="http://127.0.0.1:8876">開啟本機 AlphaView</a><a href="https://github.com/tentenco/AlphaView">GitHub Repo</a><a href="https://tentenai.com">Powered by Tentenai.com</a></div><nav class="links review-nav" aria-label="報告導覽"><a href="#delivered">交付概覽</a><a href="#deferred">已知限制</a><a href="#review_steps">檢查步驟</a><a href="#interface-market-overview.png">介面畫面</a><a href="#next-tasks">下一輪任務</a></nav></header>'''
    status = {"running": "開發與驗證中", "deadline_reached": "已到時限，停止新任務", "complete": "已設斷點，等待檢閱"}.get(state["status"], state["status"])
    document += f'<div class="stats"><div class="stat">狀態<strong>{esc(status)}</strong></div><div class="stat">開始（臺灣時間）<strong>{esc(taipei(state["started_at"]))}</strong></div><div class="stat">截止（臺灣時間）<strong>{esc(taipei(state["deadline"]))}</strong></div><div class="stat">已記錄事件<strong>{len(events)}</strong></div></div>'
    if state.get("stopped_at"):
        stopped = datetime.fromisoformat(state["stopped_at"].replace("Z", "+00:00"))
        started = datetime.fromisoformat(state["started_at"].replace("Z", "+00:00"))
        minutes = (stopped - started).total_seconds() / 60
        document += f'<p>實際斷點（臺灣時間）：{esc(taipei(state["stopped_at"]))} · 距開始 {minutes:.1f} 分鐘。時限後停止新增開發，只整理檢閱與交接。</p>'
    document += section('delivered', '本輪交付概覽', '本輪仍在逐項驗證，以下保留開發紀錄。')
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
    for folder, label in ((directory, "隔離版本同步長時間檢查（首次）"), (directory / "polling-revision-rerun", "隔離版本同步長時間檢查（附診斷重跑）"), (directory / "polling-revision-frozen", "隔離版本同步長時間檢查（固定程式版本）")):
        revisions, incomplete_revisions = receipt_lines(folder / "polling-revision-soak.jsonl")
        if not revisions:
            continue
        passed = sum(row.get("status") == "pass" for row in revisions)
        checks = sum(row.get("invariants", 0) for row in revisions if row.get("status") == "pass")
        summary_path = folder / "polling-revision-soak-summary.json"
        finished = summary_path.exists()
        document += f'<section><h2>{esc(label)}</h2><p>{"已停止並產生摘要" if finished else "執行中"} · {len(revisions)} 輪 · {checks} 項一致性檢查通過 · {len(revisions) - passed} 輪失敗。<br>最後紀錄（臺灣時間）：{esc(taipei(revisions[-1]["at"]))}。<br>以合成資料驗證同時間戳修改、作業與資料版本分離、未提交讀取、回復、程序中斷及重啟；不連接實際資料庫。長測使用啟動時載入的程式，後續新增功能另依各檢查點驗證。</p>'
        manifest_path = folder / "polling-revision-source-manifest.json"
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text())
            document += f'<p>固定程式副本 SHA-256：<code style="overflow-wrap:anywhere">{esc(manifest.get("sha256", "未知"))}</code>。父子程序使用同一份副本，避免開發中的檔案修改改變比較口徑。</p>'
        if finished:
            summary = json.loads(summary_path.read_text())
            document += f'<p>實際執行 {esc(summary.get("elapsed_seconds", "未知"))} 秒；停止原因：{esc(summary.get("stop_reason", "未知"))}。</p>'
        if len(revisions) != passed:
            document += '<ul>' + ''.join(f'<li>第 {esc(row.get("cycle", 0) + 1)} 輪 · {esc(row.get("error", "檢查失敗"))}</li>' for row in revisions if row.get("status") != "pass") + '</ul>'
            document += '<p>失敗紀錄保留；後續重跑通過不能抹除這次失敗，也不能單憑逾時推定產品資料損壞。</p>'
        if incomplete_revisions:
            document += f'<p>{incomplete_revisions} 筆未完整寫入的紀錄暫不計入。</p>'
        document += '</section>'
    provenance, incomplete_provenance = receipt_lines(directory / "provenance-soak-60m.jsonl")
    if provenance:
        passed = sum(row.get("status") == "passed" for row in provenance)
        checks = sum(row.get("checks", 0) for row in provenance if row.get("status") == "passed")
        finished = (directory / "provenance-soak-60m.summary.json").exists()
        document += f'<section><h2>選股輸入版本長時間檢查</h2><p>{"已停止並產生摘要" if finished else "執行中"} · {len(provenance)} 輪 · {checks} 項檢查通過 · {len(provenance) - passed} 輪失敗。<br>最後紀錄（臺灣時間）：{esc(taipei(provenance[-1]["at"]))}。<br>以合成日線驗證兩個股票池的版本、行情修改後的舊訊號隔離、重算恢復，以及計算期間跨程序寫入時禁止發布。長測使用啟動時載入的程式，後續新增功能另依各檢查點驗證。</p>'
        if len(provenance) != passed:
            document += '<ul>' + ''.join(f'<li>第 {esc(row.get("cycle"))} 輪 · {esc(row.get("error_type", "檢查失敗"))}</li>' for row in provenance if row.get("status") != "passed") + '</ul>'
        if incomplete_provenance:
            document += f'<p>{incomplete_provenance} 筆未完整寫入的紀錄暫不計入。</p>'
        document += '</section>'
    resilience_path = directory / "resilience-soak-30m.json"
    if resilience_path.exists():
        try:
            resilience = json.loads(resilience_path.read_text())
        except (OSError, json.JSONDecodeError):
            document += '<p>隔離測試紀錄暫時無法讀取，請稍後重新產生報告。</p>'
        else:
            labels = {
                "concurrent_uncommitted_read": "交易尚未提交時的讀取一致性",
                "committed_atomic_update": "完整交易發布",
                "stale_csv_preview_conflict": "CSV 預覽過期衝突",
                "optimistic_note_conflict": "研究筆記版本衝突",
                "process_crash_rollback": "程序中斷後交易回復",
                "scheduler_restart_once_per_session": "排程重啟後同交易日不重複",
                "backup_during_uncommitted_transaction": "交易進行中的一致性備份",
            }
            failures = resilience.get("failures", [])
            stage = {"running": "執行中", "completed": "已完成", "stopped": "已停止", "failed": "發現失敗"}.get(resilience.get("status"), resilience.get("status", "未知"))
            document += f'<section><h2>隔離資料庫中斷與重啟測試</h2><p>{esc(stage)} · {esc(resilience.get("elapsed_seconds", 0))} 秒 · {esc(resilience.get("cycles", 0))} 輪。<br>{esc(resilience.get("passed", 0))} 項檢查通過，{len(failures)} 項失敗。<br>僅使用模擬資料，禁止網路連線；不修改實際持股與研究紀錄。</p><ul>'
            document += ''.join(f'<li>{esc(labels.get(name, name))} · {esc(count)} 次通過</li>' for name, count in resilience.get("scenarios", {}).items())
            document += '</ul>'
            if failures:
                document += '<p>失敗紀錄：' + '<br>'.join(esc(row.get("error", row.get("reason", row.get("scenario", "未分類")))) for row in failures) + '</p>'
            document += '</section>'
    coverage_path = directory / "market-coverage-latest.json"
    if coverage_path.exists():
        coverage = json.loads(coverage_path.read_text())
        counts = coverage.get("quality", {})
        document += f'<section><h2>最新市場資料實測</h2><p>檢查時間（臺灣時間）：{esc(taipei(coverage["checked_at"]))}。這是所選股票池的本地快照，並非全美股或即時行情。</p><div class="stats">'
        metrics = [("市場候選", coverage["pool"]), ("行情品質通過", counts.get("ok", 0)), ("異常／缺行情", counts.get("error", 0) + counts.get("missing", 0)), ("符合至少一策略", coverage["matched"])]
        document += ''.join(f'<div class="stat">{esc(label)}<strong>{esc(value)}</strong></div>' for label, value in metrics)
        document += f'</div><p>其中 {esc(coverage["new_matches"])} 檔符合標的不在個人清單內。異常 {esc(counts.get("error", 0))} 檔、缺行情 {esc(counts.get("missing", 0))} 檔、過期 {esc(counts.get("stale", 0))} 檔；未以重建價格或零值補齊。</p></section>'
    comparison_path = directory / "price-repair-summary.json"
    if comparison_path.exists():
        comparison = json.loads(comparison_path.read_text())
        document += '<section><h2>原始行情與修復版本的隔離比對</h2><p>未採用任何價格，也未修改應用資料庫。結構檢查通過不代表重建價格已獨立驗證；需核對公司行動及調整方式。以下為實際診斷結果。</p>'
        for row in comparison.get("rows", []):
            document += f'<article><h3>{esc(row["symbol"])}</h3><p>原始 {esc(row["raw_rows"])} 筆日線／{esc(row["raw_invalid"])} 筆異常；修復 {esc(row["repair_rows"])} 筆／{esc(row["repair_invalid"])} 筆結構異常。<br>{esc(row["changed_cells"])} 個欄位值改變（不含修復旗標）；新增 {len(row["added_dates"])} 日、移除 {len(row["missing_dates"])} 日。<br>檢查時間（臺灣時間）：{esc(taipei(row["started_at"]))} — {esc(taipei(row["finished_at"]))}</p><details><summary>查看差異範例與資料雜湊</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7">'
            evidence = {"raw_sha256": row["raw_sha256"], "repair_sha256": row["repair_sha256"], "hash_basis": "normalized row JSON; nonfinite values serialized as null", "examples": row["examples"]}
            document += esc(json.dumps(evidence, ensure_ascii=False, indent=2)) + '</pre></details></article>'
        document += '</section>'
    document += section('workflow', '本輪協作與驗證分工', '動態子代理協作。')
    document += section('completed', '已完成的開發', '尚未整理完成項目；以下事件紀錄保留目前進度。')
    document += section('evidence', '驗證證據', '尚未附上驗證證據。')
    document += section('active', '斷點中的工作', '目前沒有進行中的項目。')
    document += section('deferred', '未完成事項與限制', '尚未整理限制；請以事件紀錄與下一輪待辦核對。')
    document += section('review_steps', '使用者檢查步驟', '請開啟本機 AlphaView，依本輪已完成項目進行檢查。')
    for filename, caption in (("market-overview.png", "市場概況：已保存畫面，數值以擷取時點為準；最新涵蓋率見本報告限制與證據"), ("comparison-desktop.png", "標的價格比較：共同期間、資料不足原因與已收合的股票池；圖示為擷取時的價格研究結果")):
        screenshot = directory / filename
        if screenshot.exists():
            encoded = base64.b64encode(screenshot.read_bytes()).decode("ascii")
            document += f'<section id="interface-{esc(filename)}"><h2>介面檢閱</h2><p>{esc(caption)}</p><img style="display:block;width:100%;height:auto;border:1px solid #34403a;border-radius:8px" alt="{esc(caption)}" src="data:image/png;base64,{encoded}"></section>'
    document += f'<section id="timeline"><h2>開發與驗證紀錄</h2><details><summary>展開 {len(events)} 筆事件</summary>' + (cards or '<p>正在進行第一輪工作。</p>') + '</details></section>'
    document += '<h2 id="next-tasks">下一輪 Agent Harness · Review 清單</h2><p>勾選後可匯出下一輪任務，交給下一次 Agent Harness。這份 HTML 不會修改專案或啟動任務；重載前請先匯出。</p><ul>' + (items or '<li>下一輪待辦會在結束前整理。</li>') + '</ul>'
    document += '''<div style="margin-top:24px"><label for="review-notes">檢閱備註</label><textarea id="review-notes" rows="4" maxlength="6000" style="display:block;width:100%;margin:10px 0 16px;padding:14px;background:#151b18;color:#e8eceb;border:1px solid #34403a;border-radius:8px;font:inherit" placeholder="補充下一輪想優先改善的操作或問題…"></textarea><button id="export-review" type="button" style="padding:12px 18px;border:1px solid #78d5ad;border-radius:6px;background:#173c2c;color:#e8eceb;font:inherit;cursor:pointer">匯出下一輪任務 JSON</button><p id="review-status" role="status"></p></div>
<script>document.getElementById('export-review').addEventListener('click',function(){
const tasks=Array.from(document.querySelectorAll('.review-task input:checked')).map(input=>input.closest('label').textContent.trim().replace(/\\s+/g,' '));
const notes=document.getElementById('review-notes').value.trim();
const status=document.getElementById('review-status');
if(!tasks.length&&!notes){status.textContent='請至少勾選一項任務或填寫檢閱備註。';return;}
const payload={format_version:1,project:'AlphaView',exported_at:new Date().toISOString(),tasks,notes};
const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)+'\\n'],{type:'application/json'}));
const link=document.createElement('a');link.href=url;link.download='alphaview-next-harness.json';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
status.textContent='已匯出 '+tasks.length+' 項任務；這不會自動開始下一輪開發。';
});</script>'''
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
