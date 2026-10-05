"""Read-only operational inbox for local paper accounts and automation tasks."""
import json
import sqlite3
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query

from . import agent_automation, inbox_acknowledgements, paper_next_open, paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-portfolio-inbox-v3"
METHOD = (
    "在同一本機讀取快照整理所有虛擬帳戶、未結案提案及排程狀態。"
    "提案的新鮮度逐一比對帳戶版本、行情輸入版本、完成交易日、paper 方法與自動化來源。"
    "待審只表示目前保存的預覽仍有效，不代表已通過接受時的重新檢查。"
    "總數由完整資料計數；提案清單按建立時間由新到舊分頁，不將截斷清單當作完整覆蓋。"
    "來源篩選只作用於未結案提案，先依既有提案來源標記分類完整清單，再分頁；未有明確來源標記或來源衝突列為 unknown，不推定手動。"
    "來源標籤表示保存的證據，不代表授權仍有效；固定理由前綴只列為可複製的 program_marker，並非作者驗證；提案新鮮度仍獨立核對。"
    "來源計數與風險、收據、委託總數不受篩選影響。"
    "次日開盤委託獨立按更新時間分頁，同一委託只列一筆，所有真實處理嘗試保留於委託明細。"
    "委託連結只開啟對應物件；重查、重試與取消仍依原授權及委託版本重新驗證。"
    "執行事件由 Alpaca Paper 委託紀錄推導：每筆委託目前狀態對應一個事件（成交、部分成交、到期、取消、拒單、結果未知），"
    "鍵為委託編號加狀態，重讀不會重複；到期或取消前已成交的數量另標示部分成交。"
    "需要處理清單（attention）由同一快照的既有紀錄推導：任務授權生命週期、帳戶暫停、斷路器觸發、委託清掃、部位停損觸發、"
    "公司行動偵測、拒單與結果未知的 Alpaca 委託（跨交易日仍未知者另標 stale）；每筆有穩定鍵，重讀不重複；"
    "任一來源模組評估失敗時以一筆 source_unavailable 說明，不影響其他來源，也不代表該來源沒有事項。"
    "已檢閱收據只對當次完整事件內容有效，內容變更會重新顯示未檢閱；不會減少原有嚴重度總數。"
    "此頁不建立提案、不啟用排程、不更動帳戶，也不讀取真實持股或筆記。"
)
SEVERITY_ORDER = {"critical": 0, "warn": 1, "info": 2}
MANDATE_SEVERITY = {"expired": "critical", "reauth_required": "critical", "expiring_soon": "warn"}
MANDATE_TITLES = {"expired": ("任務授權已到期", "Mandate authorization expired"),
                  "reauth_required": ("任務需重新授權", "Mandate needs re-authorization"),
                  "expiring_soon": ("任務授權即將到期", "Mandate authorization expiring soon")}
ATTENTION_LIMIT = 200
SOURCE_ERRORS = (sqlite3.OperationalError, HTTPException, KeyError, TypeError, ValueError, AttributeError, ImportError)
EXECUTION_EVENT_KINDS = {"filled": "execution_filled", "partially_filled": "execution_partial", "expired": "execution_expired",
                         "cancelled": "execution_cancelled", "rejected": "execution_rejected", "unknown": "execution_unknown_outcome"}
ProposalSource = Literal["all", "automation", "local_agent", "jev", "position_stops", "strategy_bridge", "rules_workflow", "unknown"]
PROPOSAL_SOURCES = ("automation", "local_agent", "jev", "position_stops", "strategy_bridge", "rules_workflow", "unknown")


def _proposal_provenance(preview, status):
    """Reuse the existing stored-marker classifier; its unauthenticated fallback is unknown here."""
    value = paper.provenance({**preview, "status": status})
    structured = sum(bool(preview.get(key)) for key in ("automation_source", "local_agent_source", "jev_source"))
    reason = "conflicting_source_markers" if structured > 1 else "no_explicit_source_marker" if value["source"] == "manual" else None
    return {**value, "source": "unknown" if reason else value["source"], "reason": reason,
            "evidence_kind": "unknown" if reason else "structured" if structured else "program_marker"}


