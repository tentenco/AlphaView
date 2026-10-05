"""Trading Agent daily report on synthetic paper activity; isolated database, no providers."""
import csv
import io
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import agent_report, paper_analytics, paper_portfolio as paper, sessions, store

SESSION = "2024-01-05"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "report.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: SESSION)
    store.init_db()
    with store.connect() as db:
        for symbol, price in (("SYNTH", 100), ("OTHER", 50)):
            _bar(db, symbol, price)
    app = FastAPI()
    for router in (paper.router, paper_analytics.router, agent_report.router):
        app.include_router(router)
    with TestClient(app, raise_server_exceptions=False) as value:
        yield value


def _bar(db, symbol, price, day=SESSION):
    db.execute("""INSERT INTO datasets(symbol,currency,status,last_date) VALUES (?,'USD','ok',?)
        ON CONFLICT(symbol) DO UPDATE SET last_date=excluded.last_date""", (symbol, day))
    db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,?)", (symbol, day, price, price * 1.01, price * .99, price, price, 1000))


def _account(client):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic report account", "initial_cash": 10_000,
                                                        "idempotency_key": "report-account-01",
                                                        "execution_policy": {"fee_bps": 10, "slippage_bps": 0, "share_precision": 0, "min_trade_notional": 1}})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def _trade(client, account_id, targets, key):
    account = client.get(f"/api/paper/accounts/{account_id}").json()["account"]
    proposal = client.post(f"/api/paper/accounts/{account_id}/proposals",
                           json={"expected_version": account["version"], "targets": targets, "idempotency_key": f"proposal-{key}"})
    assert proposal.status_code == 200, proposal.text
    accepted = client.post(f"/api/paper/accounts/{account_id}/proposals/{proposal.json()['id']}/accept",
                           json={"expected_version": account["version"], "idempotency_key": f"accept-{key}"})
    assert accepted.status_code == 200, accepted.text
    return accepted.json()


def _capture(client, account_id):
    account = client.get(f"/api/paper/accounts/{account_id}").json()["account"]
    response = client.post(f"/api/paper/accounts/{account_id}/nav/capture", json={"expected_version": account["version"]})
    assert response.status_code == 200, response.text
    return response.json()["snapshot"]


def _activity(client):
    account = _account(client)
    _trade(client, account["id"], [{"symbol": "SYNTH", "weight_pct": 30}, {"symbol": "OTHER", "weight_pct": 20}], "buy")
    with store.connect() as db:
        _bar(db, "SYNTH", 120)
        _bar(db, "OTHER", 40)
    _capture(client, account["id"])
    _trade(client, account["id"], [{"symbol": "SYNTH", "weight_pct": 0}, {"symbol": "OTHER", "weight_pct": 0}], "sell")
    _capture(client, account["id"])
    return account


