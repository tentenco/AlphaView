"""Synthetic paper-account fixtures; never touch a user's holdings or workspace."""
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import paper_portfolio as paper, sessions, store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "paper-test.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-05")
    store.init_db()
    with store.connect() as db:
        paper.init_schema(db)
        # A separate synthetic real-position row proves isolation, never imported.
        db.execute("INSERT INTO positions(symbol,name,shares,cost,source,updated_at) VALUES ('PRIVATE-SYNTH','Synthetic existing',17,42,'test','test')")
        for symbol, price in (("SYNTH", 100), ("OTHER", 50), ("THIRD", 25)):
            _bar(db, symbol, price)
    app = FastAPI()
    app.include_router(paper.router)
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def _bar(db, symbol, price, day="2024-01-05", currency="USD"):
    db.execute("""INSERT INTO datasets(symbol,currency,status,last_date) VALUES (?,?,'ok',?)
        ON CONFLICT(symbol) DO UPDATE SET currency=excluded.currency,last_date=excluded.last_date""", (symbol, currency, day))
    db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,?)",
               (symbol, day, price, price * 1.01, price * .99, price, price, 1000))


def _create(client, **changes):
    body = {"name": "Synthetic account", "initial_cash": 10_000, "idempotency_key": "create-account-01", **changes}
    response = client.post("/api/paper/accounts", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _propose(client, account, targets=None, key="proposal-01", **changes):
    body = {"expected_version": account["version"],
            "targets": targets if targets is not None else [{"symbol": "SYNTH", "weight_pct": 30}],
            "idempotency_key": key, **changes}
    response = client.post(f"/api/paper/accounts/{account['id']}/proposals", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _accept(client, account, proposal, key="accept-proposal-01", version=None):
    return client.post(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/accept",
                       json={"expected_version": version if version is not None else account["version"], "idempotency_key": key})


def _db_counts():
    with store.connect() as db:
        return {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("paper_accounts", "paper_holdings", "paper_proposals", "paper_ledger", "paper_idempotency")}


def test_explicit_cash_creation_is_separate_idempotent_and_does_not_change_market_inputs(client):
    real = store.positions()
    revision = store.input_revision()
    snapshot = _create(client)
    assert snapshot["account"]["initial_cash"] == snapshot["equity"] == 10_000
    assert snapshot["account"]["version"] == 1
    assert snapshot["holdings"] == []
    assert snapshot["coverage"] == {"required": 0, "priced": 0, "missing": []}
    assert snapshot["cash_weight_pct"] == 100
    assert snapshot["total_return_pct"] == 0
    assert len(snapshot["ledger"]) == 1 and snapshot["ledger"][0]["kind"] == "initial_cash"
    assert _create(client) == snapshot
    assert _db_counts()["paper_accounts"] == 1
    assert store.positions() == real and store.input_revision() == revision
    conflict = client.post("/api/paper/accounts", json={"name": "Different", "initial_cash": 10_000, "idempotency_key": "create-account-01"})
    assert conflict.status_code == 409
    assert len(client.get("/api/paper/accounts").json()["accounts"]) == 1


def test_preview_is_readonly_and_two_step_accept_conserves_cash_and_inventory(client):
    account = _create(client)["account"]
    before, revision = _db_counts(), store.input_revision()
    request = {"expected_version": 1, "targets": [{"symbol": "synth", "weight_pct": 30}, {"symbol": "OTHER", "weight_pct": 20}]}
    response = client.post(f"/api/paper/accounts/{account['id']}/preview", json=request)
    assert response.status_code == 200
    preview = response.json()
    assert preview["executable"] and preview["cash_after"] == 5000
    assert preview["turnover_pct"] == 50
    assert preview["coverage"] == {"required": 2, "priced": 2, "missing": []}
    assert _db_counts() == before
    proposal = _propose(client, account, request["targets"])
    assert proposal["status"] == "proposed"
    assert _db_counts()["paper_ledger"] == 1
    accepted = _accept(client, account, proposal)
    assert accepted.status_code == 200, accepted.text
    body = accepted.json()
    assert body["proposal"]["status"] == "simulated"
    assert body["account"]["account"]["version"] == 2
    assert body["account"]["account"]["cash"] == 5000
    assert {row["symbol"]: row["shares"] for row in body["account"]["holdings"]} == {"OTHER": 40, "SYNTH": 30}
    assert body["account"]["equity"] == 10_000
    assert body["account"]["unrealized_pnl"] == 0
    assert len(body["account"]["ledger"]) == 3
    assert store.input_revision() == revision
    json.dumps(body, allow_nan=False)
    assert _accept(client, account, proposal).json() == body
    assert _db_counts()["paper_ledger"] == 3
    assert _accept(client, account, proposal, key="second-accept-key", version=2).status_code == 409


def test_new_targets_sell_omitted_holdings_and_record_realized_pnl(client):
    account = _create(client)["account"]
    proposal = _propose(client, account)
    first = _accept(client, account, proposal).json()["account"]
    with store.connect() as db:
        _bar(db, "SYNTH", 120)
    account = first["account"]
    proposal = _propose(client, account, [{"symbol": "OTHER", "weight_pct": 20}], key="rotate-proposal")
    assert [(order["symbol"], order["side"]) for order in proposal["orders"]] == [("SYNTH", "sell"), ("OTHER", "buy")]
    accepted = _accept(client, account, proposal, key="rotate-accept").json()["account"]
    assert len(accepted["holdings"]) == 1 and accepted["holdings"][0]["symbol"] == "OTHER"
    assert accepted["realized_pnl"] == 600
    assert accepted["account"]["cash"] == 8480
    assert accepted["equity"] == 10600
    assert accepted["total_return_pct"] == 6
    ledger = accepted["ledger"]
    assert next(row for row in ledger if row["proposal_id"] == proposal["id"] and row["symbol"] == "SYNTH")["realized_pnl"] == 600


def test_partial_sale_uses_moving_average_cost(client):
    account = _create(client)["account"]
    account = _accept(client, account, _propose(client, account)).json()["account"]["account"]
    with store.connect() as db:
        _bar(db, "SYNTH", 200)
    # Equity 13k; 30% means 19.5 shares, removing 10.5 of original 30.
    proposal = _propose(client, account, key="partial-sale")
    assert proposal["orders"][0]["shares"] == 10.5
    result = _accept(client, account, proposal, key="partial-accept").json()["account"]
    assert result["holdings"][0]["cost_basis"] == 1950
    assert result["holdings"][0]["average_cost"] == 100
    assert result["realized_pnl"] == 1050
    assert result["unrealized_pnl"] == 1950
    assert result["total_return_pct"] == 30


@pytest.mark.parametrize("quote_kind", ["missing", "stale", "invalid", "non_usd", "unknown_currency", "future_only"])
def test_missing_or_ineligible_price_blocks_whole_plan_without_reallocating(client, quote_kind):
    account = _create(client)["account"]
    with store.connect() as db:
        if quote_kind in ("missing", "stale", "future_only"):
            db.execute("DELETE FROM bars WHERE symbol='OTHER'")
            if quote_kind == "stale":
                _bar(db, "OTHER", 50, day="2024-01-04")
            if quote_kind == "future_only":
                _bar(db, "OTHER", 50, day="2024-01-08")
        elif quote_kind == "invalid":
            db.execute("UPDATE bars SET high=1 WHERE symbol='OTHER'")
        elif quote_kind == "non_usd":
            db.execute("UPDATE datasets SET currency='EUR' WHERE symbol='OTHER'")
        else:
            db.execute("UPDATE datasets SET currency=NULL WHERE symbol='OTHER'")
    proposal = _propose(client, account, [{"symbol": "SYNTH", "weight_pct": 30}, {"symbol": "OTHER", "weight_pct": 20}])
    assert proposal["status"] == "blocked"
    assert proposal["targets"][0]["weight_pct"] == 30
    assert not proposal["executable"] and not proposal["valuation_complete"]
    assert proposal["coverage"] == {"required": 2, "priced": 1, "missing": ["OTHER"]}
    assert proposal["equity_before"] is None and proposal["cash_after"] is None
    assert proposal["orders"] == []
    assert _accept(client, account, proposal).status_code == 409
    assert _db_counts()["paper_ledger"] == 1
    json.dumps(proposal, allow_nan=False)


def test_missing_existing_holding_blocks_cash_target_and_complete_account_valuation(client):
    account = _create(client)["account"]
    account = _accept(client, account, _propose(client, account)).json()["account"]["account"]
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTH'")
    snapshot = client.get(f"/api/paper/accounts/{account['id']}").json()
    assert snapshot["equity"] is None
    assert snapshot["holdings_value"] is None
    assert snapshot["unrealized_pnl"] is None
    assert snapshot["total_return_pct"] is None
    assert snapshot["holdings"][0]["weight_pct"] is None
    assert snapshot["account"]["cash"] == 7000
    proposal = _propose(client, account, [], key="cash-only-plan")
    assert proposal["status"] == "blocked"
    assert proposal["coverage"]["missing"] == ["SYNTH"]


@pytest.mark.parametrize("limits,targets,code", [
    ({"max_position_weight_pct": 25}, [{"symbol": "SYNTH", "weight_pct": 30}], "max_position_weight"),
    ({"max_turnover_pct": 20}, [{"symbol": "SYNTH", "weight_pct": 30}], "max_turnover"),
    ({"min_cash_weight_pct": 80}, [{"symbol": "SYNTH", "weight_pct": 30}], "min_cash_weight"),
])
def test_mandate_violations_are_visible_and_non_executable(client, limits, targets, code):
    account = _create(client, limits=limits)["account"]
    proposal = _propose(client, account, targets)
    assert proposal["status"] == "blocked"
    assert code in {violation["code"] for violation in proposal["violations"]}
    assert proposal["valuation_complete"]
    assert _accept(client, account, proposal).status_code == 409


def test_kill_switch_invalidates_existing_proposals_and_preview_remains_visible(client):
    account = _create(client)["account"]
    proposal = _propose(client, account)
    disabled = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": 1, "kill_switch": True})
    assert disabled.status_code == 200
    assert disabled.json()["account"]["version"] == 2
    assert _accept(client, account, proposal, version=2).status_code == 409
    blocked = _propose(client, disabled.json()["account"], key="paused-plan")
    assert "kill_switch" in {item["code"] for item in blocked["violations"]}
    enabled = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": 2, "kill_switch": False}).json()
    assert _accept(client, account, proposal, key="enabled-again", version=3).status_code == 409
    fresh = _propose(client, enabled["account"], key="fresh-plan")
    assert _accept(client, enabled["account"], fresh, key="fresh-accept").status_code == 200


@pytest.mark.parametrize("change", ["input_revision", "session", "account_version", "method_version"])
def test_accept_revalidates_all_provenance(client, monkeypatch, change):
    account = _create(client)["account"]
    proposal = _propose(client, account)
    if change == "input_revision":
        with store.connect() as db:
            _bar(db, "SYNTH", 101)
    elif change == "session":
        monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-08")
    elif change == "account_version":
        client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": 1, "limits": {"max_position_weight_pct": 100}})
    else:
        monkeypatch.setattr(paper, "ENGINE_VERSION", "synthetic-new-version")
    assert _accept(client, account, proposal).status_code == 409
    assert _db_counts()["paper_ledger"] == 1
    assert _db_counts()["paper_holdings"] == 0


def test_accept_rolls_back_all_fills_if_any_write_fails(client):
    account = _create(client)["account"]
    proposal = _propose(client, account, [{"symbol": "OTHER", "weight_pct": 20}, {"symbol": "SYNTH", "weight_pct": 30}])
    with store.connect() as db:
        db.execute("CREATE TRIGGER synthetic_failure BEFORE INSERT ON paper_holdings WHEN NEW.symbol='SYNTH' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    before = _db_counts()
    response = _accept(client, account, proposal)
    assert response.status_code == 500
    assert _db_counts() == before
    snapshot = client.get(f"/api/paper/accounts/{account['id']}").json()
    assert snapshot["account"]["cash"] == 10_000
    assert snapshot["account"]["version"] == 1
    assert snapshot["proposals"][0]["status"] == "proposed"
    with store.connect() as db:
        db.execute("DROP TRIGGER synthetic_failure")
    assert _accept(client, account, proposal).status_code == 200


def test_concurrent_accepts_only_fill_once(client):
    account = _create(client)["account"]
    proposal = _propose(client, account)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: _accept(client, account, proposal), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    assert _db_counts()["paper_ledger"] == 2
    assert _db_counts()["paper_holdings"] == 1


def test_different_proposals_for_one_version_cannot_both_fill(client):
    account = _create(client)["account"]
    first = _propose(client, account)
    second = _propose(client, account, [{"symbol": "OTHER", "weight_pct": 30}], key="second-plan")
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda plan: _accept(client, account, plan, key=f"accept-{plan['id']}"), [first, second]))
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert _db_counts()["paper_ledger"] == 2


def test_agent_source_guards_are_checked_inside_paper_transaction(client):
    account = _create(client)["account"]
    revision = store.input_revision()
    request = {"expected_version": 1, "targets": [{"symbol": "SYNTH", "weight_pct": 30}],
               "expected_input_revision": revision, "expected_as_of": "2024-01-05", "idempotency_key": "agent-run-plan"}
    response = client.post(f"/api/paper/accounts/{account['id']}/proposals", json=request)
    assert response.status_code == 200
    with store.connect() as db:
        _bar(db, "SYNTH", 101)
    request["idempotency_key"] = "agent-run-stale"
    assert client.post(f"/api/paper/accounts/{account['id']}/proposals", json=request).status_code == 409
    request["expected_input_revision"] = store.input_revision()
    request["expected_as_of"] = "2024-01-04"
    assert client.post(f"/api/paper/accounts/{account['id']}/proposals", json=request).status_code == 409


def test_reads_share_one_snapshot_and_never_initialize_schema(client, monkeypatch):
    account = _create(client)["account"]
    before = store.input_revision()
    counts = _db_counts()
    def forbidden(*_):
        pytest.fail("read initialized schema")
    monkeypatch.setattr(paper, "init_schema", forbidden)
    for path in ("/api/paper/accounts", f"/api/paper/accounts/{account['id']}", f"/api/paper/accounts/{account['id']}/ledger"):
        assert client.get(path).status_code == 200
    assert store.input_revision() == before and _db_counts() == counts
    original = paper._quote
    changed = []
    def concurrent_quote(db, symbol, as_of):
        result = original(db, symbol, as_of)
        if not changed:
            changed.append(True)
            with sqlite3.connect(store.db_path()) as writer:
                writer.execute("UPDATE bars SET open=200,high=201,low=199,close=200,adj_close=200 WHERE symbol='OTHER'")
        return result
    monkeypatch.setattr(paper, "_quote", concurrent_quote)
    result = paper.preview(account["id"], paper.PreviewInput(expected_version=1, targets=[{"symbol": "SYNTH", "weight_pct": 30}, {"symbol": "OTHER", "weight_pct": 20}]))
    assert result["input_revision"] == before
    assert next(order for order in result["orders"] if order["symbol"] == "OTHER")["reference_price"] == 50
    assert store.input_revision() != before


@pytest.mark.parametrize("changes", [
    {"initial_cash": 0}, {"initial_cash": -1}, {"initial_cash": 1_000_000_001},
    {"initial_cash": "NaN"}, {"initial_cash": "Infinity"}, {"initial_cash": True},
    {"initial_cash": .000000001}, {"name": "   "}, {"broker": "forbidden"},
    {"limits": {"max_position_weight_pct": 101}}, {"limits": {"min_cash_weight_pct": -1}},
    {"limits": {"max_turnover_pct": 201}}, {"limits": {"unknown": 2}},
    {"idempotency_key": "tiny"},
])
def test_account_request_is_bounded_strict_and_finite(client, changes):
    body = {"name": "Synthetic", "initial_cash": 10000, "idempotency_key": "bad-account-01", **changes}
    assert client.post("/api/paper/accounts", json=body).status_code == 422
    assert _db_counts()["paper_accounts"] == 0


@pytest.mark.parametrize("changes", [
    {"expected_version": 0}, {"expected_version": True}, {"unexpected": "forbidden"},
    {"targets": [{"symbol": "SYNTH", "weight_pct": "NaN"}]},
    {"targets": [{"symbol": "SYNTH", "weight_pct": True}]},
    {"targets": [{"symbol": "SYNTH", "weight_pct": 101}]},
    {"targets": [{"symbol": "SYNTH", "weight_pct": 60}, {"symbol": "OTHER", "weight_pct": 50}]},
    {"targets": [{"symbol": "SYNTH", "weight_pct": 20}, {"symbol": " synth ", "weight_pct": 30}]},
    {"targets": [{"symbol": "<script>", "weight_pct": 20}]},
    {"targets": [{"symbol": f"S{i}", "weight_pct": 0} for i in range(51)]},
])
def test_proposal_request_is_bounded_strict_and_finite(client, changes):
    account = _create(client)["account"]
    body = {"expected_version": 1, "targets": [{"symbol": "SYNTH", "weight_pct": 30}], "idempotency_key": "bad-proposal-01", **changes}
    assert client.post(f"/api/paper/accounts/{account['id']}/proposals", json=body).status_code == 422
    assert _db_counts()["paper_proposals"] == 0


def test_reject_is_idempotent_and_prevents_accept(client):
    account = _create(client)["account"]
    proposal = _propose(client, account)
    path = f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/reject"
    rejected = client.post(path, json={"expected_version": 1})
    assert rejected.status_code == 200 and rejected.json()["status"] == "rejected"
    assert client.post(path, json={"expected_version": 1}).json() == rejected.json()
    assert _accept(client, account, proposal).status_code == 409


def test_paper_accounts_cannot_accept_other_account_proposals(client):
    one = _create(client)["account"]
    two = _create(client, name="Synthetic two", idempotency_key="second-account")["account"]
    proposal = _propose(client, one)
    assert _accept(client, two, proposal).status_code == 404
    assert client.get(f"/api/paper/accounts/{two['id']}/proposals/{proposal['id']}").status_code == 404


def test_decimal_settlement_preserves_cash_with_large_cash_and_fractional_prices(client):
    account = _create(client, initial_cash=999_999_999.99999)["account"]
    with store.connect() as db:
        _bar(db, "SYNTH", 123.45678901)
    proposal = _propose(client, account)
    result = _accept(client, account, proposal)
    assert result.status_code == 200, result.text
    with store.connect() as db:
        row = db.execute("SELECT initial_cash,cash FROM paper_accounts WHERE id=?", (account["id"],)).fetchone()
        ledger = db.execute("SELECT cash_delta FROM paper_ledger WHERE account_id=? ORDER BY id", (account["id"],)).fetchall()
        assert sum((Decimal(item["cash_delta"]) for item in ledger), Decimal(0)) == Decimal(row["cash"])
        assert Decimal(row["cash"]) == Decimal(proposal["cash_after_exact"])
    json.dumps(result.json(), allow_nan=False)


def test_ledger_pagination_is_bounded_and_readonly(client):
    account = _create(client)["account"]
    _accept(client, account, _propose(client, account))
    revision = store.input_revision()
    path = f"/api/paper/accounts/{account['id']}/ledger"
    page = client.get(path, params={"limit": 1, "offset": 0}).json()
    assert page["total"] == 2 and len(page["items"]) == 1
    assert page["items"][0]["kind"] == "simulated_fill"
    assert client.get(path, params={"limit": 1, "offset": 1}).json()["items"][0]["kind"] == "initial_cash"
    assert client.get(path, params={"limit": 101}).status_code == 422
    assert client.get(path, params={"offset": -1}).status_code == 422
    assert store.input_revision() == revision


def test_execution_policy_charges_adverse_slippage_and_fees_with_complete_basis(client):
    account = _create(client, execution_policy={"fee_bps": 100, "slippage_bps": 100})["account"]
    proposal = _propose(client, account)
    assert proposal["engine_version"] == "alphaview-paper-portfolio-v2"
    order = proposal["orders"][0]
    assert order["reference_price"] == 100 and order["fill_price"] == 101
    assert order["reference_notional"] == 3000 and order["notional"] == 3030
    assert order["fee"] == 30.3 and order["slippage_cost"] == 30
    assert proposal["fees_total"] == 30.3 and proposal["slippage_total"] == 30
    assert proposal["cash_after"] == 6939.7
    assert proposal["equity_after"] == 9939.7
    bought = _accept(client, account, proposal).json()["account"]
    assert bought["account"]["cash"] == 6939.7
    assert bought["holdings"][0]["cost_basis"] == 3060.3
    assert bought["holdings"][0]["average_cost"] == 102.01
    assert bought["unrealized_pnl"] == -60.3
    assert bought["ledger"][0]["price"] == 101
    assert bought["ledger"][0]["reference_price"] == 100
    assert bought["ledger"][0]["fee"] == 30.3
    account = bought["account"]
    sold_proposal = _propose(client, account, [], key="v2-sell-plan")
    sell = sold_proposal["orders"][0]
    assert sell["fill_price"] == 99 and sell["notional"] == 2970
    assert sell["fee"] == 29.7 and sell["cash_delta"] == 2940.3
    sold = _accept(client, account, sold_proposal, key="v2-sell-accept").json()["account"]
    assert sold["account"]["cash"] == 9880 and sold["holdings"] == []
    assert sold["realized_pnl"] == -120 and sold["unrealized_pnl"] == 0
    assert sold["total_return_pct"] == -1.2


def test_post_cost_weights_are_checked_even_when_target_weights_pass(client):
    account = _create(client, limits={"max_position_weight_pct": 30}, execution_policy={"fee_bps": 100})["account"]
    proposal = _propose(client, account)
    assert proposal["status"] == "blocked"
    assert proposal["targets"] == [{"symbol": "SYNTH", "weight_pct": 30}]
    assert proposal["projected_holdings"][0]["weight_pct"] > 30
    assert "post_policy_max_position_weight" in {row["code"] for row in proposal["violations"]}


def test_fees_can_block_cash_floor_and_do_not_silently_shrink_orders(client):
    account = _create(client, limits={"max_position_weight_pct": 100, "min_cash_weight_pct": 0}, execution_policy={"fee_bps": 10})["account"]
    proposal = _propose(client, account, [{"symbol": "SYNTH", "weight_pct": 100}])
    assert proposal["orders"][0]["shares"] == 100
    assert proposal["cash_after"] == -10
    assert not proposal["executable"]
    assert "insufficient_cash" in {row["code"] for row in proposal["violations"]}
    assert _accept(client, account, proposal).status_code == 409


def test_minimum_trade_preserves_cash_and_does_not_redistribute_weights(client):
    account = _create(client, execution_policy={"min_trade_notional": 2500})["account"]
    proposal = _propose(client, account, [{"symbol": "SYNTH", "weight_pct": 30}, {"symbol": "OTHER", "weight_pct": 20}])
    assert proposal["executable"]
    assert len(proposal["orders"]) == 1 and proposal["orders"][0]["shares"] == 30
    assert proposal["cash_after"] == 7000
    assert proposal["skipped_orders"] == [{"symbol": "OTHER", "reason": "min_trade_notional", "requested_shares": 40,
                                            "reference_notional": 2000, "message": "低於最小交易金額，保留目前持倉"}]
    result = _accept(client, account, proposal).json()["account"]
    assert result["holdings"][0]["weight_pct"] == 30


def test_skipped_sale_preserves_holding_and_actual_concentration_can_block(client):
    account = _create(client)["account"]
    bought = _accept(client, account, _propose(client, account)).json()["account"]
    updated = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": 2,
                           "limits": {"max_position_weight_pct": 20}, "execution_policy": {"min_trade_notional": 4000}}).json()
    proposal = _propose(client, updated["account"], [], key="skip-sale-plan")
    assert proposal["orders"] == []
    assert proposal["skipped_orders"][0]["reason"] == "min_trade_notional"
    assert proposal["projected_holdings"][0]["shares"] == bought["holdings"][0]["shares"]
    assert proposal["cash_after"] == bought["account"]["cash"]
    assert "post_policy_max_position_weight" in {row["code"] for row in proposal["violations"]}
    assert not proposal["executable"]


