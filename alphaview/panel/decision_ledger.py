"""Decision and signal outcome ledger: settle a past decision only after its horizon elapsed.

Published scan signals, rule-workflow target changes, Jev gate decisions and
(optionally) one paper account's simulated fills are measured against later local
bars: entry at the next session's adjusted open, exit at the horizon session's
adjusted close. Unsettled decisions stay pending, missing bars stay unavailable,
and nothing is back-filled. Read-only; no schema, no trading, no forecast.
"""
import csv
import io
import json
import math
import sqlite3
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from . import jev_decision, paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-decision-outcome-v1"
BENCHMARK = "SPY"
HORIZONS = (5, 10, 20)
LOW_SAMPLE = 5
LOW_SAMPLE_CORRELATION = 10
MAX_ITEMS = 500
SCORE_QUESTION = "setup_quality"
BINS = ((0.0, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.0))
PRICE_BASIS = ("進場＝決策交易日之後第一個交易日的調整開盤（open × adj_close ÷ close）；"
               "出場＝之後第 N 個交易日的調整收盤；報酬＝出場 ÷ 進場 − 1。")
STRATEGY_LABELS = {"turtle": ("海龜突破", "Turtle breakout"), "trend": ("趨勢跟隨", "Trend following"),
                   "pullback": ("RSI 回檔", "RSI pullback"), "rps": ("相對強度", "Relative strength")}
TARGET_KINDS = {"added": ("新增", "Added"), "increased": ("加碼", "Increased"),
                "decreased": ("減碼", "Decreased"), "removed": ("移除", "Removed")}
GATE_KINDS = {"pass": ("通過門檻", "Passed gate"), "fail": ("未通過（歸零）", "Failed (zeroed)"),
              "unavailable": ("不可用（歸零）", "Unavailable (zeroed)")}
FILL_KINDS = {"buy": ("紙上買進", "Paper buy"), "sell": ("紙上賣出", "Paper sell")}
# Only questions whose realization is mechanically decidable from later bars are calibrated.
REALIZATIONS = {
    "overextended": {"kind": "pullback", "label": "回檔", "english": "Pullback",
                     "description": "事件＝地平線內前向報酬為負（次日調整開盤 → 期末調整收盤）。這是『回檔風險升高』的代理事件。"},
    "uptrend_intact": {"kind": "uptrend_criteria_hold", "label": "期末趨勢條件仍成立", "english": "Uptrend criteria still hold at horizon",
                       "description": "事件＝期末交易日的調整收盤 > MA50 > MA200（以本機調整收盤計算，需 200 根日線；不足則不可用）。"
                                      "衡量模型判定的狀態是否延續，不是報酬預測。"},
}
UNSCORABLE = {
    "buying_pressure": "問題描述當下量價狀態（『買盤正在增強』），沒有可機械判定的未來事件，不校準。",
    "setup_quality": "score 型答案是等級分數，不是單一事件的機率，不做機率校準。",
}
METHOD = (
    "決策家族：已發布選股快照的 match 訊號（同日同範圍只取最後一次快照）；規則工作流 proposed 目標與前一次同範圍目標的差異"
    "（新增／加碼／減碼／移除，同日只取最後一次）；Jev 決策閘每個標的的門檻結果（同日同標的只取最後一次）；指定虛擬帳戶的紙上模擬成交。"
    f"結算：只在決策交易日之後已完成 N 個 XNYS 交易日時計算，否則列為 pending。{PRICE_BASIS}"
    f"超額＝標的報酬 − {BENCHMARK} 同一進出場交易日的報酬；本機沒有 {BENCHMARK} 日線時超額為不可用，不改用其他基準。"
    "命中：做多決策（訊號、新增、加碼、通過、買進）以正報酬為命中；減碼／移除／未通過／賣出以負報酬（避開虧損）為命中。"
    "校準：只對能以後續日線機械判定的 Jev 問題，把機率分成五個等寬區間，比較平均預測機率與實現頻率，並計算 Brier 分數；"
    "其餘問題列為不可校準。樣本數低於 5 的統計標示 low_sample。"
)
WARNINGS = [
    "這不是實盤績效紀錄：所有報酬都是本機日線的事後量測，沒有成交、費用、滑價或部位大小。",
    "進場採決策日之後第一個交易日的調整開盤，與回測口徑一致；跳空與流動性不在計算內。",
    "分母只包含本機股池仍保有日線的標的；下市或被移出股池的標的會消失（存活者偏差）。",
    "樣本數很小時命中率、平均報酬與校準區間都不穩定；low_sample 表示該統計少於 5 筆。",
    "Jev 問題的實現條件是程式定義的代理事件，不是模型當初被問的原句；校準只衡量代理事件。",
    "不是投資建議，也不能證明任何策略或決策閘可靠；只能用來發現需要重新檢視的家族。",
]


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _round(value, digits=4):
    return None if value is None else round(value, digits)


