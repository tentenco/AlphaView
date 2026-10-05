"""Read-only readiness gate for unattended paper automation.

Every check is computed from the workspace's own records under one read
snapshot; missing evidence is reported as unavailable and never passes. The
gate certifies paper automation only: this product has no live-broker target,
so there is no 'live_ready' outcome here and nothing is promoted automatically.
"""
import hashlib
import json
import sqlite3

from fastapi import APIRouter, HTTPException, Query

from . import agent_automation as automation
from . import backup_preflight, broker_reconciliation, circuit_breakers, corporate_actions, decision_ledger, position_stops, regime_overlay, sessions, store
from . import paper_portfolio as paper

router = APIRouter()
ENGINE_VERSION = "alphaview-readiness-v3"
REQUIRED_HISTORY_SESSIONS = 20
RECENT_ATTEMPTS = 5
BLOCKING = ("account_not_paused", "no_tripped_breaker")
LABELS = {
    "mandate_active": "已啟用的自動化任務與執行目標",
    "jev_gate_declared": "Jev 決策閘已啟用或明確不用",
    "circuit_breakers_configured": "斷路器三項上限皆已設定",
    "position_stops_enabled": "部位停損已啟用",
    "alpaca_paper_orders": "Alpaca Paper 委託已啟用並有上限",
    "broker_book_reconciled": "Alpaca Paper 帳簿核對收據有效且一致（15 分鐘內）",
    "no_stale_unknown_orders": "沒有跨交易日仍未知結果的委託",
    "recent_attempts_clean": f"最近 {RECENT_ATTEMPTS} 次自動化嘗試沒有失敗",
    "nav_snapshot_current": "最新完成交易日已有完整淨值快照（每日報告可用）",
    "history_sessions": f"至少 {REQUIRED_HISTORY_SESSIONS} 個交易日的完整淨值紀錄",
    "account_not_paused": "帳戶未暫停",
    "no_tripped_breaker": "沒有觸發中的斷路器",
    "schema_current": "資料庫 schema 為目前版本",
    "regime_overlay_configured": "市場風險覆蓋已啟用且上限可計算",
    "corporate_actions_clear": "持股沒有疑似資料基礎不一致的公司行動",
    "position_stops_evaluable": "部位停損對每檔持股都可判斷",
    "outcome_hit_rate": "決策結果帳本命中率（10 個交易日地平線，至少 20 筆已結算）",
}
EVALUATION_ERRORS = (HTTPException, KeyError, TypeError, ValueError, sqlite3.OperationalError)
METHOD = (
    "Seventeen mechanical checks on the latest completed session, all read from local tables under one snapshot: the "
    "enabled mandate bound to the account and its execution target; whether its Jev gate is enabled or left off "
    "(recorded, not judged); every circuit-breaker limit set; position stops enabled with at least one stop; for an "
    "alpaca_paper target, the Alpaca Paper connection configured with orders enabled and caps (not applicable for "
    "paper_ledger); no execution order still 'unknown' from an earlier session; no 'failed' status among the last "
    f"{RECENT_ATTEMPTS} automation attempts (no attempts is unavailable); a complete NAV snapshot for the session; at "
    f"least {REQUIRED_HISTORY_SESSIONS} sessions with complete NAV snapshots; the account not paused; no tripped breaker; "
    "and the database schema signature registered as current; plus four v2 checks: the regime exposure overlay enabled "
    "with a computable cap (disabled is not applicable, recorded), no held symbol with a suspected split since entry "
    "whose price basis may be mixed (entry unknown everywhere is unavailable), position stops evaluable for every "
    "holding (disabled is not applicable), and the decision-outcome ledger's 10-session hit rate for rule-workflow "
    f"targets and the Jev gate (fail below {decision_ledger.HIT_RATE_LOW:.0%} with at least "
    f"{decision_ledger.HIT_RATE_MIN_SETTLED} settled decisions; fewer settled is unavailable). overall is blocked when the account is paused or a "
    "breaker is tripped, paper_ready when every check passes or does not apply, otherwise not_ready. Missing evidence "
    "is unavailable and never passes. The v3 broker-book check reads only the last local reconciliation receipt: for "
    "Alpaca Paper it must be matched, no older than 15 minutes, from the same latest completed session, connection "
    "version, broker identity, input revision and execution-book fingerprint. It never calls the broker or falls back "
    "to an older successful receipt. Local paper-ledger targets do not require it. The gate certifies unattended "
    "paper automation only; live_ready does not exist."
)
WARNINGS = [
    "這個閘只判斷本機 paper 自動化是否具備無人值守的條件；沒有實盤目標，也不會自動晉級任何設定。",
    "通過不代表策略有效或會獲利；它只確認防護與紀錄齊備。缺少證據一律視為不可用，不當作通過。",
    "每項檢查都可在對應面板補齊；本頁只讀，不修改任何設定。",
]