def test_whole_share_policy_rounds_order_quantity_toward_zero(client):
    account = _create(client, execution_policy={"share_precision": 0})["account"]
    with store.connect() as db:
        _bar(db, "SYNTH", 333)
    proposal = _propose(client, account, [{"symbol": "SYNTH", "weight_pct": 10}, {"symbol": "OTHER", "weight_pct": .1}])
    assert proposal["orders"][0]["shares"] == 3
    assert proposal["orders"][0]["notional"] == 999
    assert proposal["cash_after"] == 9001
    assert proposal["skipped_orders"][0]["reason"] == "share_precision"
    result = _accept(client, account, proposal)
    assert result.status_code == 200
    assert result.json()["account"]["holdings"][0]["shares"] == 3


def test_v1_proposal_is_preserved_but_cannot_be_accepted(client):
    account = _create(client)["account"]
    proposal = _propose(client, account)
    proposal["engine_version"] = "alphaview-paper-portfolio-v1"
    with store.connect() as db:
        saved = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (proposal["id"],)).fetchone()[0])
        saved["engine_version"] = "alphaview-paper-portfolio-v1"
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(saved), proposal["id"]))
    response = _accept(client, account, proposal)
    assert response.status_code == 409 and "方法版本" in response.json()["detail"]
    assert client.get(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}").json()["engine_version"] == "alphaview-paper-portfolio-v1"
    assert _db_counts()["paper_ledger"] == 1