def _mean(values):
    return math.fsum(values) / len(values) if values else None


def _after(decision, latest):
    """XNYS sessions strictly after the decision session, up to the latest completed one."""
    if decision >= latest:
        return []
    return [day for day in sessions.expected_sessions(decision, latest) if day > decision]


def _window(latest, window_sessions):
    anchor = date.fromisoformat(latest)
    lower = (anchor - timedelta(days=window_sessions * 2 + 14)).isoformat()
    return sessions.expected_sessions(lower, latest)[-window_sessions:]


class _Bars:
    """Per-request cache over the bars table; never fills a missing row."""

    def __init__(self, db):
        self.db, self.cache = db, {}

    def get(self, symbol, day):
        key = (symbol, day)
        if key not in self.cache:
            row = self.db.execute("SELECT open,close,adj_close FROM bars WHERE symbol=? AND date=?", key).fetchone()
            self.cache[key] = dict(row) if row else None
        return self.cache[key]

    def history(self, symbol, day, count):
        rows = self.db.execute("SELECT date,adj_close FROM bars WHERE symbol=? AND date<=? ORDER BY date DESC LIMIT ?",
                               (symbol, day, count)).fetchall()
        return [dict(row) for row in rows]


def _return(bars, symbol, entry_session, exit_session):
    entry = bars.get(symbol, entry_session)
    if entry is None:
        return None, "entry_bar_missing"
    if not all(_finite(entry[key]) and entry[key] > 0 for key in ("open", "close", "adj_close")):
        return None, "entry_bar_invalid"
    exit_bar = bars.get(symbol, exit_session)
    if exit_bar is None:
        return None, "exit_bar_missing"
    if not (_finite(exit_bar["adj_close"]) and exit_bar["adj_close"] > 0):
        return None, "exit_bar_invalid"
    adjusted_open = entry["open"] * entry["adj_close"] / entry["close"]
    return (exit_bar["adj_close"] / adjusted_open - 1) * 100, None


def _settle(bars, symbol, decision_session, horizon, latest):
    after = _after(decision_session, latest)
    outcome = {"status": "pending", "entry_session": after[0] if after else None, "exit_session": None,
               "sessions_elapsed": min(len(after), horizon), "return_pct": None, "excess_pct": None,
               "benchmark_return_pct": None, "reason": "horizon_not_elapsed"}
    if len(after) < horizon:
        return outcome
    entry_session, exit_session = after[0], after[horizon - 1]
    outcome.update(exit_session=exit_session, sessions_elapsed=horizon)
    value, reason = _return(bars, symbol, entry_session, exit_session)
    if value is None:
        outcome.update(status="unavailable", reason=reason)
        return outcome
    benchmark, benchmark_reason = _return(bars, BENCHMARK, entry_session, exit_session)
    outcome.update(status="settled", return_pct=_round(value), reason=None,
                   benchmark_return_pct=_round(benchmark),
                   excess_pct=_round(value - benchmark) if benchmark is not None else None,
                   excess_reason=None if benchmark is not None else "benchmark_unavailable")
    return outcome


def _hit(direction, outcome):
    if outcome["status"] != "settled" or direction is None:
        return None
    return outcome["return_pct"] > 0 if direction == "long" else outcome["return_pct"] < 0