def _execution_events(db, limit):
    """Derived, idempotent operator events for Alpaca Paper orders; nothing is stored, so nothing can duplicate."""
    from .execution import _partial_terminal
    placeholders = ",".join("?" * len(EXECUTION_EVENT_KINDS))
    counts = {}
    for row in db.execute(f"SELECT status,COUNT(*) AS n FROM execution_orders WHERE status IN ({placeholders}) GROUP BY status",
                          tuple(EXECUTION_EVENT_KINDS)):
        counts[EXECUTION_EVENT_KINDS[row["status"]]] = row["n"]
    events = []
    for row in db.execute(f"""SELECT o.*, s.target, s.summary_json, a.name AS account_name FROM execution_orders o
            JOIN execution_submissions s ON s.id=o.submission_id JOIN paper_accounts a ON a.id=o.account_id
            WHERE o.status IN ({placeholders})
            ORDER BY COALESCE(o.last_synced_at,o.submitted_at) DESC, o.submission_id, o.sequence LIMIT ?""",
                          (*EXECUTION_EVENT_KINDS, limit)):
        kind = EXECUTION_EVENT_KINDS[row["status"]]
        summary = json.loads(row["summary_json"])
        error = json.loads(row["error_json"]) if row["error_json"] else None
        events.append({"key": f"execution:{row['id']}:{kind}", "kind": kind, "order_id": row["id"],
                       "submission_id": row["submission_id"], "account_id": row["account_id"], "account_name": row["account_name"],
                       "proposal_id": row["proposal_id"], "target": row["target"], "symbol": row["symbol"], "side": row["side"],
                       "qty": row["qty"], "order_type": row["order_type"],
                       "limit_price": (summary.get("limit_prices") or {}).get(row["client_order_id"]),
                       "status": row["status"], "filled_qty": row["filled_qty"], "filled_avg_price": row["filled_avg_price"],
                       "partial_fill": _partial_terminal(row["status"], row["filled_qty"]),
                       "at": row["last_synced_at"] or row["submitted_at"], "broker_order_id": row["broker_order_id"],
                       "error": {"code": error.get("code"), "message": error.get("message")} if isinstance(error, dict) else None})
    return events, counts



def _attention_item(key, kind, severity, account, at, title, detail, navigation):
    return {"key": key, "kind": kind, "severity": severity,
            "account_id": account["id"] if account else None, "account_name": account["name"] if account else None,
            "at": at, "title_zh": title[0], "title_en": title[1], "detail": detail, "navigation": navigation}