def test_first_wave_schema_upgrade_preserves_accounts_and_immutable_proposals(client):
    account = _create(client)["account"]
    proposal = _propose(client, account)
    with store.connect() as db:
        saved = db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (proposal["id"],)).fetchone()[0]
        db.execute("ALTER TABLE paper_accounts DROP COLUMN execution_policy_json")
        for column in ("fee", "slippage_cost", "reference_price"):
            db.execute(f"ALTER TABLE paper_ledger DROP COLUMN {column}")
        paper.init_schema(db)
        paper.init_schema(db)
        assert db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (proposal["id"],)).fetchone()[0] == saved
    snapshot = client.get(f"/api/paper/accounts/{account['id']}").json()
    assert snapshot["account"]["cash"] == 10000
    assert snapshot["account"]["execution_policy"] == {"fee_bps": 0, "slippage_bps": 0, "min_trade_notional": 0, "share_precision": 6}
    assert snapshot["ledger"][0]["fee"] == 0


@pytest.mark.parametrize("policy", [
    {"fee_bps": -1}, {"fee_bps": 1001}, {"fee_bps": "NaN"}, {"fee_bps": True},
    {"slippage_bps": -1}, {"slippage_bps": 1001}, {"min_trade_notional": -1},
    {"min_trade_notional": 1000001}, {"share_precision": -1}, {"share_precision": 7},
    {"share_precision": 1.5}, {"share_precision": True}, {"unknown": 1},
])
def test_execution_policy_rejects_out_of_range_and_non_finite_inputs(client, policy):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic", "initial_cash": 1000,
                                                      "idempotency_key": "invalid-policy", "execution_policy": policy})
    assert response.status_code == 422