# --- Decision families (read existing tables only) ---

def _scan_decisions(db, window):
    rows = db.execute("""SELECT id, as_of, result FROM scans WHERE id IN (
            SELECT MAX(id) FROM scans WHERE as_of>=? AND as_of<=? GROUP BY as_of, scope) ORDER BY as_of, id""",
                      (window[0], window[-1]))
    decisions, seen = [], set()
    for row in rows:
        try:
            items = json.loads(row["result"])
        except (TypeError, ValueError):
            continue
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict) or item.get("date") != row["as_of"] or not isinstance(item.get("symbol"), str):
                continue
            for signal in item.get("signals") or []:
                if not (isinstance(signal, dict) and signal.get("status") == "match" and signal.get("matched") is True):
                    continue
                key = (row["as_of"], item["symbol"], signal.get("strategy"))
                if key in seen or not isinstance(key[2], str):
                    continue
                seen.add(key)
                decisions.append({"family": "scan_signals", "kind": key[2], "symbol": item["symbol"],
                                  "decision_session": row["as_of"], "direction": "long", "source_id": f"scan:{row['id']}"})
    return decisions


def _agent_decisions(db, window):
    rows = db.execute("SELECT id, as_of, created_at, result FROM portfolio_agent_runs WHERE status='proposed' AND as_of<=? "
                      "ORDER BY as_of, created_at, id", (window[-1],))
    latest_runs = {}
    for row in rows:
        try:
            result = json.loads(row["result"])
        except (TypeError, ValueError):
            continue
        if not isinstance(result, dict):
            continue
        request = result.get("request") if isinstance(result.get("request"), dict) else {}
        scope = request.get("scope") if isinstance(request.get("scope"), str) else "portfolio"
        weights = {}
        for target in result.get("target_weights") or []:
            if isinstance(target, dict) and isinstance(target.get("symbol"), str) and _finite(target.get("weight_pct")):
                weights[target["symbol"]] = float(target["weight_pct"])
        latest_runs[(scope, row["as_of"])] = (row["id"], weights)
    decisions, previous = [], {}
    for (scope, as_of), (run_id, weights) in sorted(latest_runs.items()):
        before = previous.get(scope, {})
        if as_of >= window[0]:
            for symbol in sorted(set(before) | set(weights)):
                old, new = before.get(symbol, 0.0), weights.get(symbol, 0.0)
                if new == old:
                    continue
                kind = ("added" if old == 0 else "increased") if new > old else ("removed" if new == 0 else "decreased")
                decisions.append({"family": "agent_targets", "kind": kind, "symbol": symbol, "decision_session": as_of,
                                  "direction": "long" if new > old else "exit", "source_id": f"agent_run:{run_id}",
                                  "weight_from_pct": old, "weight_to_pct": new})
        previous[scope] = weights
    return decisions


def _jev_decisions(db, window):
    try:
        rows = db.execute("SELECT id, as_of, created_at, status, result_json FROM jev_decision_runs "
                          "WHERE as_of>=? AND as_of<=? ORDER BY as_of, created_at, id", (window[0], window[-1])).fetchall()
    except sqlite3.OperationalError:
        return [], []
    latest = {}
    for row in rows:
        try:
            result = json.loads(row["result_json"])
        except (TypeError, ValueError):
            continue
        decisions_json = result.get("decisions") if isinstance(result, dict) else None
        for decision in decisions_json if isinstance(decisions_json, list) else []:
            if isinstance(decision, dict) and isinstance(decision.get("symbol"), str):
                latest[(row["as_of"], decision["symbol"])] = (row["id"], row["status"], decision)
    decisions, samples = [], []
    for (as_of, symbol), (run_id, status, decision) in sorted(latest.items()):
        gate = decision.get("status") if decision.get("status") in GATE_KINDS else "unavailable"
        probabilities = {}
        for check in decision.get("checks") or []:
            if isinstance(check, dict) and isinstance(check.get("question"), str) and _finite(check.get("value")):
                probabilities[check["question"]] = float(check["value"])
        quality = decision.get(SCORE_QUESTION)
        score = float(quality["score"]) if isinstance(quality, dict) and _finite(quality.get("score")) else None
        decisions.append({"family": "jev_gate", "kind": gate, "symbol": symbol, "decision_session": as_of,
                          "direction": {"pass": "long", "fail": "exit"}.get(gate), "source_id": f"jev_run:{run_id}",
                          "run_status": status, "probabilities": probabilities, "setup_quality_score": score})
        for question, probability in probabilities.items():
            samples.append({"question": question, "probability": probability, "symbol": symbol, "decision_session": as_of})
    return decisions, samples