def _attention(db, accounts, mandates, as_of):
    """Operator feed derived from existing rows only; each source fails on its own as one info item."""
    items = []

    def source(name, label, work):
        try:
            work()
        except SOURCE_ERRORS as error:
            reason = error.detail if isinstance(error, HTTPException) else f"{type(error).__name__}: {error}"
            items.append(_attention_item(f"source_unavailable:{name}", "source_unavailable", "info", None, None,
                                         (f"{label}來源不可用", f"{name} source unavailable"), str(reason)[:200], None))

    def mandate_items():
        source_mandates = mandates
        if source_mandates is None:
            source_mandates = []
            for row in db.execute("SELECT * FROM agent_mandates ORDER BY created_at,id"):
                item = dict(row)
                life = agent_automation.lifecycle(item, as_of)
                source_mandates.append({**item, "lifecycle": life["lifecycle"], "lifecycle_message": life["message"]})
        for item in source_mandates:
            severity = MANDATE_SEVERITY.get(item.get("lifecycle"))
            if severity:
                items.append(_attention_item(f"mandate:{item['id']}:{item['lifecycle']}", f"mandate_{item['lifecycle']}", severity,
                                             accounts.get(item["account_id"], {"id": item["account_id"], "name": item.get("account_name")}),
                                             item.get("updated_at"), MANDATE_TITLES[item["lifecycle"]],
                                             f"{item['name']}：{item.get('lifecycle_message') or item.get('reason') or ''}",
                                             {"tab": "automation", "mandate_id": item["id"]}))

    def paused_items():
        for account in accounts.values():
            if account["kill_switch"]:
                items.append(_attention_item(f"account:{account['id']}:paused", "account_paused", "warn", account, account.get("updated_at"),
                                             ("帳戶已暫停（殺手開關）", "Account paused (kill switch)"),
                                             "暫停期間只有純減倉例外可接受提案；恢復需明確操作", {"tab": "plan"}))

    def breaker_items():
        from . import circuit_breakers
        for account in accounts.values():
            status = circuit_breakers.evaluate(db, account["id"], as_of)
            if status.get("tripped"):
                items.append(_attention_item(f"breaker:{account['id']}:{as_of}", "circuit_breaker_tripped", "critical", account, as_of,
                                             ("斷路器觸發", "Circuit breaker tripped"), "、".join(status.get("tripped_codes", [])), {"tab": "risk"}))

    def sweep_items():
        for row in db.execute("SELECT id,account_id,proposal_id,updated_at,summary_json FROM execution_submissions ORDER BY updated_at DESC LIMIT ?",
                              (ATTENTION_LIMIT,)):
            sweep = json.loads(row["summary_json"]).get("kill_switch_sweep")
            if not sweep:
                continue
            counts = {}
            for entry in sweep.get("results", []):
                counts[entry.get("action")] = counts.get(entry.get("action"), 0) + 1
            items.append(_attention_item(f"sweep:{row['id']}", "kill_switch_sweep", "warn", accounts.get(row["account_id"]), sweep.get("at"),
                                         ("暫停時已清掃未完結委託", "Working orders swept on pause"),
                                         f"{sweep.get('reason') or ''}：" + (" · ".join(f"{k} {v}" for k, v in counts.items()) or "無委託"),
                                         {"tab": "trading-agent", "proposal_id": row["proposal_id"]}))

    def stop_items():
        from . import position_stops
        for account in accounts.values():
            tripped = position_stops.evaluate(db, account["id"], as_of).get("tripped", [])
            if tripped:
                items.append(_attention_item(f"stops:{account['id']}:{as_of}", "position_stop_tripped", "warn", account, as_of,
                                             ("部位停損觸發", "Position stop tripped"), "、".join(tripped), {"tab": "risk"}))

    def corporate_items():
        from . import corporate_actions
        for account in accounts.values():
            summary = corporate_actions.account_summary(db, account["id"], as_of)
            for event in summary.get("events", []):
                if not event.get("since_entry"):
                    continue
                mixed = (event.get("data_consistency") or {}).get("flag") == "possible_mixed_basis"
                items.append(_attention_item(f"corporate:{account['id']}:{event['symbol']}:{event['ex_date']}",
                                             "corporate_action_mixed_basis" if mixed else "corporate_action_since_entry",
                                             "critical" if mixed else "info", account, event.get("ex_date"),
                                             ("疑似拆併股且日線基礎可能混用", "Suspected split with mixed price basis") if mixed
                                             else ("進場後偵測到公司行動", "Corporate action after entry"),
                                             f"{event['symbol']} {event.get('kind')} {event.get('ex_date')}", {"tab": "risk"}))

    def execution_items():
        for row in db.execute("""SELECT o.id,o.account_id,o.symbol,o.side,o.qty,o.status,o.error_json,
                COALESCE(o.last_synced_at,o.submitted_at) AS at,s.proposal_id,s.as_of AS submission_as_of
                FROM execution_orders o JOIN execution_submissions s ON s.id=o.submission_id
                WHERE o.status IN ('rejected','unknown') ORDER BY at DESC LIMIT ?""", (ATTENTION_LIMIT,)):
            stale = row["status"] == "unknown" and row["submission_as_of"] < as_of
            kind = "stale_unknown_order" if stale else EXECUTION_EVENT_KINDS[row["status"]]
            error = json.loads(row["error_json"]) if row["error_json"] else None
            code = error.get("code") if isinstance(error, dict) else None
            items.append(_attention_item(f"execution:{row['id']}:{kind}", kind, "critical", accounts.get(row["account_id"]), row["at"],
                                         ("跨交易日仍未知結果的委託", "Order unknown across sessions") if stale
                                         else ("委託被拒", "Order rejected") if row["status"] == "rejected" else ("委託結果未知", "Order outcome unknown"),
                                         f"{row['symbol']} {row['side']} {row['qty']}" + (f" · {code}" if code else ""),
                                         {"tab": "trading-agent", "proposal_id": row["proposal_id"], "order_id": row["id"]}))

    for name, label, work in (("mandates", "任務授權", mandate_items), ("accounts", "帳戶", paused_items),
                              ("circuit_breakers", "斷路器", breaker_items), ("execution_sweeps", "委託清掃", sweep_items),
                              ("position_stops", "部位停損", stop_items), ("corporate_actions", "公司行動", corporate_items),
                              ("execution_orders", "委託", execution_items)):
        source(name, label, work)
    # Stable three-pass sort: key as tie-breaker, then newest first (None last), then severity.
    items.sort(key=lambda item: item["key"])
    items.sort(key=lambda item: item["at"] or "", reverse=True)
    items.sort(key=lambda item: SEVERITY_ORDER[item["severity"]])
    return items


def current_attention(db, as_of):
    """Derive attention on the supplied transaction; no independent API read snapshots."""
    accounts = {row["id"]: dict(row) for row in db.execute(
        "SELECT id,name,version,kill_switch,updated_at FROM paper_accounts ORDER BY created_at,id")}
    return _attention(db, accounts, None, as_of)