def test_python_guard_runs_before_idempotent_replay_and_is_atomic(client):
    from fastapi import HTTPException
    account = _create(client)["account"]
    body = paper.ProposalInput(expected_version=1, targets=[{"symbol": "SYNTH", "weight_pct": 30}], idempotency_key="guarded-plan")
    called = []
    def guard(db):
        assert db.in_transaction
        called.append(True)
    proposal = paper.create_proposal_guarded(account["id"], body, guard)
    assert called == [True]
    def reject(_):
        raise HTTPException(409, "Synthetic disabled mandate")
    with pytest.raises(HTTPException):
        paper.create_proposal_guarded(account["id"], body, reject)
    with pytest.raises(HTTPException):
        paper.accept_proposal_guarded(account["id"], proposal["id"], paper.AcceptInput(expected_version=1, idempotency_key="guarded-accept"), reject)
    assert _db_counts()["paper_ledger"] == 1



@pytest.fixture
def local_source(monkeypatch):
    import sys
    import types
    from fastapi import HTTPException
    module = types.ModuleType("alphaview.panel.local_agent")
    state = {"current": True, "targets": [{"symbol": "SYNTH", "weight_pct": 30}], "calls": []}
    def validate_source(db, source):
        assert db.in_transaction
        state["calls"].append(source)
        if source != {"analysis_id": "synthetic-analysis", "engine_version": "synthetic-local-agent-v1"} or not state["current"]:
            raise HTTPException(409, "Synthetic local analysis unavailable or stale")
        return {"target_weights": state["targets"]}
    module.validate_source = validate_source
    monkeypatch.setitem(sys.modules, "alphaview.panel.local_agent", module)
    yield state