def _fill_decisions(db, account_id, window):
    rows = db.execute("""SELECT l.id, l.symbol, l.shares_delta, l.proposal_id, json_extract(p.preview_json, '$.as_of') AS session
        FROM paper_ledger l JOIN paper_proposals p ON p.id = l.proposal_id
        WHERE l.account_id=? AND l.kind='simulated_fill'
          AND json_extract(p.preview_json, '$.as_of')>=? AND json_extract(p.preview_json, '$.as_of')<=? ORDER BY l.id""",
                      (account_id, window[0], window[-1]))
    decisions = []
    for row in rows:
        try:
            delta = float(row["shares_delta"])
        except (TypeError, ValueError):
            continue
        if not row["symbol"] or not _finite(delta) or delta == 0 or not isinstance(row["session"], str):
            continue
        kind = "buy" if delta > 0 else "sell"
        decisions.append({"family": "paper_fills", "kind": kind, "symbol": row["symbol"], "decision_session": row["session"],
                          "direction": "long" if delta > 0 else "exit", "source_id": f"ledger:{row['id']}"})
    return decisions


# --- Aggregation ---

def _summary(items):
    settled = [item for item in items if item["outcome"]["status"] == "settled" and item["direction"]]
    hits = [item for item in settled if item["hit"]]
    returns = [item["outcome"]["return_pct"] for item in settled]
    excess = [item["outcome"]["excess_pct"] for item in settled if item["outcome"]["excess_pct"] is not None]
    reason = None
    if not items:
        reason = "no_decisions"
    elif not settled:
        reason = "no_direction" if all(item["direction"] is None for item in items) else "no_settled_decisions"
    return {"n": len(items), "n_settled": len(settled),
            "n_pending": sum(item["outcome"]["status"] == "pending" for item in items),
            "n_unavailable": sum(item["outcome"]["status"] == "unavailable" for item in items),
            "hit_rate": _round(len(hits) / len(settled)) if settled else None, "hits": len(hits),
            "mean_return_pct": _round(_mean(returns)), "mean_excess_pct": _round(_mean(excess)),
            "excess_coverage": {"n": len(excess), "of": len(settled),
                                "reason": None if excess or not settled else "benchmark_unavailable"},
            "low_sample": len(settled) < LOW_SAMPLE, "reason": reason}


def _family(identifier, label, english, kinds, items):
    groups = []
    for kind, (zh, en) in kinds.items():
        subset = [item for item in items if item["kind"] == kind]
        groups.append({"kind": kind, "label": zh, "english": en, "direction": next((item["direction"] for item in subset), None),
                       **_summary(subset)})
    unknown = [item for item in items if item["kind"] not in kinds]
    if unknown:
        groups.append({"kind": "other", "label": "其他", "english": "Other", "direction": None, **_summary(unknown)})
    return {"id": identifier, "label": label, "english": english, "groups": groups, "total": _summary(items)}


def _realize(bars, question, item):
    outcome = item["outcome"]
    if outcome["status"] == "pending":
        return None, "horizon_not_elapsed"
    kind = REALIZATIONS[question]["kind"]
    if kind == "pullback":
        if outcome["status"] != "settled":
            return None, outcome["reason"]
        return outcome["return_pct"] < 0, None
    history = bars.history(item["symbol"], outcome["exit_session"], 200)
    if len(history) < 200 or history[0]["date"] != outcome["exit_session"]:
        return None, "history_insufficient"
    closes = [row["adj_close"] for row in history]
    if not all(_finite(close) and close > 0 for close in closes):
        return None, "history_invalid"
    ma50, ma200 = _mean(closes[:50]), _mean(closes)
    return closes[0] > ma50 > ma200, None


