"""Standalone light-theme review for the feature-development Harness."""
import argparse
import base64
from datetime import datetime
import html
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo


def render(directory):
    directory = Path(directory)
    state = json.loads((directory / "state.json").read_text())
    events = []
    if (directory / "events.jsonl").exists():
        for line in (directory / "events.jsonl").read_text().splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    esc = lambda value: html.escape(str(value))
    def local_time(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(ZoneInfo("Asia/Taipei")).strftime("%m/%d %H:%M:%S")
    def item(value):
        if isinstance(value, dict):
            return f'<strong>{esc(value.get("title", ""))}</strong><p>{esc(value.get("detail", ""))}</p>'
        return esc(value)
    def section(key, title, description=""):
        values = state.get(key, [])
        return f'<section id="{key}"><h2>{title}</h2><p>{esc(description)}</p><ul>' + ''.join(f'<li>{item(value)}</li>' for value in values) + '</ul></section>'
    status = {"running": "開發進行中", "deadline_reached": "時間已到，整理斷點", "complete": "已設斷點，等待 Review"}.get(state["status"], state["status"])
    document = '''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AlphaView · 3 小時開發檢閱</title><style>
    :root{font-family:system-ui,-apple-system,sans-serif;color:#17201c;background:#f6f7f5;font-size:15px;accent-color:#087a5b}*{box-sizing:border-box}body{max-width:1160px;margin:auto;padding:40px 24px 80px}h1{font-size:38px;letter-spacing:-.04em;margin:12px 0;font-weight:600}h2{font-size:24px;letter-spacing:-.02em;margin:0 0 16px;font-weight:600}h3{font-size:17px;font-weight:600}p{color:#5b6860;line-height:1.8;white-space:pre-wrap;margin:10px 0}a{color:#087a5b;text-decoration:none}a:hover{text-decoration:underline}.eyebrow{font:11px ui-monospace,monospace;letter-spacing:.15em;color:#657368}header{padding-bottom:24px;border-bottom:1px solid #d6ddd7}.links{display:flex;gap:20px;flex-wrap:wrap;font-size:13px;margin-top:20px}.status{display:inline-block;border:1px solid #bfd6c8;border-radius:4px;padding:5px 9px;font-size:12px;color:#087a5b;margin-top:16px}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;margin:28px 0}.stats>div{border-left:2px solid #d6ddd7;padding-left:16px;font-size:12px;color:#657368}.stats b{display:block;font-size:18px;color:#17201c;margin-top:8px;font-weight:600}nav{display:flex;flex-wrap:wrap;gap:20px;padding:16px 0;border-block:1px solid #d6ddd7;font-size:13px}section{padding:32px 0;border-bottom:1px solid #d6ddd7;scroll-margin-top:20px}ul{padding:0;list-style:none;margin:0}li{padding:14px 0;line-height:1.8;border-bottom:1px solid #e2e7e3}li:last-child{border:0}.delivery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.delivery article{background:white;padding:24px;border:1px solid #d6ddd7;border-radius:6px}.delivery h3{margin:0}.delivery p{font-size:14px}.review-step{display:flex;gap:12px;align-items:flex-start;cursor:pointer}.review-step input{width:18px;height:18px;flex-shrink:0;margin-top:5px}.review-step:has(input:checked){color:#087a5b}details summary{cursor:pointer;color:#4f6156;line-height:1.8}details p{font-size:14px}.meta{font-size:11px;color:#6c7c71}.event{padding:16px 0;border-bottom:1px solid #e2e7e3}.event h3{margin:8px 0}.screenshot{margin:24px 0}.screenshot img{display:block;width:100%;height:auto;border:1px solid #d6ddd7;border-radius:6px}.screenshot.mobile img{max-width:390px}.screenshot figcaption{font-size:13px;color:#657368;line-height:1.7;margin:10px 0}.review-feedback{margin:10px 0 0 30px;padding:12px;background:#eef3ef;border-radius:4px}.review-feedback[hidden],.review-feedback textarea[hidden]{display:none}.review-feedback label{display:block;font-size:12px;color:#4f6156}.review-feedback select{font:inherit;padding:7px;border:1px solid #cad4cd;background:white;border-radius:4px;margin-left:8px}.review-feedback textarea{margin-top:10px;font-size:13px}.priority{display:flex;align-items:center;gap:12px;font-size:12px;color:#657368;margin:8px 0 0 30px}.priority select{font:inherit;padding:7px;border:1px solid #cad4cd;border-radius:4px;background:white;color:#17201c}textarea{width:100%;padding:14px;background:white;border:1px solid #cad4cd;border-radius:5px;font:inherit;line-height:1.7}button{border:1px solid #087a5b;background:#087a5b;color:white;padding:11px 16px;border-radius:5px;font:inherit;cursor:pointer;margin-top:16px}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #087a5b;outline-offset:3px}footer{margin-top:36px;font-size:12px;color:#657368}code{font-size:12px;background:#e9eeea;padding:2px 5px;border-radius:3px}@media(max-width:700px){body{padding:24px 18px 60px}h1{font-size:30px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.delivery{grid-template-columns:1fr}nav{gap:12px 20px}p,li{font-size:16px}}@media print{body{background:white;padding:0}.delivery article,.screenshot,li{break-inside:avoid}nav,button{display:none}details{display:block}a{color:inherit}}
    </style><header><div class="eyebrow">ALPHAVIEW / FEATURE DEVELOPMENT HARNESS</div><h1>3 小時開發檢閱</h1><p>這一輪聚焦快速選股、跨策略權重、持倉提醒與日常研究流程。以下記錄本機實際開發，並保留下一輪可接續的方向。</p>'''
    document += f'<div class="status">{esc(status)}</div><div class="links"><a href="http://127.0.0.1:8876/#alpha">開啟 Alpha Picks</a><a href="http://127.0.0.1:8876/#alpha-lab">開啟 Alpha 實驗室</a><a href="http://127.0.0.1:8876/#data">資料管理</a><a href="https://github.com/tentenco/AlphaView">GitHub Repo</a></div></header>'
    document += f'<div class="stats"><div>開始 · 臺灣時間<b>{esc(local_time(state["started_at"]))}</b></div><div>截止 · 臺灣時間<b>{esc(local_time(state["deadline"]))}</b></div><div>已整理開發項目<b>{len(state.get("completed", []))}</b></div><div>開發事件<b>{len(events)}</b></div></div>'
    if state.get("stopped_at"):
        document += f'<p>實際斷點：{esc(local_time(state["stopped_at"]))}。到時後停止新增功能，保留本機版本供檢閱。</p>'
    else:
        document += '<p>目前仍在時限內開發；本檔是中途檢閱版本，尚未宣告整輪完成。</p>'
    document += '<nav aria-label="Review 導覽"><a href="#delivered">交付概覽</a><a href="#review_steps">操作 Review</a><a href="#screenshots">畫面</a><a href="#completed">完整開發</a><a href="#deferred">限制與斷點</a><a href="#next-tasks">下一輪</a></nav>'
    document += '<section id="delivered"><h2>本輪交付概覽</h2><div class="delivery">' + ''.join(f'<article>{item(value)}</article>' for value in state.get("delivered", [])) + '</div></section>'
    document += '<section id="review_steps"><h2>你可以這樣 Review</h2><p>勾選已檢查的流程，再標記通過或需要調整；每項可留下修改方向，最後與下一輪任務一起匯出。</p><ul>' + ''.join(f'<li><label class="review-step checked-feature"><input type="checkbox"><span>{item(value)}</span></label><div class="review-feedback" hidden><label>檢查結果<select class="review-result"><option value="pass">通過</option><option value="needs_changes">需要調整</option></select></label><textarea class="review-note" rows="2" maxlength="800" aria-label="此項功能需要調整的地方" placeholder="簡短說明哪裡不直覺、期望怎麼調整" hidden></textarea></div></li>' for value in state.get("review_steps", [])) + '</ul></section>'
    document += '<section id="screenshots"><h2>介面畫面</h2><p>畫面是擷取時的本機資料；不是即時行情或後續交易日的結果。</p>'
    for shot in state.get("screenshots", []):
        target = (directory / shot["file"]).resolve()
        if target.parent != directory.resolve() or not target.is_file() or target.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            continue
        mime = "image/png" if target.suffix == ".png" else "image/webp" if target.suffix == ".webp" else "image/jpeg"
        encoded = base64.b64encode(target.read_bytes()).decode()
        caption = esc(shot.get("caption", target.name))
        document += f'<figure class="screenshot {"mobile" if shot.get("mobile") else ""}"><figcaption>{caption}</figcaption><img alt="{caption}" src="data:{mime};base64,{encoded}" loading="lazy"></figure>'
    document += '</section>'
    if state.get("experiment_examples"):
        document += '<section id="experiment-examples"><h2>本輪實際跑過的組合研究</h2><p>2026-08-10 至 2026-09-04，共 20 個交易日；最多 5 檔、每 5 日調整、起始 10,000 USD、單邊 10 bps。兩組都使用當前股票池的已存歷史快照，並非實際帳戶績效或未來收益預測。</p><div class="delivery">' + ''.join(f'<article><h3>{esc(example["name"])}</h3><p>區間報酬 {esc(example["return"])}<br>日末回撤 {esc(example["drawdown"])}<br>總成本 {esc(example["cost"])}</p></article>' for example in state["experiment_examples"]) + '</div><p>同起始組合買入持有基準為 +2.31%，不是大盤指數。兩組均為負報酬；這段樣本不能證明某組權重在未來較好。摘要已以 Harness 名稱保存在此次操作的瀏覽器；完整結果也可從下面下載，在不同瀏覽器仍能檢閱。</p><div class="links"><a href="experiment-balanced.json" download>均衡實驗完整 JSON</a><a href="experiment-momentum.json" download>動能實驗完整 JSON</a><a href="experiment-requests.json" download>兩組實驗參數</a></div></section>'
    if state.get("source_checkpoint"):
        checkpoint = state["source_checkpoint"]
        document += f'<section id="source-checkpoint"><h2>本機原始碼斷點</h2><p>已保存 {esc(checkpoint["files"])} 個變更檔案記錄，基底 commit <code>{esc(checkpoint["base_commit"][:12])}</code>。包含先前的淺／深色與語系變更，供下一輪接續；不是完整 Git checkout 或資料庫備份，沒有自動恢復。</p><div class="links"><a href="source-checkpoint.zip" download>下載變更原始碼 ZIP</a><a href="source-manifest.json" download>下載檔案與 SHA-256 清單</a></div><p>行情、持倉與瀏覽器研究記錄請使用 AlphaView 內的工作區 ZIP 和 Alpha 研究 JSON 備份。</p></section>'
    document += section("completed", "完整開發清單")
    document += section("evidence", "必要驗收紀錄", "以新功能的計算口徑與主要操作為主，沒有用重複長測取代功能開發。")
    document += section("active", "斷點中的工作")
    document += section("deferred", "限制與後續前提")
    document += '<section id="timeline"><h2>開發紀錄</h2><details><summary>展開事件時間線</summary>' + ''.join(f'<article class="event"><div class="meta">{esc(local_time(event["at"]))} · {esc(event["kind"])}</div><h3>{esc(event["title"])}</h3><p>{esc(event["detail"])}</p></article>' for event in events) + '</details></section>'
    task_rows = []
    for value in state.get("next_tasks", []):
        match = re.match(r"^(P[123])\s*·\s*", value.get("title", ""))
        suggested = match.group(1) if match else "P2"
        display = {**value, "title": re.sub(r"^P[123]\s*·\s*", "", value.get("title", ""))}
        task_rows.append(f'<li><label class="review-step next-task" data-suggested-priority="{suggested}"><input type="checkbox"><span>{item(display)}</span></label><label class="priority">下一輪優先度 <select aria-label="下一輪任務優先度"><option value="P1">P1 優先開發</option><option value="P2" selected>P2 接續開發</option><option value="P3">P3 後續評估</option></select></label></li>')
    document += '<section id="next-tasks"><h2>下一輪可以做什麼</h2><p>勾選希望開發的項目、設定下一輪優先度，並填上你這次使用的觀察。預設值是建議，你選擇的優先度會隨 JSON 匯出。</p><ul>' + ''.join(task_rows) + '</ul></section>'

    document += '''<section><h2>你的 Review 備註</h2><label for="notes">哪些流程好用？哪些還不直覺？下一輪想先完成什麼？</label><p><textarea id="notes" rows="5" maxlength="6000"></textarea></p><button id="export" type="button">匯出 Review 與下一輪任務</button><p id="export-status" role="status"></p></section></body-marker><footer>AlphaView · Powered by <a href="https://tentenai.com">Tentenai.com</a><br>本機靜態檢閱報告；勾選與匯出不會修改專案、下單或傳送外部訊息。</footer></html>'''
    metadata = {key: state.get(key) for key in ("started_at", "deadline", "stopped_at", "status")}
    client = Path(__file__).with_name("alpha_review_client.js").read_text(encoding="utf-8")
    document = document.replace("</body-marker>", '<script id="review-meta" type="application/json">' + json.dumps(metadata) + '</script><script>' + client + '</script>')
    output = directory / "alpha-review.html"
    output.write_text(document, encoding="utf-8")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    print(render(parser.parse_args().directory))