def test_local_agent_binding_is_validated_for_preview_create_and_manual_accept(client, local_source):
    account = _create(client)["account"]
    source = {"analysis_id": "synthetic-analysis", "engine_version": "synthetic-local-agent-v1"}
    body = {"expected_version": 1, "targets": [{"symbol": "synth", "weight_pct": 30}], "local_agent_source": source}
    before = _db_counts()
    preview = client.post(f"/api/paper/accounts/{account['id']}/preview", json=body)
    assert preview.status_code == 200 and preview.json()["local_agent_source"] == source
    assert _db_counts() == before
    proposal = _propose(client, account, local_agent_source=source)
    assert proposal["local_agent_source"] == source
    accepted = _accept(client, account, proposal)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["proposal"]["local_agent_source"] == source
    assert len(local_source["calls"]) == 3


@pytest.mark.parametrize("target", [{"symbol": "SYNTH", "weight_pct": 31}, {"symbol": "OTHER", "weight_pct": 30}])
def test_local_agent_metadata_cannot_carry_different_targets(client, local_source, target):
    account = _create(client)["account"]
    body = {"expected_version": 1, "targets": [target],
            "local_agent_source": {"analysis_id": "synthetic-analysis", "engine_version": "synthetic-local-agent-v1"}}
    path = f"/api/paper/accounts/{account['id']}"
    assert client.post(f"{path}/preview", json=body).status_code == 409
    assert client.post(f"{path}/proposals", json={**body, "idempotency_key": "local-mismatch-plan"}).status_code == 409
    assert _db_counts()["paper_proposals"] == _db_counts()["paper_holdings"] == 0
    assert _db_counts()["paper_ledger"] == 1