def _ranks(values):
    """Average ranks (1-based) with ties sharing the mean rank."""
    order = sorted(range(len(values)), key=lambda index: values[index])
    ranks = [0.0] * len(values)
    position = 0
    while position < len(order):
        end = position
        while end + 1 < len(order) and values[order[end + 1]] == values[order[position]]:
            end += 1
        mean_rank = (position + end) / 2 + 1
        for index in order[position:end + 1]:
            ranks[index] = mean_rank
        position = end + 1
    return ranks


def _spearman(xs, ys):
    if len(xs) < 2:
        return None
    rx, ry = _ranks(xs), _ranks(ys)
    mx, my = _mean(rx), _mean(ry)
    cov = math.fsum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx, vy = math.fsum((a - mx) ** 2 for a in rx), math.fsum((b - my) ** 2 for b in ry)
    if vx == 0 or vy == 0:
        return None
    return cov / math.sqrt(vx * vy)


def _score_correlation(jev_items):
    """Spearman rank correlation between the Jev setup_quality score and the realized horizon return."""
    scored = [item for item in jev_items if item.get("setup_quality_score") is not None]
    settled = [item for item in scored if item["outcome"]["status"] == "settled"]
    block = {"question": SCORE_QUESTION, "status": "unavailable", "reason": None, "n": len(settled),
             "n_pending": sum(item["outcome"]["status"] == "pending" for item in scored),
             "n_unavailable": sum(item["outcome"]["status"] == "unavailable" for item in scored),
             "spearman": None, "low_sample": len(settled) < LOW_SAMPLE_CORRELATION,
             "method": "Spearman 等級相關：setup_quality 分數 vs 地平線實現報酬（已結算的 Jev 決策，同分取平均名次）。"}
    if not scored:
        block["reason"] = "question_absent"
        return block
    if len(settled) < 2:
        block["reason"] = "insufficient_settled"
        return block
    value = _spearman([item["setup_quality_score"] for item in settled], [item["outcome"]["return_pct"] for item in settled])
    if value is None:
        block["reason"] = "no_variance"
        return block
    block.update(status="available", spearman=_round(value))
    return block


def _calibration(bars, samples, jev_items):
    by_key = {(item["decision_session"], item["symbol"]): item for item in jev_items}
    labels = {question["id"]: question for question in jev_decision.QUESTIONS}
    questions = []
    for question, spec in REALIZATIONS.items():
        rows = [sample for sample in samples if sample["question"] == question]
        scored, pending, unavailable = [], 0, {}
        for sample in rows:
            item = by_key[(sample["decision_session"], sample["symbol"])]
            realized, reason = _realize(bars, question, item)
            if realized is None:
                if reason == "horizon_not_elapsed":
                    pending += 1
                else:
                    unavailable[reason] = unavailable.get(reason, 0) + 1
                continue
            scored.append((sample["probability"], 1.0 if realized else 0.0))
        bins = []
        for low, high in BINS:
            inside = [(p, y) for p, y in scored if low <= p < high or (high == 1.0 and p == 1.0)]
            bins.append({"range": [low, high], "n": len(inside),
                         "mean_predicted": _round(_mean([p for p, _ in inside])),
                         "realized_rate": _round(_mean([y for _, y in inside])), "low_sample": len(inside) < LOW_SAMPLE})
        questions.append({"id": question, "label": labels.get(question, {}).get("label", question),
                          "english": labels.get(question, {}).get("english", question), "realization": spec,
                          "n": len(scored), "n_pending": pending, "unavailable": unavailable,
                          "brier": _round(_mean([(p - y) ** 2 for p, y in scored])),
                          "base_rate": _round(_mean([y for _, y in scored])),
                          "mean_predicted": _round(_mean([p for p, _ in scored])),
                          "bins": bins, "low_sample": len(scored) < LOW_SAMPLE})
    unscorable = [{"id": identifier, "label": question["label"], "english": question["english"],
                   "reason": UNSCORABLE.get(identifier, "尚未定義可機械判定的實現條件。")}
                  for identifier, question in labels.items() if identifier not in REALIZATIONS]
    return {"questions": questions, "unscorable": unscorable, "bins": [list(edge) for edge in BINS],
            "score_correlation": _score_correlation(jev_items),
            "note": "機率來自 Jev 決策紀錄中每個門檻檢查的答案；同日同標的只取最後一次紀錄。"}


