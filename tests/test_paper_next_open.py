"""Synthetic future-session queues; no market download or private positions."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import json
import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pandas as pd
import pytest

from alphaview.panel import paper_next_open as next_open, paper_portfolio as paper, sessions, store


def _bar(db, symbol, price=100, day="2024-01-05", close=None):
    close = price if close is None else close
    db.execute("""INSERT INTO datasets(symbol,currency,status,last_date) VALUES (?,'USD','ok',?)
        ON CONFLICT(symbol) DO UPDATE SET last_date=excluded.last_date""", (symbol, day))
    db.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?,?)",
               (symbol, day, price, max(price, close) * 1.01, min(price, close) * .99, close, close, 1000))


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "next-open.db"))
    clock = {"now": pd.Timestamp("2024-01-06T12:00:00Z")}
    real_latest = sessions.latest_completed_session
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: real_latest(clock["now"] if at is None else at))
    monkeypatch.setattr(next_open, "utcnow", lambda: clock["now"].to_pydatetime())
    monkeypatch.setattr(store, "now", lambda: clock["now"].isoformat())
    store.init_db()
    with store.connect() as db:
        next_open.init_schema(db)
        for symbol in ("SYNTH", "OTHER", "UNRELATED"):
            _bar(db, symbol)
    app = FastAPI()
    app.include_router(paper.router)
    app.include_router(next_open.router)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, clock


def _account(client, **changes):
    response = client.post("/api/paper/accounts", json={"name": "Synthetic next-open", "initial_cash": 10000,
        "limits": {"max_position_weight_pct": 100, "min_cash_weight_pct": 0, "max_turnover_pct": 200},
        "idempotency_key": "account-create-01", **changes})
    assert response.status_code == 200, response.text
    return response.json()["account"]


def _proposal(client, account, targets=None, key="proposal-create-01"):
    response = client.post(f"/api/paper/accounts/{account['id']}/proposals", json={"expected_version": account["version"],
        "targets": [{"symbol": "SYNTH", "weight_pct": 30}] if targets is None else targets, "idempotency_key": key})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "proposed", response.text
    return response.json()


def _url(account, order=None, action=None):
    result = f"/api/paper/accounts/{account['id']}/next-open-orders"
    if order:
        result += f"/{order['id']}"
    return result + f"/{action}" if action else result


def _enqueue(client, account, proposal, **changes):
    collection = client.get(_url(account))
    assert collection.status_code == 200, collection.text
    source = next(item for item in collection.json()["source_proposals"] if item["id"] == proposal["id"])
    body = {"proposal_id": proposal["id"], "expected_account_version": account["version"],
        "expected_proposal_fingerprint": source["proposal_fingerprint"],
        "max_execution_cost_usd": 100, "max_buy_cash_debit_usd": 20000,
        "confirm_next_open_simulation": True, "idempotency_key": "enqueue-order-01", **changes}
    return client.post(_url(account), json=body), body


def _setup(workspace, **account_changes):
    client, clock = workspace
    account = _account(client, **account_changes)
    proposal = _proposal(client, account)
    response, body = _enqueue(client, account, proposal)
    assert response.status_code == 200, response.text
    return client, clock, account, proposal, response.json(), body


def _advance(clock, prices=None, at="2024-01-08T21:15:00Z", day="2024-01-08"):
    clock["now"] = pd.Timestamp(at)
    with store.connect() as db:
        for symbol, price in (prices or {"SYNTH": 110, "OTHER": 90}).items():
            _bar(db, symbol, price, day=day)


def _process(client, account, order, key="process-order-01"):
    return client.post(_url(account, order, "process"), json={"expected_order_version": order["version"], "idempotency_key": key})


def _fills():
    with store.connect() as db:
        return [dict(row) for row in db.execute("SELECT * FROM paper_ledger WHERE kind='simulated_fill' ORDER BY id")]


def test_enqueue_is_explicit_atomic_idempotent_and_preserves_source(workspace):
    client, clock, account, proposal, order, body = _setup(workspace)
    revision = store.input_revision()
    assert order["status"] == "waiting_session"
    assert order["signal_session"] == "2024-01-05" and order["execution_session"] == "2024-01-08"
    assert order["enqueue_before"] == "2024-01-08T14:30:00+00:00"
    assert order["eligible_after"] == "2024-01-08T21:15:00+00:00"
    assert order["source_prefix"]["rows"] == 3 and order["source_prefix"]["symbols"] == 3
    assert order["frozen_orders"][0]["shares"] == 30
    assert client.post(_url(account), json=body).json() == order
    assert client.post(_url(account), json={**body, "max_execution_cost_usd": 101}).status_code == 409
    assert client.post(_url(account), json={**body, "idempotency_key": "another-enqueue"}).status_code == 409
    assert client.get(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}").json() == proposal
    assert _fills() == [] and store.input_revision() == revision
    json.dumps(client.get(_url(account)).json(), allow_nan=False)


def test_fixed_shares_open_fees_basis_and_independent_receipt(workspace):
    client, clock, account, proposal, order, _ = _setup(workspace,
        execution_policy={"fee_bps": 10, "slippage_bps": 20, "min_trade_notional": 0, "share_precision": 6})
    source_revision = store.input_revision()
    _advance(clock)
    revision = store.input_revision()
    assert revision != source_revision
    response = _process(client, account, order)
    assert response.status_code == 200, response.text
    filled = response.json()
    assert filled["status"] == "filled" and not filled["late_recording"]
    assert filled["execution_proposal_id"] != proposal["id"]
    evaluation = filled["last_evaluation"]
    assert evaluation["orders"][0]["shares"] == 30
    assert evaluation["orders"][0]["reference_price"] == 110
    assert evaluation["orders"][0]["fill_price"] == 110.22
    assert evaluation["fees_total"] == 3.3066
    assert evaluation["slippage_total"] == 6.6
    assert evaluation["cost_total"] == 9.9066
    assert evaluation["cash_after"] == 6690.0934
    assert evaluation["equity_after"] == 9990.0934
    with store.connect() as db:
        holding = db.execute("SELECT * FROM paper_holdings WHERE account_id=?", (account["id"],)).fetchone()
        assert Decimal(holding["shares"]) == 30 and Decimal(holding["cost_basis"]) == Decimal("3309.9066")
        assert db.execute("SELECT COUNT(*) FROM paper_nav_snapshots").fetchone()[0] == 0
    receipt = client.get(f"/api/paper/accounts/{account['id']}/proposals/{filled['execution_proposal_id']}").json()
    assert receipt["engine_version"] == next_open.ENGINE_VERSION and receipt["status"] == "simulated"
    assert receipt["as_of"] == receipt["effective_session"] == "2024-01-08"
    assert receipt["queue_order_id"] == order["id"]
    assert client.get(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}").json() == proposal
    assert _process(client, account, order).json() == filled
    assert len(_fills()) == 1 and store.input_revision() == revision
    assert not client.get(_url(account, order)).json()["execution_reference_revised"]


@pytest.mark.parametrize("at", ["2024-01-08T14:30:00Z", "2024-01-08T16:00:00Z", "2024-01-08T21:10:00Z"])
def test_enqueue_cannot_authorize_after_already_known_open(workspace, at):
    client, clock = workspace
    account = _account(client)
    proposal = _proposal(client, account)
    clock["now"] = pd.Timestamp(at)
    response, _ = _enqueue(client, account, proposal)
    assert response.status_code == 409
    assert not client.get(_url(account)).json()["enqueue_window"]["can_enqueue"]


def test_exact_cutoff_rechecked_after_digest_before_write(workspace, monkeypatch):
    client, clock = workspace
    account, original = _account(client), next_open._prefix_digest
    proposal = _proposal(client, account)
    def crossing(*args):
        result = original(*args)
        clock["now"] = pd.Timestamp("2024-01-08T14:30:00Z")
        return result
    monkeypatch.setattr(next_open, "_prefix_digest", crossing)
    response, _ = _enqueue(client, account, proposal)
    assert response.status_code == 409
    assert client.get(_url(account)).json()["total"] == 0


def test_completed_session_buffer_is_required_even_if_open_is_available(workspace):
    client, clock, account, _, order, _ = _setup(workspace)
    _advance(clock, at="2024-01-08T21:14:59Z")
    waiting = _process(client, account, order).json()
    assert waiting["status"] == "waiting_session" and _fills() == []
    clock["now"] = pd.Timestamp("2024-01-08T21:15:00Z")
    assert _process(client, account, waiting, key="ready-process-key").json()["status"] == "filled"


def test_missing_exact_day_stays_pending_and_never_rolls_to_later_bar(workspace):
    client, clock, account, _, order, _ = _setup(workspace)
    _advance(clock, day="2024-01-09", at="2024-01-09T21:15:00Z")
    waiting = _process(client, account, order).json()
    assert waiting["status"] == "waiting_prices" and waiting["execution_session"] == "2024-01-08"
    preview = waiting["last_evaluation"]
    assert preview["cash_after"] is None and preview["equity_before"] is None
    assert preview["cost_total"] is None and preview["orders"] == []
    assert preview["coverage"]["missing"] == ["SYNTH"] and _fills() == []
    _advance(clock, at="2024-01-09T21:15:00Z")
    filled = _process(client, account, waiting, key="retry-exact-date").json()
    assert filled["status"] == "filled" and filled["late_recording"]
    assert filled["effective_session"] == "2024-01-08" and filled["recorded_at"].startswith("2024-01-09")


@pytest.mark.parametrize("change", ["other_symbol", "historical_insert", "delete", "identity"])
def test_source_prefix_includes_untraded_symbols_and_all_prior_rows(workspace, change):
    client, clock, account, _, order, _ = _setup(workspace)
    _advance(clock)
    with store.connect() as db:
        if change == "other_symbol":
            db.execute("UPDATE bars SET volume=1001 WHERE symbol='UNRELATED'")
        elif change == "historical_insert":
            _bar(db, "UNRELATED", day="2024-01-04")
        elif change == "delete":
            db.execute("DELETE FROM bars WHERE symbol='UNRELATED'")
        else:
            db.execute("UPDATE datasets SET source='Changed source' WHERE symbol='UNRELATED'")
    result = _process(client, account, order).json()
    assert result["status"] == "invalidated" and result["reason_code"] == "source_history_changed"
    assert not _fills()


def test_identical_history_reload_new_day_and_new_unrelated_dataset_are_allowed(workspace):
    client, clock, account, _, order, _ = _setup(workspace)
    with store.connect() as db:
        rows = db.execute("SELECT * FROM bars").fetchall()
        db.execute("DELETE FROM bars")
        db.executemany("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", [tuple(row) for row in rows])
        db.execute("UPDATE datasets SET fetched_at='later',last_date='2024-01-08',bar_count=2,status='new-status'")
        _bar(db, "NEWAFTERAUTH", day="2024-01-04")
    _advance(clock)
    assert _process(client, account, order).json()["status"] == "filled"


@pytest.mark.parametrize("change", ["kill", "policy", "limits", "accept", "reject", "holdings_without_version"])
def test_account_or_source_mutations_invalidate_without_any_queue_fill(workspace, change):
    client, clock, account, proposal, order, _ = _setup(workspace)
    if change in ("kill", "policy", "limits"):
        fields = {"kill": {"kill_switch": True}, "policy": {"execution_policy": {"fee_bps": 1}},
                  "limits": {"limits": {"max_position_weight_pct": 80}}}[change]
        assert client.patch(f"/api/paper/accounts/{account['id']}/controls", json={"expected_version": 1, **fields}).status_code == 200
    elif change == "accept":
        assert client.post(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/accept",
            json={"expected_version": 1, "idempotency_key": "ordinary-accept-key"}).status_code == 200
    elif change == "reject":
        assert client.post(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}/reject", json={"expected_version": 1}).status_code == 200
    else:
        with store.connect() as db:
            db.execute("INSERT INTO paper_holdings VALUES (?,?,?,?)", (account["id"], "OTHER", "1", "100"))
    before = len(_fills())
    _advance(clock)
    result = _process(client, account, order).json()
    assert result["status"] == "invalidated" and len(_fills()) == before


@pytest.mark.parametrize("kind", ["cost_cap", "buy_cap", "cash", "position", "turnover", "min_cash", "min_trade", "corporate_action"])
def test_open_policy_failures_block_entire_batch_with_fixed_quantities(workspace, kind):
    client, clock = workspace
    account = _account(client, execution_policy={"fee_bps": 10, "slippage_bps": 20, "min_trade_notional": 1000},
        limits={"max_position_weight_pct": 35 if kind == "position" else 100,
                "max_turnover_pct": 35 if kind == "turnover" else 200,
                "min_cash_weight_pct": 65 if kind == "min_cash" else 0})
    proposal = _proposal(client, account)
    kwargs = {"cost_cap": {"max_execution_cost_usd": 5}, "buy_cap": {"max_buy_cash_debit_usd": 2000}}.get(kind, {})
    response, _ = _enqueue(client, account, proposal, **kwargs)
    assert response.status_code == 200, response.text
    order = response.json()
    opening = {"cash": 400, "position": 130, "turnover": 130, "min_cash": 130, "min_trade": 20}.get(kind, 110)
    _advance(clock, {"SYNTH": opening})
    if kind == "corporate_action":
        with store.connect() as db:
            db.execute("UPDATE bars SET adj_close=close/2 WHERE symbol='SYNTH' AND date='2024-01-08'")
    result = _process(client, account, order).json()
    assert result["status"] == "blocked", result
    assert result["last_evaluation"]["orders"][0]["shares"] == 30
    expected = {"cost_cap": "execution_cost_cap", "buy_cap": "buy_cash_debit_cap", "cash": "insufficient_cash",
        "position": "post_policy_max_position_weight", "turnover": "max_turnover", "min_cash": "min_cash_weight",
        "min_trade": "min_trade_notional", "corporate_action": "corporate_action_unsupported"}[kind]
    assert expected in {item["code"] for item in result["last_evaluation"]["violations"]}
    assert not _fills()


def test_sells_first_conserve_inventory_and_average_cost(workspace):
    client, clock = workspace
    account = _account(client, execution_policy={"fee_bps": 10, "slippage_bps": 20})
    original = _proposal(client, account)
    accepted = client.post(f"/api/paper/accounts/{account['id']}/proposals/{original['id']}/accept",
                          json={"expected_version": 1, "idempotency_key": "initial-close-fill"}).json()
    account = accepted["account"]["account"]
    proposal = _proposal(client, account, [{"symbol": "OTHER", "weight_pct": 30}], key="rotation-proposal")
    response, _ = _enqueue(client, account, proposal)
    assert response.status_code == 200, response.text
    order = response.json()
    _advance(clock)
    result = _process(client, account, order).json()
    assert result["status"] == "filled", result
    actual = [fill for fill in _fills() if fill["proposal_id"] == result["execution_proposal_id"]]
    assert [fill["symbol"] for fill in actual] == ["SYNTH", "OTHER"]
    # 30 * 109.78 sale, fee 3.2934, original basis 3009.006.
    assert Decimal(actual[0]["realized_pnl"]) == Decimal("281.1006")
    with store.connect() as db:
        assert db.execute("SELECT symbol FROM paper_holdings WHERE account_id=?", (account["id"],)).fetchall()[0][0] == "OTHER"


def test_cancel_races_are_versioned_and_replay_is_stable(workspace):
    client, clock, account, _, order, _ = _setup(workspace)
    body = {"expected_order_version": 1, "idempotency_key": "cancel-order-key"}
    cancelled = client.post(_url(account, order, "cancel"), json=body)
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    assert client.post(_url(account, order, "cancel"), json=body).json() == cancelled.json()
    _advance(clock)
    assert _process(client, account, order).status_code == 409 and not _fills()


def test_process_and_cancel_have_independent_idempotency_namespaces(workspace):
    client, clock, account, _, order, _ = _setup(workspace)
    waiting = _process(client, account, order, key="shared-action-key").json()
    result = client.post(_url(account, order, "cancel"), json={"expected_order_version": waiting["version"],
                                                             "idempotency_key": "shared-action-key"})
    assert result.status_code == 200 and result.json()["status"] == "cancelled"


@pytest.mark.parametrize("cancelled", [False, True])
def test_local_source_uses_historical_authority_after_enqueue(workspace, monkeypatch, cancelled):
    from fastapi import HTTPException
    from alphaview.panel import local_agent
    client, clock = workspace
    targets = [{"symbol": "SYNTH", "weight_pct": 30.0}]
    current = {"allowed": True}
    def validate_current(db, source):
        if not current["allowed"]:
            raise HTTPException(409, "current-only source expired")
        return {"target_weights": targets}
    def validate_historical(db, source):
        if not current["allowed"] and cancelled:
            raise HTTPException(409, "historical authorization cancelled")
        return {"analysis_id": "synthetic-analysis", "target_weights": targets, "authorization_fingerprint": "stable"}
    monkeypatch.setattr(local_agent, "validate_source", validate_current)
    monkeypatch.setattr(local_agent, "validate_historical_source", validate_historical)
    account = _account(client)
    proposal = client.post(f"/api/paper/accounts/{account['id']}/proposals", json={"expected_version": 1, "targets": targets,
        "local_agent_source": {"analysis_id": "synthetic-analysis", "engine_version": local_agent.ENGINE_VERSION},
        "idempotency_key": "local-source-proposal"}).json()
    response, _ = _enqueue(client, account, proposal)
    assert response.status_code == 200, response.text
    current["allowed"] = False
    _advance(clock)
    result = _process(client, account, response.json()).json()
    assert result["status"] == ("invalidated" if cancelled else "filled")
    assert len(_fills()) == (0 if cancelled else 1)


def test_duplicate_process_requests_commit_once(workspace):
    client, clock, account, _, order, _ = _setup(workspace)
    _advance(clock)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: _process(client, account, order), range(2)))
    assert [response.status_code for response in results] == [200, 200]
    assert results[0].json() == results[1].json() and len(_fills()) == 1


def test_settlement_exception_rolls_back_receipt_holdings_ledger_and_queue(workspace, monkeypatch):
    client, clock, account, _, order, _ = _setup(workspace)
    _advance(clock)
    original = paper._settle_orders
    def fail_after_settlement(*args):
        original(*args)
        raise RuntimeError("synthetic settlement failure")
    monkeypatch.setattr(paper, "_settle_orders", fail_after_settlement)
    assert _process(client, account, order).status_code == 500
    assert not _fills()
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM paper_holdings").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM paper_proposals").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM paper_next_open_attempts").fetchone()[0] == 0
    assert client.get(_url(account, order)).json()["version"] == 1


def test_snapshot_market_race_is_retryable_and_leaves_no_partial_write(workspace, monkeypatch):
    client, clock, account, _, order, _ = _setup(workspace)
    _advance(clock)
    original = next_open._prepare_process
    def change_after_prepare(*args):
        result = original(*args)
        # Raw separate connection deliberately simulates an external writer.
        with sqlite3.connect(store.db_path()) as db:
            db.execute("UPDATE bars SET volume=1001 WHERE date='2024-01-08'")
        return result
    monkeypatch.setattr(next_open, "_prepare_process", change_after_prepare)
    assert _process(client, account, order).status_code == 503
    assert not _fills() and client.get(_url(account, order)).json()["version"] == 1


def test_runner_waits_for_data_then_persists_and_never_auto_retries_blocked(workspace):
    client, clock, account, _, order, _ = _setup(workspace)
    assert next_open.tick()["processed"] == 0
    clock["now"] = pd.Timestamp("2024-01-08T21:15:00Z")
    assert next_open.tick()["processed"] == 1
    waiting = client.get(_url(account, order)).json()
    assert waiting["status"] == "waiting_prices"
    assert next_open.tick()["processed"] == 0
    _advance(clock, {"SYNTH": 500})
    assert next_open.tick()["processed"] == 1
    blocked = client.get(_url(account, order)).json()
    assert blocked["status"] == "blocked"
    _advance(clock, {"SYNTH": 110})
    assert next_open.tick()["processed"] == 0
    assert client.get(_url(account, order)).json()["version"] == blocked["version"]
    assert _process(client, account, blocked, key="explicit-risk-retry").json()["status"] == "filled"


def test_idle_or_not_due_runner_never_acquires_workspace_writer_lock(workspace, monkeypatch):
    from alphaview.panel import jobs
    client, clock = workspace
    def unexpected_lock(*args, **kwargs):
        raise AssertionError("idle next-open runner must leave unrelated workspace writes unblocked")
    monkeypatch.setattr(jobs.RUN_LOCK, "acquire", unexpected_lock)
    assert next_open.tick() == {"processed": 0, "reason": "no_due_orders"}
    account = _account(client)
    proposal = _proposal(client, account)
    response, _ = _enqueue(client, account, proposal)
    assert response.status_code == 200
    order = response.json()
    assert next_open.tick()["processed"] == 0  # Waiting for the specified session.
    clock["now"] = pd.Timestamp("2024-01-08T21:15:00Z")
    waiting = _process(client, account, order).json()
    assert waiting["status"] == "waiting_prices"
    assert next_open.tick()["processed"] == 0  # Same missing data, no new inputs.


def test_readonly_and_restart_schema_do_not_mutate_history_or_revision(workspace):
    client, clock, account, _, order, _ = _setup(workspace)
    revision = store.input_revision()
    with store.connect() as db:
        next_open.init_schema(db)
        before = db.total_changes
    assert client.get(_url(account, order)).json() == order
    assert client.get(_url(account)).status_code == 200
    assert store.input_revision() == revision and before == 0
    _advance(clock)
    assert next_open.tick()["processed"] == 1
    assert next_open.tick()["processed"] == 0


def test_prefix_limit_is_explicit_no_truncation_or_queue_write(workspace, monkeypatch):
    client, clock = workspace
    account = _account(client)
    proposal = _proposal(client, account)
    monkeypatch.setattr(next_open, "MAX_PREFIX_ROWS", 2)
    result, _ = _enqueue(client, account, proposal)
    assert result.status_code == 422 and client.get(_url(account)).json()["total"] == 0


def test_filled_reference_correction_is_flagged_but_never_reprices_receipt(workspace):
    client, clock, account, _, order, _ = _setup(workspace)
    _advance(clock)
    result = _process(client, account, order).json()
    fills = _fills()
    _advance(clock, {"SYNTH": 120})
    detail = client.get(_url(account, order)).json()
    assert detail["execution_reference_revised"]
    assert detail["last_evaluation"] == result["last_evaluation"] and _fills() == fills


@pytest.mark.parametrize("field,value", [("confirm_next_open_simulation", False), ("confirm_next_open_simulation", 1),
    ("max_execution_cost_usd", -1), ("max_buy_cash_debit_usd", "1000"), ("expected_account_version", True), ("unknown", 1)])
def test_strict_enqueue_contract(workspace, field, value):
    client, clock = workspace
    account = _account(client)
    proposal = _proposal(client, account)
    response, _ = _enqueue(client, account, proposal, **{field: value})
    assert response.status_code == 422


def test_policy_edit_and_roundtrip_invalidate_frozen_queue(workspace):
    client, clock, account, proposal, order, _ = _setup(workspace)
    account = paper.update_controls(account["id"], paper.ControlsInput(expected_version=1,
        symbol_policy={"mode": "allowlist", "symbols": ["OTHER"]}))["account"]
    paper.update_controls(account["id"], paper.ControlsInput(expected_version=account["version"],
        symbol_policy={"mode": "unrestricted", "symbols": []}))
    _advance(clock)
    result = _process(client, account, order).json()
    assert result["status"] == "invalidated" and result["reason_code"] == "account_changed"
    assert not _fills()
    assert client.get(f"/api/paper/accounts/{account['id']}/proposals/{proposal['id']}").json() == proposal


def test_next_open_permits_excluded_holding_sell_down_under_frozen_policy(workspace):
    client, clock = workspace
    account = _account(client)
    buy = _proposal(client, account)
    receipt = paper.accept_proposal(account["id"], buy["id"], paper.AcceptInput(expected_version=1, idempotency_key="initial-buy-fill"))
    account = receipt["account"]["account"]
    account = paper.update_controls(account["id"], paper.ControlsInput(expected_version=account["version"],
        symbol_policy={"mode": "allowlist", "symbols": []}))["account"]
    sale = _proposal(client, account, targets=[], key="excluded-sale-proposal")
    response, _ = _enqueue(client, account, sale)
    assert response.status_code == 200, response.text
    order = response.json()
    assert order["symbol_policy"] == account["symbol_policy"]
    _advance(clock)
    result = _process(client, account, order).json()
    assert result["status"] == "filled"
    assert result["last_evaluation"]["symbol_policy"] == account["symbol_policy"]
    assert result["last_evaluation"]["orders"][0]["side"] == "sell"
    assert client.get(f"/api/paper/accounts/{account['id']}").json()["holdings"] == []


def test_next_open_legacy_automation_freezes_actual_attempt_engine(workspace, monkeypatch):
    from alphaview.panel import agent_automation as automation, portfolio_agent as agent, scan_provenance
    client, clock = workspace
    account = _account(client)
    target = [{"symbol": "SYNTH", "weight_pct": 30}]
    source = {"mandate_id": "synthetic-mandate", "mandate_version": 1, "attempt_id": "synthetic-attempt"}
    attempt = {"account_id": account["id"], "run_id": "synthetic-rule-run", "engine_version": "alphaview-agent-automation-v1"}
    result = {"engine_version": agent.ENGINE_VERSION, "scan": {"engine_version": scan_provenance.SCAN_ENGINE_VERSION}, "target_weights": target}
    with store.connect() as db:
        db.execute("INSERT INTO portfolio_agent_runs VALUES (?,?,?,?,?,?,?,?)", (attempt["run_id"], "synthetic", agent.ENGINE_VERSION,
            "2024-01-05", store.input_revision(db), "proposed", "{}", json.dumps(result)))
    monkeypatch.setattr(automation, "validate_source", lambda db, source: attempt)
    monkeypatch.setattr(automation, "ENGINE_VERSION", "alphaview-agent-automation-v1")
    proposal = paper.create_proposal(account["id"], paper.ProposalInput(expected_version=1, targets=target,
        automation_source=source, idempotency_key="legacy-automation-proposal"))
    response, _ = _enqueue(client, account, proposal)
    assert response.status_code == 200, response.text
    order = response.json()
    monkeypatch.setattr(automation, "ENGINE_VERSION", "alphaview-agent-automation-v2")
    _advance(clock)
    result = _process(client, account, order).json()
    assert result["status"] == "filled", result