def test_manual_accept_revalidates_local_analysis_and_does_not_fill_invalidated_source(client, local_source):
    account = _create(client)["account"]
    source = {"analysis_id": "synthetic-analysis", "engine_version": "synthetic-local-agent-v1"}
    proposal = _propose(client, account, local_agent_source=source)
    before = _db_counts()
    local_source["current"] = False
    response = _accept(client, account, proposal)
    assert response.status_code == 409
    assert _db_counts() == before
    assert client.get(f"/api/paper/accounts/{account['id']}").json()["account"]["cash"] == 10000
    local_source["current"] = True
    local_source["targets"] = [{"symbol": "SYNTH", "weight_pct": 25}]
    assert _accept(client, account, proposal).status_code == 409
    assert _db_counts() == before


def test_arbitrary_analysis_identity_and_invalid_validated_output_fail_closed(client, local_source):
    account = _create(client)["account"]
    request = {"expected_version": 1, "targets": [{"symbol": "SYNTH", "weight_pct": 30}],
               "local_agent_source": {"analysis_id": "invented-analysis", "engine_version": "synthetic-local-agent-v1"}}
    path = f"/api/paper/accounts/{account['id']}/preview"
    assert client.post(path, json=request).status_code == 409
    request["local_agent_source"]["analysis_id"] = "synthetic-analysis"
    local_source["targets"] = [{"symbol": "SYNTH", "weight_pct": "NaN"}]
    assert client.post(path, json=request).status_code == 409