def build(db, account_id, horizon, window_sessions, *, max_items=MAX_ITEMS):
    if horizon not in HORIZONS:
        raise HTTPException(422, {"code": "invalid_horizon", "message": f"地平線必須是 {', '.join(map(str, HORIZONS))} 個交易日"})
    latest = sessions.latest_completed_session()
    window = _window(latest, window_sessions)
    account = paper._account(db, account_id) if account_id else None
    bars = _Bars(db)
    decisions = _scan_decisions(db, window) + _agent_decisions(db, window)
    jev_items, samples = _jev_decisions(db, window)
    decisions += jev_items
    if account is not None:
        decisions += _fill_decisions(db, account["id"], window)
    for item in decisions:
        item["outcome"] = _settle(bars, item["symbol"], item["decision_session"], horizon, latest)
        item["hit"] = _hit(item["direction"], item["outcome"])
    for item in jev_items:
        item["realizations"] = {}
        for question in REALIZATIONS:
            if question in item["probabilities"]:
                realized, reason = _realize(bars, question, item)
                item["realizations"][question] = {"realized": realized, "reason": reason}
    families = [
        _family("scan_signals", "選股訊號", "Scan signals", STRATEGY_LABELS, [d for d in decisions if d["family"] == "scan_signals"]),
        _family("agent_targets", "規則工作流目標變動", "Rule-workflow target changes", TARGET_KINDS, [d for d in decisions if d["family"] == "agent_targets"]),
        _family("jev_gate", "Jev 決策閘", "Jev decision gate", GATE_KINDS, jev_items),
    ]
    if account is not None:
        families.append(_family("paper_fills", "紙上模擬成交", "Paper simulated fills", FILL_KINDS,
                                [d for d in decisions if d["family"] == "paper_fills"]))
    warnings = list(WARNINGS)
    settled = [item for item in decisions if item["outcome"]["status"] == "settled"]
    if settled and all(item["outcome"]["excess_pct"] is None for item in settled):
        warnings.append(f"本機沒有 {BENCHMARK} 日線可對齊進出場交易日，所有超額報酬不可用。")
    if not decisions:
        warnings.append("窗口內沒有任何可結算的決策；先發布選股、保存規則工作流或執行 Jev 決策閘。")
    items = sorted(decisions, key=lambda item: (item["decision_session"], item["family"], item["symbol"]), reverse=True)
    return {"engine_version": ENGINE_VERSION, "as_of": latest, "input_revision": store.input_revision(db),
            "generated_at": store.now(), "horizon_sessions": horizon, "horizons": list(HORIZONS),
            "window": {"sessions": window_sessions, "start": window[0], "end": window[-1]},
            "account": {"id": account["id"], "name": account["name"]} if account else None,
            "price_basis": PRICE_BASIS, "benchmark": BENCHMARK, "low_sample_threshold": LOW_SAMPLE,
            "families": families, "calibration": _calibration(bars, samples, jev_items),
            "items": items[:max_items] if max_items else items,
            "items_truncated": bool(max_items) and len(items) > max_items, "items_total": len(items),
            "method": METHOD, "warnings": warnings}


HIT_RATE_FAMILIES = ("agent_targets", "jev_gate")
HIT_RATE_HORIZON = 10
HIT_RATE_MIN_SETTLED = 20
HIT_RATE_LOW = 0.4
HIT_RATE_WINDOW = 252