def _check(identifier, status, *, observed=None, required=None, reason=None, reason_code=None):
    return {"id": identifier, "label": LABELS[identifier], "status": status, "observed": observed,
            "required": required, "reason": reason, "reason_code": reason_code}


def schema_digest(db):
    rows = [dict(row) for row in db.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
    return hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _mandate(db, account_id):
    row = db.execute("SELECT * FROM agent_mandates WHERE account_id=? AND enabled=1 ORDER BY updated_at DESC LIMIT 1",
                     (account_id,)).fetchone()
    return dict(row) if row else None


def _alpaca(target):
    if target is None:
        return _check("alpaca_paper_orders", "unavailable", reason="沒有啟用的任務，無法得知執行目標", reason_code="no_mandate")
    if target != "alpaca_paper":
        return _check("alpaca_paper_orders", "not_applicable", observed=target, reason="執行目標是本機帳本，不需要券商連線",
                      reason_code="paper_ledger_target")
    from . import alpaca_paper
    try:
        public = alpaca_paper._public(alpaca_paper._read_config())
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "credential_file", "message": str(exc.detail)}
        return _check("alpaca_paper_orders", "unavailable", reason=detail.get("message"), reason_code=detail.get("code"))
    caps = public["order_caps"] or {}
    observed = ("orders enabled" if public["orders_enabled"] else "orders disabled" if public["configured"] else "not configured")
    if not public["configured"]:
        return _check("alpaca_paper_orders", "fail", observed=observed, required="connected + orders enabled",
                      reason="尚未設定 Alpaca Paper 連線", reason_code="not_configured")
    if not public["orders_enabled"]:
        return _check("alpaca_paper_orders", "fail", observed=observed, required="connected + orders enabled",
                      reason="Alpaca Paper 委託尚未以確認字串啟用", reason_code="orders_disabled")
    summary = "、".join(f"{key}={caps[key]}" for key in sorted(caps))
    return _check("alpaca_paper_orders", "pass", observed=f"{observed}；{summary}", required="connected + orders enabled")


def _book_reconciliation(db, target, as_of):
    identifier = "broker_book_reconciled"
    required = "matched receipt ≤15 minutes; same session, connection, account, inputs and execution book"
    if target is None:
        return _check(identifier, "unavailable", required=required, reason="沒有啟用的任務，無法得知執行目標", reason_code="no_mandate")
    if target != "alpaca_paper":
        return _check(identifier, "not_applicable", observed=target, required=required,
                      reason="執行目標是本機帳本，不需要券商核對收據", reason_code="paper_ledger_target")
    from . import alpaca_paper
    try:
        state = broker_reconciliation.receipt_state(db, alpaca_paper._read_config(), as_of)
    except EVALUATION_ERRORS:
        return _check(identifier, "unavailable", required=required, reason="本機核對收據或連線身份無法讀取",
                      reason_code="reconciliation_receipt_unavailable")
    receipt = state["receipt"]
    if receipt is None:
        return _check(identifier, "unavailable", required=required, reason="尚未保存帳簿核對收據；請到 Alpaca Paper 頁手動核對",
                      reason_code="receipt_missing")
    result = receipt["result"]
    observed = f"status={result.get('status')}；receipt_version={receipt['version']}；captured_at={receipt['captured_at']}；age_seconds={receipt['age_seconds']}"
    if not receipt["current"]:
        return _check(identifier, "unavailable", observed=observed, required=required,
                      reason="核對收據已過期或來源版本變更；請重新核對，不以上次一致結果替代",
                      reason_code=receipt["unavailable_reasons"][0])
    status = result.get("status")
    if result["broker"].get("status") != "available" or status == "unavailable":
        return _check(identifier, "unavailable", observed=observed, required=required,
                      reason="最近一次核對的券商資料不可用，未視為一致", reason_code="book_unavailable")
    if status != "matched":
        return _check(identifier, "fail", observed=observed, required=required,
                      reason="最近一次核對有漂移、無法解釋或未確定的委託；請檢閱帳簿核對明細",
                      reason_code=f"book_{status}")
    return _check(identifier, "pass", observed=observed, required=required)