def _proposal_item(db, row, accounts, as_of, revision, provenance=None):
    preview = json.loads(row["preview_json"])
    account = accounts[row["account_id"]]
    reasons = []
    if preview.get("account_version") != account["version"]:
        reasons.append({"code": "account_changed", "message": "帳戶版本已變更，請重新產生提案"})
    if preview.get("input_revision") != revision:
        reasons.append({"code": "inputs_changed", "message": "行情輸入已變更，請重新產生提案"})
    if preview.get("as_of") != as_of:
        reasons.append({"code": "session_changed", "message": "提案不屬於最新已完成交易日"})
    if preview.get("engine_version") != paper.ENGINE_VERSION:
        reasons.append({"code": "method_changed", "message": "提案方法已更新，舊提案只供閱讀"})
    source = preview.get("automation_source")
    if source:
        try:
            agent_automation.validate_source(db, source)
        except (HTTPException, KeyError, TypeError) as exc:
            reasons.append({"code": "automation_changed", "message": str(exc.detail) if isinstance(exc, HTTPException) else "自動化來源格式無法驗證"})
    local_source = preview.get("local_agent_source")
    if local_source:
        from . import local_agent
        try:
            local_agent.validate_source(db, local_source)
        except (HTTPException, KeyError, TypeError) as exc:
            reasons.append({"code": "local_agent_changed", "message": str(exc.detail) if isinstance(exc, HTTPException) else "本機模型來源格式無法驗證"})
    jev_source = preview.get("jev_source")
    if jev_source:
        from . import jev_decision
        try:
            jev_decision.validate_source(db, jev_source)
        except (HTTPException, KeyError, TypeError) as exc:
            reasons.append({"code": "jev_changed", "message": str(exc.detail) if isinstance(exc, HTTPException) else "Jev 決策來源格式無法驗證"})
    current = not reasons
    paused = bool(account["kill_switch"])
    if paused:
        reasons.append({"code": "account_paused", "message": "帳戶已暫停模擬執行"})
    blocked = row["status"] == "blocked" or not preview.get("executable", False)
    if blocked:
        reasons.extend(preview.get("violations", []))
    return {
        "id": row["id"], "account_id": account["id"], "account_name": account["name"],
        "status": row["status"], "review_status": "stale" if not current else "paused" if paused else "blocked" if blocked else "ready",
        "current": current, "ready_for_review": current and not paused and not blocked,
        "created_at": row["created_at"], "as_of": preview.get("as_of"),
        "account_version": preview.get("account_version"), "current_account_version": account["version"],
        "engine_version": preview.get("engine_version"), "targets": preview.get("targets", []),
        "order_count": len(preview.get("orders", [])), "turnover_pct": preview.get("turnover_pct"),
        "cost_total": preview.get("cost_total"), "reasons": reasons,
        "provenance": provenance or _proposal_provenance(preview, row["status"]),
        "source": "automation" if source else "local_model" if local_source else "jev_gate" if jev_source else "manual_or_agent",
    }