def hit_rate_flags(db, account_id, as_of, *, horizon=HIT_RATE_HORIZON, window_sessions=HIT_RATE_WINDOW):
    """Shared go/no-go signal for the readiness gate and automation: settled count and hit rate per decision family.

    Settlement always uses the latest completed session (as in `build`); `as_of` is echoed for the caller. A family is
    `low` only with at least HIT_RATE_MIN_SETTLED settled decisions and a hit rate below HIT_RATE_LOW; fewer settled
    decisions are `insufficient`, which is neither a pass nor a fail. The two families are workspace-wide (rules runs
    and Jev runs are not bound to one account); the account only adds its paper fills, which are not judged here.
    """
    data = build(db, account_id, horizon, window_sessions, max_items=1)
    flags = []
    for family in data["families"]:
        if family["id"] not in HIT_RATE_FAMILIES:
            continue
        total = family["total"]
        settled, rate = total["n_settled"], total["hit_rate"]
        status = "insufficient" if settled < HIT_RATE_MIN_SETTLED else "low" if rate < HIT_RATE_LOW else "ok"
        flags.append({"family": family["id"], "label": family["label"], "english": family["english"],
                      "n_settled": settled, "hit_rate": rate, "status": status})
    return {"engine_version": ENGINE_VERSION, "as_of": as_of, "settled_as_of": data["as_of"], "horizon_sessions": horizon,
            "window_sessions": window_sessions, "required_settled": HIT_RATE_MIN_SETTLED, "low_threshold": HIT_RATE_LOW,
            "flags": flags, "low": [flag["family"] for flag in flags if flag["status"] == "low"]}


HorizonParam = Annotated[int, Query(ge=1, le=60)]
WindowParam = Annotated[int, Query(ge=5, le=252)]


@router.get("/api/trading-agent/outcomes")
@store.snapshot_read
def outcomes(account_id: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
             horizon_sessions: HorizonParam = 10, window_sessions: WindowParam = 60):
    with store.connect() as db:
        return build(db, account_id, horizon_sessions, window_sessions)


# --- CSV export (one row per decision; pending and unavailable rows keep empty numeric cells) ---

CSV_COLUMNS = ["family", "decision", "symbol", "decision_session", "direction", "horizon_sessions", "entry_session",
               "exit_session", "status", "return_pct", "benchmark", "benchmark_return_pct", "excess_pct", "excess_reason",
               "reason", "hit", "weight_from_pct", "weight_to_pct",
               *[f"jev_{question}_probability" for question in REALIZATIONS],
               *[f"jev_{question}_realized" for question in REALIZATIONS],
               f"jev_{SCORE_QUESTION}_score", "source_id", "engine_version", "input_revision"]


def _cell(value):
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    if isinstance(value, bool):
        return "true" if value else "false"
    return "" if value is None else value


def outcomes_csv_text(data):
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(CSV_COLUMNS)
    for item in data["items"]:
        outcome = item["outcome"]
        probabilities = item.get("probabilities") or {}
        realizations = item.get("realizations") or {}
        writer.writerow([_cell(value) for value in (
            item["family"], item["kind"], item["symbol"], item["decision_session"], item["direction"], data["horizon_sessions"],
            outcome["entry_session"], outcome["exit_session"], outcome["status"], outcome["return_pct"], data["benchmark"],
            outcome["benchmark_return_pct"], outcome["excess_pct"], outcome.get("excess_reason"), outcome["reason"], item["hit"],
            item.get("weight_from_pct"), item.get("weight_to_pct"),
            *[probabilities.get(question) for question in REALIZATIONS],
            *[(realizations.get(question) or {}).get("realized") for question in REALIZATIONS],
            item.get("setup_quality_score"), item["source_id"], data["engine_version"], data["input_revision"])])
    return stream.getvalue()


@router.get("/api/trading-agent/outcomes.csv")
@store.snapshot_read
def outcomes_csv(account_id: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
                 horizon_sessions: HorizonParam = 10, window_sessions: WindowParam = 60):
    with store.connect() as db:
        data = build(db, account_id, horizon_sessions, window_sessions, max_items=None)
    filename = f"decision-outcomes-{data['as_of']}-h{horizon_sessions}-w{window_sessions}.csv"
    return Response(outcomes_csv_text(data), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"})