def _regime(db, account_id, as_of):
    try:
        result = regime_overlay.evaluate(db, account_id, as_of)
    except EVALUATION_ERRORS:
        return _check("regime_overlay_configured", "unavailable", reason="市場風險覆蓋無法評估", reason_code="regime_evaluation_failed")
    policy, cap, regime = result["policy"], result["cap"], result["regime"]
    observed = (f"enabled={bool(policy.get('enabled'))}；mode={policy.get('mode')}；zone={regime.get('zone')}；"
                f"cap={cap.get('cap_pct')}；cap_status={cap.get('status')}")
    required = "enabled with a computable cap"
    if not policy.get("enabled"):
        return _check("regime_overlay_configured", "not_applicable", observed=observed, required=required,
                      reason="市場風險覆蓋未啟用；自動化不受總曝險上限約束（操作者的選擇，已記錄）", reason_code="overlay_disabled")
    if cap.get("status") != "ok":
        return _check("regime_overlay_configured", "fail", observed=observed, required=required,
                      reason="覆蓋已啟用但市場風險分數不完整，無法計算上限；block 模式會阻擋提案、scale 模式會略過縮放",
                      reason_code="regime_cap_unavailable")
    return _check("regime_overlay_configured", "pass", observed=observed, required=required)


def _corporate(db, account_id, as_of):
    try:
        summary = corporate_actions.account_summary(db, account_id, as_of)
    except EVALUATION_ERRORS:
        return _check("corporate_actions_clear", "unavailable", reason="公司行動偵測無法執行", reason_code="corporate_actions_failed")
    holdings = summary["holdings"]
    required = "no suspected mixed-basis split since entry"
    if not holdings:
        return _check("corporate_actions_clear", "pass", observed="no holdings", required=required)
    flagged = sorted({event["symbol"] for event in summary["events"]
                      if event.get("since_entry") and (event.get("data_consistency") or {}).get("flag") == "possible_mixed_basis"})
    if flagged:
        return _check("corporate_actions_clear", "fail", observed="、".join(flagged), required=required,
                      reason="持股自進場後偵測到疑似拆併股，且本機歷史可能混合拆分前後基礎；請先重新抓取完整歷史再自動化",
                      reason_code="mixed_basis_flag")
    if len(summary["entry_unknown"]) == len(holdings):
        return _check("corporate_actions_clear", "unavailable", observed="entry unknown: " + "、".join(summary["entry_unknown"]),
                      required=required, reason="所有持股都沒有進場紀錄，無法判斷進場後的公司行動", reason_code="entry_unknown")
    return _check("corporate_actions_clear", "pass", required=required,
                  observed=f"{len(holdings)} holdings；events_since_entry={len(summary['flagged'])}；entry_unknown={len(summary['entry_unknown'])}")


def _stops_evaluable(db, account_id, as_of, armed):
    required = "every holding evaluable"
    if not armed:
        return _check("position_stops_evaluable", "not_applicable", observed="stops disabled", required=required,
                      reason="部位停損未啟用（見 position_stops_enabled）", reason_code="stops_off")
    try:
        result = position_stops.evaluate(db, account_id, as_of)
    except EVALUATION_ERRORS:
        return _check("position_stops_evaluable", "unavailable", reason="部位停損無法評估", reason_code="stops_evaluation_failed")
    if result["unavailable"]:
        return _check("position_stops_evaluable", "fail", observed="、".join(result["unavailable"]), required=required,
                      reason="部分持股缺當期價格或進場紀錄，停損無法判斷", reason_code="stops_unavailable")
    return _check("position_stops_evaluable", "pass", required=required,
                  observed=f"{len(result['holdings'])} holdings evaluable；tripped={len(result['tripped'])}")