def test_report_aggregates_session_fills_window_stats_and_stays_read_only(client):
    account = _activity(client)
    with store.connect() as db:
        db.execute("""INSERT INTO paper_nav_snapshots(account_id,as_of,account_version,input_revision,engine_version,observed_at,snapshot_json)
            VALUES (?,?,?,?,?,?,?)""", (account["id"], "2024-01-04", 1, "synthetic", paper_analytics.ENGINE_VERSION, "synthetic",
                                        json.dumps({"account_id": account["id"], "account_version": 1, "as_of": "2024-01-04",
                                                    "equity": 10_000, "valuation_complete": True, "observed_at": "synthetic",
                                                    "input_revision": "synthetic", "coverage": {"required": 0, "priced": 0, "missing": []}})))
        db.execute("""INSERT INTO jev_decision_runs(id,idempotency_key,request_hash,source_run_id,engine_version,question_set_version,status,
            created_at,as_of,input_revision,model_requested,model_answered,request_json,source_json,state_json,questions_json,request_digest,
            answers_json,usage_json,latency_ms,result_json,error_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   ("synthetic-jev", "synthetic-key", "hash", "run", "alphaview-jev-decision-v1", "alphaview-jev-questions-v1", "completed",
                    "synthetic", SESSION, "synthetic", "jev-1.13.0", "jev-1.13.0", "{}", "{}", "{}", "{}", "digest", "{}",
                    json.dumps({"input_tokens": 1000, "output_tokens": 10}), 200, json.dumps({"counts": {"pass": 2, "fail": 1, "unavailable": 0}}), None))
    revision = store.input_revision()
    response = client.get(f"/api/trading-agent/report?account_id={account['id']}&window_sessions=5")
    assert response.status_code == 200, response.text
    data = response.json()
    assert store.input_revision() == revision and json.dumps(data, allow_nan=False)
    assert data["engine_version"] == agent_report.ENGINE_VERSION and data["session"] == SESSION and data["is_session"]
    fills = data["fills"]
    assert fills["totals"]["count"] == 4 and fills["totals"]["buy_count"] == 2 and fills["totals"]["sell_count"] == 2
    sells = [fill for fill in fills["items"] if fill["side"] == "sell"]
    synth = next(fill for fill in sells if fill["symbol"] == "SYNTH")
    other = next(fill for fill in sells if fill["symbol"] == "OTHER")
    assert synth["realized_pnl"] > 0 and other["realized_pnl"] < 0 and synth["price"] == 120 and other["price"] == 40
    assert fills["totals"]["realized_pnl"] == pytest.approx(synth["realized_pnl"] + other["realized_pnl"], abs=1e-6)
    assert fills["totals"]["fees"] > 0 and fills["totals"]["cost_total"] == pytest.approx(fills["totals"]["fees"] + fills["totals"]["slippage"], abs=1e-6)
    window = data["window"]
    assert window["sell_count"] == 2 and window["win_rate_pct"] == 50 and window["wins"] == 1 and window["losses"] == 1
    assert window["largest_win"] == synth["realized_pnl"] and window["largest_loss"] == other["realized_pnl"]
    assert window["window_sessions"] == 5 and window["end"] == SESSION and window["fill_count"] == 4
    assert data["account"]["holdings_count"] == 0 and data["account"]["valuation_complete"] and data["account"]["equity"] > 0
    nav = data["nav"]
    assert nav["latest"]["as_of"] == SESSION and nav["previous"]["as_of"] == "2024-01-04"
    assert nav["session_change_pct"] == pytest.approx((nav["latest"]["equity"] / 10_000 - 1) * 100, abs=1e-4)
    assert nav["captured_sessions"] == 2
    jev = data["jev"]
    assert jev["available"] and jev["runs"] == 1 and jev["symbol_counts"] == {"pass": 2, "fail": 1, "unavailable": 0}
    assert jev["average_latency_ms"] == 200 and jev["estimated_cost_usd"] == pytest.approx(1000 * 0.042 / 1e6)
    assert data["automation"]["attempts"] == [] and data["automation"]["pending_proposals"] == 0
    assert data["automation"]["next_open_queue"] == {} and data["automation"]["enabled_mandates"] == 0
    assert data["data_freshness"]["stale_symbols"] == [] and "available" in data["circuit_breaker"]


def test_missing_snapshots_and_sells_are_null_with_reasons(client):
    account = _account(client)
    data = client.get(f"/api/trading-agent/report?account_id={account['id']}").json()
    assert data["nav"]["latest"] is None and data["nav"]["session_change_pct"] is None and data["nav"]["session_change_reason"]
    assert data["nav"]["window_return_pct"] is None and data["nav"]["window_reason"]
    assert data["window"]["win_rate_pct"] is None and data["window"]["largest_loss"] is None and data["window"]["reason"]
    assert data["fills"]["totals"] == {"count": 0, "buy_count": 0, "sell_count": 0, "buy_notional": 0, "sell_notional": 0,
                                       "fees": 0, "slippage": 0, "cost_total": 0, "realized_pnl": 0}
    assert data["jev"]["runs"] == 0 and data["jev"]["estimated_cost_usd"] is None
    assert any("淨值變動不可用" in warning for warning in data["warnings"])
    json.dumps(data, allow_nan=False)


def test_session_bounds_and_stale_holdings(client):
    account = _account(client)
    assert client.get(f"/api/trading-agent/report?account_id={account['id']}&session=2024-01-08").status_code == 422
    assert client.get(f"/api/trading-agent/report?account_id={account['id']}&session=2024-13-01").status_code == 422
    assert client.get(f"/api/trading-agent/report?account_id={account['id']}&window_sessions=0").status_code == 422
    assert client.get("/api/trading-agent/report?account_id=unknown").status_code == 404
    _trade(client, account["id"], [{"symbol": "SYNTH", "weight_pct": 30}], "buy")
    earlier = client.get(f"/api/trading-agent/report?account_id={account['id']}&session=2024-01-04").json()
    assert earlier["fills"]["totals"]["count"] == 0 and earlier["session"] == "2024-01-04"
    weekend = client.get(f"/api/trading-agent/report?account_id={account['id']}&session=2023-12-30").json()
    assert weekend["is_session"] is False and any("不是 XNYS 交易日" in warning for warning in weekend["warnings"])
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTH'")
        _bar(db, "SYNTH", 100, day="2024-01-03")
    stale = client.get(f"/api/trading-agent/report?account_id={account['id']}").json()
    assert stale["data_freshness"]["stale_symbols"] == ["SYNTH"] and stale["account"]["equity"] is None
    assert stale["account"]["coverage"]["missing"] == ["SYNTH"]


def test_html_export_is_self_contained_and_csv_guards_formulas(client):
    account = _activity(client)
    page = client.get(f"/api/trading-agent/report.html?account_id={account['id']}")
    assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
    assert page.headers["cache-control"] == "no-store" and "attachment" in page.headers["content-disposition"]
    body = page.text
    assert body.startswith("<!doctype html>") and "<script" not in body.lower() and "http" not in body.lower()
    assert "SYNTH" in body and "紙上模擬" in body and "prefers-color-scheme" in body
    with store.connect() as db:
        db.execute("UPDATE paper_ledger SET symbol='=EVIL' WHERE symbol='OTHER' AND shares_delta LIKE '-%'")
    sheet = client.get(f"/api/trading-agent/report.csv?account_id={account['id']}")
    assert sheet.status_code == 200 and sheet.text.startswith("﻿")
    rows = list(csv.reader(io.StringIO(sheet.text.lstrip("﻿"))))
    assert rows[0][:4] == ["session", "account_id", "symbol", "side"] and len(rows) == 5
    assert any(row[2] == "'=EVIL" for row in rows[1:])
    assert all(row[-1] == "paper simulated fill, not a real trade" for row in rows[1:])


def test_operations_block_reports_each_gate_independently(client):
    account = _account(client)
    data = client.get(f"/api/trading-agent/report?account_id={account['id']}").json()
    ops = data["operations"]
    assert ops["readiness"]["available"] and ops["readiness"]["overall"] in ("not_ready", "blocked")
    assert "mandate_active" in ops["readiness"]["failing"]
    assert ops["mandates"] == {"available": True, "count": 0, "lifecycle_counts": {}, "attention": []}
    assert ops["position_stops"]["available"] and ops["position_stops"]["enabled"] is False and ops["position_stops"]["tripped"] == []
    assert ops["regime_overlay"]["available"] and ops["regime_overlay"]["enabled"] is False
    assert ops["regime_overlay"]["cap_status"] != "ok" and ops["regime_overlay"]["cap_pct"] is None
    page = client.get(f"/api/trading-agent/report.html?account_id={account['id']}").text
    assert "營運狀態 (Operations)" in page and "就緒閘" in page
    json.dumps(data, allow_nan=False)


def test_decision_quality_and_provenance_counts_are_reported(client):
    account = _account(client)
    _trade(client, account["id"], [{"symbol": "SYNTH", "weight_pct": 30}], "provenance")
    data = client.get(f"/api/trading-agent/report?account_id={account['id']}").json()
    quality = data["decision_quality"]
    assert quality["available"] and set(quality["families"]) == {"agent_targets", "jev_gate"}
    assert quality["horizon_sessions"] == 10 and quality["families"]["agent_targets"]["n_settled"] == 0
    assert quality["families"]["agent_targets"]["hit_rate"] is None and quality["families"]["agent_targets"]["reason"] == "no_decisions"
    assert quality["score_correlation"]["status"] == "unavailable" and quality["score_correlation"]["reason"] == "question_absent"
    counts = data["provenance_counts"]
    assert counts == {"engine_version": "alphaview-proposal-provenance-v1", "session": SESSION, "total": 1,
                      "by_source": {"manual": 1}, "by_tag": {}}
    page = client.get(f"/api/trading-agent/report.html?account_id={account['id']}").text
    assert "決策品質 (Decision quality)" in page and "manual 1" in page
    json.dumps(data, allow_nan=False)