@pytest.mark.parametrize("source", [{"analysis_id": "", "engine_version": "version"},
                                    {"analysis_id": "test", "engine_version": ""},
                                    {"analysis_id": "test", "engine_version": "version", "validated": True},
                                    {"analysis_id": "x" * 101, "engine_version": "version"}])
def test_local_agent_source_schema_is_bounded_and_forbids_claimed_validation(client, source):
    account = _create(client)["account"]
    response = client.post(f"/api/paper/accounts/{account['id']}/preview", json={"expected_version": 1,
        "targets": [], "local_agent_source": source})
    assert response.status_code == 422


def test_local_agent_and_automation_source_cannot_be_mixed(client):
    account = _create(client)["account"]
    response = client.post(f"/api/paper/accounts/{account['id']}/preview", json={"expected_version": 1, "targets": [],
        "local_agent_source": {"analysis_id": "test", "engine_version": "version"},
        "automation_source": {"mandate_id": "test", "mandate_version": 1, "attempt_id": "test"}})
    assert response.status_code == 422


def test_ordinary_v2_proposal_hash_and_idempotency_payload_stay_compatible(client):
    account = _create(client)["account"]
    proposal = _propose(client, account)
    legacy_payload = {"expected_version": 1, "targets": [{"symbol": "SYNTH", "weight_pct": 30.0}],
                      "rationale": "", "automation_source": None, "expected_input_revision": None, "expected_as_of": None}
    with store.connect() as db:
        row = db.execute("SELECT request_json,preview_json FROM paper_proposals WHERE id=?", (proposal["id"],)).fetchone()
        assert json.loads(row["request_json"]) == legacy_payload
        assert "local_agent_source" not in json.loads(row["preview_json"])
        key = db.execute("SELECT request_hash FROM paper_idempotency WHERE scope=? AND key='proposal-01'", (f"proposal:{account['id']}",)).fetchone()[0]
        assert key == paper._hash(legacy_payload)
    replay = _propose(client, account)
    assert replay == proposal
    assert replay["engine_version"] == "alphaview-paper-portfolio-v2"
    assert _accept(client, account, proposal).status_code == 200


def _set_symbol_policy(client, account, symbols, mode="allowlist"):
    response = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={
        "expected_version": account["version"], "symbol_policy": {"mode": mode, "symbols": symbols}})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def test_symbol_policy_history_is_immutable_versioned_and_readonly(client):
    revision = store.input_revision()
    account = _create(client)["account"]
    assert account["symbol_policy"] == {"engine_version": paper.SYMBOL_POLICY_VERSION, "version": 1,
                                         "mode": "unrestricted", "symbols": []}
    account = _set_symbol_policy(client, account, [" other ", "synth"])
    assert account["symbol_policy"]["symbols"] == ["OTHER", "SYNTH"]
    assert account["symbol_policy"]["version"] == 2
    account = _set_symbol_policy(client, account, ["SYNTH", "OTHER"])
    assert account["symbol_policy"]["version"] == 2
    account = _set_symbol_policy(client, account, [], "unrestricted")
    assert account["symbol_policy"]["version"] == 3
    history = client.get(f"/api/paper/accounts/{account['id']}/symbol-policy/history").json()
    assert [item["policy"]["version"] for item in history["items"]] == [3, 2, 1]
    assert history["items"][1]["policy"]["symbols"] == ["OTHER", "SYNTH"]
    assert store.input_revision() == revision
    assert json.dumps(history, allow_nan=False)
    with store.connect() as db:
        rows = [tuple(row) for row in db.execute("SELECT * FROM paper_symbol_policy_history ORDER BY version")]
        paper.init_schema(db)
        assert rows == [tuple(row) for row in db.execute("SELECT * FROM paper_symbol_policy_history ORDER BY version")]