def _outcome(db, account_id, as_of):
    try:
        flags = decision_ledger.hit_rate_flags(db, account_id, as_of)
    except EVALUATION_ERRORS:
        return _check("outcome_hit_rate", "unavailable", reason="決策結果帳本無法讀取", reason_code="outcome_ledger_failed")
    observed = "；".join(f"{flag['family']}: settled={flag['n_settled']}, hit_rate={flag['hit_rate']}" for flag in flags["flags"])
    required = f"≥{flags['required_settled']} settled per family and hit rate ≥ {flags['low_threshold']}"
    low = [flag for flag in flags["flags"] if flag["status"] == "low"]
    if low:
        detail = "、".join(f"{flag['family']} 最近 {flag['n_settled']} 筆已結算決策命中率 {flag['hit_rate']:.0%}" for flag in low)
        return _check("outcome_hit_rate", "fail", observed=observed, required=required,
                      reason=f"{detail}，低於 {flags['low_threshold']:.0%}；先停用該來源的自動化並人工審閱", reason_code="hit_rate_low")
    if not any(flag["status"] == "ok" for flag in flags["flags"]):
        return _check("outcome_hit_rate", "unavailable", observed=observed, required=required,
                      reason=f"已結算的決策不足 {flags['required_settled']} 筆，命中率尚不可判斷", reason_code="insufficient_settled")
    return _check("outcome_hit_rate", "pass", observed=observed, required=required)