@router.get("/api/portfolio-agent/inbox")
@store.snapshot_read
def inbox(
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
    queue_limit: Annotated[int, Query(ge=1, le=100)] = 20,
    queue_offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
    execution_limit: Annotated[int, Query(ge=1, le=100)] = 20,
    source: ProposalSource = "all",
):
    as_of = sessions.latest_completed_session()
    with store.connect() as db:
        revision = store.input_revision(db)
        accounts = {row["id"]: dict(row) for row in db.execute("SELECT id,name,version,kill_switch,updated_at FROM paper_accounts ORDER BY created_at,id")}
        counts = {row["status"]: row["n"] for row in db.execute("SELECT status,COUNT(*) AS n FROM paper_proposals GROUP BY status")}
        open_count = counts.get("proposed", 0) + counts.get("blocked", 0)
        source_counts = {key: 0 for key in PROPOSAL_SOURCES}
        matching_count, proposals = 0, []
        for row in db.execute("""SELECT * FROM paper_proposals WHERE status IN ('proposed','blocked')
                ORDER BY created_at DESC,id DESC"""):
            provenance = _proposal_provenance(json.loads(row["preview_json"]), row["status"])
            source_counts[provenance["source"]] += 1
            if source != "all" and provenance["source"] != source:
                continue
            if offset <= matching_count < offset + limit:
                proposals.append(_proposal_item(db, row, accounts, as_of, revision, provenance))
            matching_count += 1
        account_counts = {row["account_id"]: row["n"] for row in db.execute("""SELECT account_id,COUNT(*) AS n FROM paper_proposals
            WHERE status IN ('proposed','blocked') GROUP BY account_id""")}
        automation = agent_automation.state()
        mandates = [{key: item[key] for key in (
            "id", "name", "account_id", "account_name", "enabled", "mode", "version", "status", "reason", "next_due_at", "last_checked_at", "candidate_source"
        )} | {"last_attempt_status": item["last_attempt"]["status"] if item["last_attempt"] else None,
              "last_attempt_at": item["last_attempt"]["finished_at"] if item["last_attempt"] else None,
              "paper_proposal_id": item["last_attempt"]["paper_proposal_id"] if item["last_attempt"] else None}
            for item in automation["mandates"]]
        last_events = [dict(row) for row in db.execute("""SELECT p.id AS proposal_id,p.account_id,a.name AS account_name,
            p.status,p.created_at,p.accepted_at FROM paper_proposals p JOIN paper_accounts a ON a.id=p.account_id
            WHERE p.status IN ('simulated','rejected')
            ORDER BY COALESCE(p.accepted_at,p.created_at) DESC,p.id DESC LIMIT 10""")]
        queue_counts = {row["status"]: row["n"] for row in db.execute(
            "SELECT status,COUNT(*) AS n FROM paper_next_open_orders GROUP BY status")}
        queue_total = sum(queue_counts.values())
        queue_orders = []
        instant = paper_next_open._instant()
        for row in db.execute("""SELECT q.*,
                (SELECT COUNT(*) FROM paper_next_open_attempts t WHERE t.order_id=q.id) AS attempt_count
                FROM paper_next_open_orders q ORDER BY q.updated_at DESC,q.id DESC LIMIT ? OFFSET ?""",
                (queue_limit, queue_offset)):
            view = paper_next_open._view(db, dict(row), instant)
            queue_orders.append({key: view[key] for key in (
                "id", "account_id", "source_proposal_id", "execution_proposal_id", "status", "version",
                "execution_session", "created_at", "updated_at", "reason_code", "reason", "can_process", "can_cancel"
            )} | {"account_name": accounts[row["account_id"]]["name"], "attempt_count": row["attempt_count"]})
        execution_events, execution_counts = _execution_events(db, execution_limit)
        attention = inbox_acknowledgements.attach_receipts(db, _attention(db, accounts, automation["mandates"], as_of))
    return {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": revision,
            "counts": {"accounts": len(accounts), "paused_accounts": sum(bool(a["kill_switch"]) for a in accounts.values()),
                       "open_proposals": open_count, "simulated_proposals": counts.get("simulated", 0),
                       "queue_orders": queue_total,
                       "active_queue_orders": sum(queue_counts.get(status, 0) for status in paper_next_open.ACTIVE),
                       "enabled_mandates": sum(item["enabled"] for item in mandates), "mandates": len(mandates),
                       "execution_events": sum(execution_counts.values()),
                       "execution_attention": sum(execution_counts.get(kind, 0) for kind in ("execution_rejected", "execution_unknown_outcome", "execution_partial")),
                       "attention_total": len(attention),
                       "attention_critical": sum(item["severity"] == "critical" for item in attention),
                       "attention_warn": sum(item["severity"] == "warn" for item in attention),
                       "attention_unreviewed": sum(not item["acknowledgement"]["acknowledged"] for item in attention),
                       "attention_unreviewed_critical": sum(item["severity"] == "critical" and not item["acknowledgement"]["acknowledged"] for item in attention),
                       "attention_unreviewed_warn": sum(item["severity"] == "warn" and not item["acknowledgement"]["acknowledged"] for item in attention)},
            "accounts": [{**account, "kill_switch": bool(account["kill_switch"]), "open_proposals": account_counts.get(account["id"], 0)} for account in accounts.values()],
            "proposals": proposals,
            "proposal_sources": {"selected": source, "total": open_count, "counts": source_counts,
                                 "provenance_engine_version": paper.PROVENANCE_VERSION},
            "pagination": {"limit": limit, "offset": offset, "total": matching_count, "returned": len(proposals), "has_more": offset + len(proposals) < matching_count},
            "queue_orders": queue_orders, "queue_status_counts": queue_counts,
            "queue_pagination": {"limit": queue_limit, "offset": queue_offset, "total": queue_total,
                                 "returned": len(queue_orders), "has_more": queue_offset + len(queue_orders) < queue_total},
            "mandates": mandates, "recent_outcomes": last_events,
            "execution_events": execution_events, "execution_event_counts": execution_counts,
            "attention": attention,
            "execution_pagination": {"limit": execution_limit, "returned": len(execution_events), "total": sum(execution_counts.values())},
            "method": METHOD,
            "warnings": ["待審清單包含舊版或受阻提案；開啟後可檢查原因並逐筆拒絕，不會自動清除。", "排程只在本機伺服器運行時檢查，未啟用的任務不會自行運行。"]}