@pytest.mark.parametrize("policy", [
    {"mode": "allowlist", "symbols": ["SYNTH", " synth "]},
    {"mode": "allowlist", "symbols": ["SYNTH;DROP"]},
    {"mode": "allowlist", "symbols": [True]},
    {"mode": "allowlist", "symbols": ["SYNTH"], "version": 99},
    {"mode": "unrestricted", "symbols": ["SYNTH"]},
    {"mode": "unknown", "symbols": []},
    {"mode": "allowlist", "symbols": [f"SYN{i}" for i in range(101)]},
])
def test_symbol_policy_rejects_invalid_or_client_assigned_versions(client, policy):
    account = _create(client)["account"]
    response = client.patch(f"/api/paper/accounts/{account['id']}/controls", json={
        "expected_version": account["version"], "symbol_policy": policy})
    assert response.status_code == 422
    assert client.get(f"/api/paper/accounts/{account['id']}").json()["account"]["version"] == 1


def test_allowlist_blocks_new_exposure_before_precision_and_minimum_skips(client):
    account = _create(client, symbol_policy={"mode": "allowlist", "symbols": ["OTHER"]},
                      execution_policy={"share_precision": 0, "min_trade_notional": 2000})["account"]
    for index, weight in enumerate((30, .000001)):
        proposal = _propose(client, account, [{"symbol": "SYNTH", "weight_pct": weight}], key=f"excluded-{index}")
        assert proposal["status"] == "blocked"
        assert [row["symbol"] for row in proposal["violations"] if row["code"] == "symbol_not_allowed"] == ["SYNTH"]
        assert proposal["symbol_policy"]["engine_version"] == paper.SYMBOL_POLICY_VERSION
        assert _accept(client, account, proposal, key=f"excluded-accept-{index}").status_code == 409
    # Explicit zero targets on unknown/excluded symbols do not introduce exposure.
    empty = _propose(client, account, [{"symbol": "UNKNOWN", "weight_pct": 0}], key="zero-excluded")
    assert empty["executable"] and empty["orders"] == []


@pytest.mark.parametrize("weight,allowed", [(30, True), (20, True), (0, True), (30.00000001, False)])
def test_excluded_held_symbols_use_prerounding_share_reduce_only(client, weight, allowed):
    account = _create(client)["account"]
    initial = _propose(client, account)
    account = _accept(client, account, initial).json()["account"]["account"]
    account = _set_symbol_policy(client, account, [])
    proposal = _propose(client, account, [{"symbol": "SYNTH", "weight_pct": weight}], key="reduce-only-plan")
    assert proposal["executable"] is allowed
    if allowed:
        assert all(row["side"] == "sell" for row in proposal["orders"])
        accepted = _accept(client, account, proposal, key="reduce-only-accept")
        assert accepted.status_code == 200, accepted.text
        shares = sum(row["shares"] for row in accepted.json()["account"]["holdings"])
        assert shares <= 30
    else:
        assert "symbol_not_allowed" in {row["code"] for row in proposal["violations"]}
        assert proposal["orders"] == []  # Even a rounded-away increase is refused.


def test_policy_sell_down_never_waives_missing_prices_and_omission_targets_zero(client):
    account = _create(client)["account"]
    account = _accept(client, account, _propose(client, account)).json()["account"]["account"]
    account = _set_symbol_policy(client, account, [])
    close = _propose(client, account, [], key="clear-excluded")
    assert close["orders"][0]["side"] == "sell" and close["orders"][0]["shares"] == 30
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE symbol='SYNTH'")
    missing = _propose(client, account, [], key="clear-without-price")
    assert not missing["executable"] and not missing["valuation_complete"]
    assert "quote_unavailable" in {row["code"] for row in missing["violations"]}


def test_policy_roundtrip_invalidates_old_proposal_and_preserves_receipt(client):
    account = _create(client)["account"]
    proposal = _propose(client, account)
    assert "symbol_policy" not in proposal  # Historical unrestricted hash remains compatible.
    account = _set_symbol_policy(client, account, ["OTHER"])
    account = _set_symbol_policy(client, account, [], "unrestricted")
    assert _accept(client, account, proposal).status_code == 409
    assert client.get(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}").json() == proposal
    fresh = _propose(client, account, key="fresh-after-roundtrip")
    assert fresh["symbol_policy"]["version"] == 3
    assert _accept(client, account, fresh, key="fresh-roundtrip-accept").status_code == 200


def test_symbol_policy_migration_preserves_legacy_proposal_authority(client):
    account = _create(client)["account"]
    proposal = _propose(client, account)
    with store.connect() as db:
        db.execute("DROP TABLE paper_symbol_policy_history")
        db.execute("ALTER TABLE paper_accounts DROP COLUMN symbol_policy_json")
        paper.init_schema(db)
    assert _accept(client, account, proposal).status_code == 200