def evaluate(db, account_id, as_of):
    account = paper._account(db, account_id)
    checks = []
    mandate = _mandate(db, account_id)
    target = mandate["execution_target"] if mandate else None
    if mandate is None:
        checks.append(_check("mandate_active", "fail", observed="none", required="one enabled mandate",
                             reason="此帳戶沒有啟用中的自動化任務", reason_code="no_enabled_mandate"))
        checks.append(_check("jev_gate_declared", "unavailable", reason="沒有啟用的任務可讀取 Jev 閘設定", reason_code="no_mandate"))
    else:
        life = automation.lifecycle(mandate, as_of)
        observed = f"{mandate['name']}；mode={mandate['mode']}；target={target}；lifecycle={life['lifecycle']}"
        if life["blocked_code"]:
            checks.append(_check("mandate_active", "fail", observed=observed, required="one enabled, unexpired, authorized mandate",
                                 reason=life["message"], reason_code=life["lifecycle"]))
        else:
            checks.append(_check("mandate_active", "pass", observed=observed, required="one enabled, unexpired, authorized mandate",
                                 reason=life["message"], reason_code="expiring_soon" if life["lifecycle"] == "expiring_soon" else None))
        gate = json.loads(mandate["jev_gate_json"])
        checks.append(_check("jev_gate_declared", "pass", observed="enabled" if gate.get("enabled") else "declined",
                             required="enabled or declined",
                             reason=None if gate.get("enabled") else "任務未啟用 Jev 閘；以規則工作流直接提案", reason_code=None))
    policy, _ = circuit_breakers.current_policy(db, account_id)
    missing = [key for key in ("daily_loss_limit_pct", "max_drawdown_pct", "max_fills_per_session") if policy.get(key) is None]
    checks.append(_check("circuit_breakers_configured", "fail" if missing else "pass",
                         observed=("missing: " + "、".join(missing)) if missing else f"all set；auto_pause={policy['auto_pause']}",
                         required="daily_loss_limit_pct, max_drawdown_pct, max_fills_per_session",
                         reason="斷路器尚有上限未設定" if missing else None, reason_code="missing_limits" if missing else None))
    stops, _ = position_stops._policy_row(db, account_id)
    armed = bool(stops.get("enabled")) and (stops.get("stop_loss_pct") is not None or stops.get("trailing_stop_pct") is not None)
    checks.append(_check("position_stops_enabled", "pass" if armed else "fail",
                         observed=f"enabled={bool(stops.get('enabled'))}；stop_loss={stops.get('stop_loss_pct')}；trailing={stops.get('trailing_stop_pct')}",
                         required="enabled with a stop-loss or trailing stop",
                         reason=None if armed else "部位停損未啟用或沒有任何停損比例", reason_code=None if armed else "stops_off"))
    checks.append(_stops_evaluable(db, account_id, as_of, armed))
    checks.append(_regime(db, account_id, as_of))
    checks.append(_corporate(db, account_id, as_of))
    checks.append(_alpaca(target))
    checks.append(_book_reconciliation(db, target, as_of))
    stale = db.execute("""SELECT COUNT(*) FROM execution_orders o JOIN execution_submissions s ON s.id=o.submission_id
        WHERE o.account_id=? AND o.status='unknown' AND s.as_of<?""", (account_id, as_of)).fetchone()[0]
    checks.append(_check("no_stale_unknown_orders", "fail" if stale else "pass", observed=stale, required=0,
                         reason="有更早交易日送出的委託結果仍未知；請先核對" if stale else None,
                         reason_code="stale_unknown_orders" if stale else None))
    statuses = [row["status"] for row in db.execute(
        "SELECT status FROM agent_automation_attempts WHERE account_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?",
        (account_id, RECENT_ATTEMPTS))]
    if not statuses:
        checks.append(_check("recent_attempts_clean", "unavailable", observed="no attempts", required="no failed attempt",
                             reason="尚未有自動化嘗試紀錄", reason_code="no_attempts"))
    else:
        failed = statuses.count("failed")
        checks.append(_check("recent_attempts_clean", "fail" if failed else "pass", observed="、".join(statuses),
                             required="no failed attempt", reason=f"最近有 {failed} 次嘗試失敗" if failed else None,
                             reason_code="failed_attempts" if failed else None))
    checks.append(_outcome(db, account_id, as_of))
    complete = set()
    for row in db.execute("SELECT as_of, snapshot_json FROM paper_nav_snapshots WHERE account_id=? AND as_of<=?", (account_id, as_of)):
        snapshot = json.loads(row["snapshot_json"])
        if snapshot.get("valuation_complete") and snapshot.get("equity") is not None:
            complete.add(row["as_of"])
    latest = max(complete) if complete else None
    current = latest == as_of
    checks.append(_check("nav_snapshot_current", "pass" if current else "fail", observed=latest or "none", required=as_of,
                         reason=None if current else "最新完成交易日還沒有完整淨值快照；每日報告的淨值變動不可用",
                         reason_code=None if current else "nav_not_captured"))
    checks.append(_check("history_sessions", "pass" if len(complete) >= REQUIRED_HISTORY_SESSIONS else "fail",
                         observed=len(complete), required=REQUIRED_HISTORY_SESSIONS,
                         reason=None if len(complete) >= REQUIRED_HISTORY_SESSIONS else "完整淨值紀錄的交易日數不足",
                         reason_code=None if len(complete) >= REQUIRED_HISTORY_SESSIONS else "history_too_short"))
    paused = bool(account["kill_switch"])
    checks.append(_check("account_not_paused", "fail" if paused else "pass", observed="paused" if paused else "active",
                         required="active", reason="帳戶暫停中；先檢閱後手動恢復" if paused else None,
                         reason_code="kill_switch" if paused else None))
    breaker = circuit_breakers.evaluate(db, account_id, as_of)
    checks.append(_check("no_tripped_breaker", "fail" if breaker["tripped"] else "pass",
                         observed=("tripped: " + "、".join(breaker["tripped_codes"])) if breaker["tripped"]
                         else ("unavailable: " + "、".join(breaker["unavailable"])) if breaker["unavailable"] else "none tripped",
                         required="none tripped", reason="斷路器觸發中" if breaker["tripped"] else None,
                         reason_code="circuit_breaker_tripped" if breaker["tripped"] else None))
    digest = schema_digest(db)
    known = backup_preflight.KNOWN_SCHEMAS.get(digest)
    checks.append(_check("schema_current", "pass" if known == "current" else "fail" if known else "unavailable",
                         observed=known or "unregistered", required="current",
                         reason=None if known == "current" else "資料庫 schema 未登記為目前版本；請先完成遷移或登記",
                         reason_code=None if known == "current" else ("migration_required" if known else "unregistered_schema")))
    blocked = any(check["id"] in BLOCKING and check["status"] == "fail" for check in checks)
    ready = all(check["status"] in ("pass", "not_applicable") for check in checks)
    summary = {status: sum(check["status"] == status for check in checks) for status in ("pass", "fail", "unavailable", "not_applicable")}
    warnings = list(WARNINGS)
    if breaker["unavailable"] and not breaker["tripped"]:
        warnings.append("部分斷路器檢查不可用（缺快照或估值不完整）；不可用不會觸發，也不代表安全。")
    return {"engine_version": ENGINE_VERSION, "account_id": account_id, "account_version": account["version"], "as_of": as_of,
            "overall": "blocked" if blocked else "paper_ready" if ready else "not_ready", "execution_target": target,
            "checks": checks, "summary": summary, "method": METHOD, "warnings": warnings}


@router.get("/api/trading-agent/readiness")
@store.snapshot_read
def readiness(account_id: str = Query(min_length=1, max_length=100)):
    with store.connect() as db:
        result = evaluate(db, account_id, sessions.latest_completed_session())
        return {**result, "input_revision": store.input_revision(db)}
