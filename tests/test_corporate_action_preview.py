"""Synthetic local captures and paper fills; no market/model/broker calls."""
import json
from decimal import Decimal

import pandas as pd
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import corporate_action_evidence as evidence
from alphaview.panel import corporate_action_preview as preview
from alphaview.panel import paper_portfolio as paper, sessions, store

DAYS = sessions.expected_sessions("2024-01-02", "2024-01-31")


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "synthetic-preview.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: DAYS[-1])
    store.init_db()
    app = FastAPI()
    app.include_router(preview.router)
    account = paper.create_account(paper.AccountInput(name="Synthetic preview", initial_cash=10000.,
        idempotency_key="synthetic-preview-account"))["account"]
    with TestClient(app) as client:
        yield client, account


def capture(symbol="SYNTA", splits=None, dividends=None, omit=None, days=DAYS):
    frame = pd.DataFrame({"date": days, "Dividends": [0.] * len(days), "Stock Splits": [0.] * len(days)})
    for day, value in (splits or {}).items():
        frame.loc[frame["date"] == day, "Stock Splits"] = value
    for day, value in (dividends or {}).items():
        frame.loc[frame["date"] == day, "Dividends"] = value
    if omit:
        frame = frame.drop(columns=[omit])
    records = [(symbol, day, 100., 101., 99., 100., 100., 1000.) for day in days]
    evidence.publish(symbol, records, {"name": "Synthetic", "currency": "USD", "exchange": "NMS", "last_date": days[-1]},
                     evidence.prepare(frame, "synthetic-adapter"), evidence.capture_identity(symbol))


def fill(account, day, shares="10", price="100", symbol="SYNTA", method=paper.ENGINE_VERSION):
    quantity, price = Decimal(shares), Decimal(price)
    with store.connect() as db:
        identifier = f"synthetic-fill-{db.execute('SELECT COUNT(*) FROM paper_proposals').fetchone()[0]}"
        current = paper._account(db, account["id"])
        cash_delta = -quantity * price
        order = {"symbol": symbol, "side": "buy" if quantity > 0 else "sell", "shares_exact": str(abs(quantity)),
                 "notional_exact": str(abs(quantity * price)), "fee_exact": "0", "fill_price_exact": str(price),
                 "cash_delta_exact": str(cash_delta), "slippage_cost_exact": "0", "reference_price": float(price)}
        saved = {"account_id": account["id"], "engine_version": method, "as_of": day, "orders": [order]}
        if method == "alphaview-paper-next-open-v1":
            saved["effective_session"] = day
        db.execute("INSERT INTO paper_proposals VALUES (?,?,'simulated',?,'{}',?,?)",
                   (identifier, account["id"], paper._json(saved), store.now(), store.now()))
        paper._settle_orders(db, current, identifier, [order], str(Decimal(current["cash"]) + cash_delta), store.now())
    return identifier


def read(workspace):
    client, account = workspace
    response = client.get(f"/api/paper/accounts/{account['id']}/corporate-actions/ledger-preview")
    assert response.status_code == 200, response.text
    value = response.json()
    json.dumps(value, allow_nan=False)
    return value


def first(workspace):
    return read(workspace)["holdings"][0]


def state():
    with store.connect() as db:
        return {row[0]: [tuple(value) for value in db.execute(f'SELECT * FROM "{row[0]}" ORDER BY rowid')]
                for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def test_compounds_reported_splits_preserves_cost_and_never_writes(workspace, monkeypatch):
    _, account = workspace
    fill(account, DAYS[0])
    capture(splits={DAYS[5]: 2., DAYS[8]: .5}, dividends={DAYS[6]: 1.25})
    before, revision = state(), store.input_revision()
    value = read(workspace)
    row = value["holdings"][0]
    assert value["engine_version"] == preview.ENGINE_VERSION and value["as_of"] == DAYS[-1]
    assert value["account_id"] == account["id"] and value["account_version"] == 2
    assert value["ledger_mutated"] is False and value["source_completeness"] == "unknown"
    assert row["status"] == "conditional" and row["source"]["status"] == "available"
    assert len(row["source"]["fingerprint"]) == 64 and row["source"]["first_fetched_at"]
    split, dividend, reverse = row["events"]
    assert split["before"]["shares"] == 10 and split["after"]["shares"] == 20
    assert split["after"]["average_cost"] == 50 and split["after"]["cost_basis"] == 1000
    assert reverse["before"]["shares"] == 20 and reverse["after"]["shares"] == 10
    assert row["conditional_after"]["cost_basis_exact"] == "1000" and row["conditional_after"]["average_cost"] == 100
    assert dividend["source_value"] == 1.25 and dividend["cash_entitlement"] is None
    assert dividend["entitlement"] == "unknown" and dividend["record_date"] is None and dividend["pay_date"] is None
    assert row["coverage"]["calculated_splits"] == 2 and row["coverage"]["unavailable_events"] == 1
    assert row["coverage"]["required_sessions"] == len(DAYS)
    assert state() == before and store.input_revision() == revision

    # The endpoint must run inside SQLite's query-only snapshot, including its clock.
    def readonly_clock():
        with store.connect() as db:
            assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        return DAYS[-1]
    monkeypatch.setattr(sessions, "latest_completed_session", readonly_clock)
    assert read(workspace)["holdings"][0]["status"] == "conditional"


@pytest.mark.parametrize("fill_day", [DAYS[5], DAYS[6]])
def test_same_session_or_later_trade_blocks_whole_split_chain(workspace, fill_day):
    fill(workspace[1], DAYS[0])
    fill(workspace[1], fill_day, shares="2")
    capture(splits={DAYS[5]: 2., DAYS[8]: 3.})
    row = first(workspace)
    assert row["status"] == "unavailable" and "fill_on_or_after_split" in row["reasons"]
    assert row["conditional_after"] is None and row["coverage"]["calculated_splits"] == 0
    assert all(event["before"] is None and event["after"] is None for event in row["events"])


def test_pre_event_sales_reconcile_average_cost_but_dividend_entitlement_stays_unknown(workspace):
    fill(workspace[1], DAYS[0], shares="10", price="100")
    fill(workspace[1], DAYS[1], shares="10", price="120")
    fill(workspace[1], DAYS[2], shares="-5", price="125")
    capture(splits={DAYS[5]: 2.}, dividends={DAYS[6]: 3.})
    row = first(workspace)
    assert row["ledger"]["status"] == "reconciled"
    assert row["current"]["shares"] == 15 and row["current"]["cost_basis"] == 1650
    assert row["conditional_after"]["shares"] == 30 and row["conditional_after"]["average_cost"] == 55
    assert row["events"][1]["cash_entitlement"] is None


def test_closed_and_reopened_position_excludes_earlier_events(workspace):
    fill(workspace[1], DAYS[0])
    fill(workspace[1], DAYS[2], shares="-10")
    fill(workspace[1], DAYS[6], shares="4")
    capture(splits={DAYS[4]: 2., DAYS[8]: 3.})
    row = first(workspace)
    assert row["ledger"]["entry_session"] == DAYS[6]
    assert row["events"][0]["status"] == "outside_holding_period"
    assert row["conditional_after"]["shares"] == 12 and row["coverage"]["calculated_splits"] == 1


@pytest.mark.parametrize("mode,reason", [
    ("missing", "source_not_current"), ("stale", "source_not_current"),
    ("source_failed", "source_not_current"), ("missing_column", "split_column_unavailable"),
    ("short_window", "holding_period_not_covered"), ("missing_day", "holding_sessions_missing"),
    ("unknown_cell", "split_cells_unavailable"), ("ends_early", "source_not_current"),
])
def test_missing_or_stale_split_evidence_never_computes(workspace, mode, reason):
    fill(workspace[1], DAYS[0])
    if mode != "missing":
        capture(splits={DAYS[5]: 2., **({DAYS[8]: float("nan")} if mode == "unknown_cell" else {})},
                omit="Stock Splits" if mode == "missing_column" else None,
                days=DAYS[1:] if mode == "short_window" else [day for day in DAYS if day != DAYS[3]] if mode == "missing_day" else DAYS[:-1] if mode == "ends_early" else DAYS)
    if mode in ("stale", "source_failed"):
        with store.connect() as db:
            if mode == "stale":
                db.execute("UPDATE bars SET close=101 WHERE symbol='SYNTA' AND date=?", (DAYS[2],))
            else:
                db.execute("UPDATE datasets SET status='error',error='synthetic failure' WHERE symbol='SYNTA'")
    row = first(workspace)
    assert row["status"] == "unavailable" and reason in row["reasons"]
    assert row["conditional_after"] is None and row["coverage"]["calculated_splits"] == 0


def test_missing_dividend_column_does_not_invent_cash_or_block_complete_split_column(workspace):
    fill(workspace[1], DAYS[0])
    capture(splits={DAYS[5]: 2.}, omit="Dividends")
    row = first(workspace)
    assert row["source"]["status"] == "partial"
    assert row["source"]["coverage"]["columns"]["Dividends"]["unavailable"] == len(DAYS)
    assert row["status"] == "conditional" and row["conditional_after"]["shares"] == 20
    assert row["events"][0]["cash_entitlement"] is None


@pytest.mark.parametrize("mode,reason", [
    ("fork", "fill_provenance_unavailable"), ("other_account", "fill_provenance_unavailable"),
    ("missing_proposal", "fill_provenance_unavailable"), ("different_order", "fill_provenance_unavailable"),
    ("unsupported", "fill_provenance_unavailable"), ("nonfinite", "holding_value_unavailable"),
    ("mismatch", "ledger_holding_mismatch"), ("future_fill", "fill_session_unavailable"),
])
def test_untrusted_historical_holding_or_scope_stays_unavailable(workspace, mode, reason):
    identifier = fill(workspace[1], DAYS[0])
    capture(splits={DAYS[5]: 2.})
    with store.connect() as db:
        if mode == "fork":
            db.execute("UPDATE paper_ledger SET kind='opening_mark',proposal_id=NULL WHERE symbol='SYNTA'")
        elif mode == "other_account":
            other = dict(db.execute("SELECT * FROM paper_accounts").fetchone())
            other["id"] = "synthetic-other"
            db.execute(f"INSERT INTO paper_accounts ({','.join(other)}) VALUES ({','.join('?' for _ in other)})", tuple(other.values()))
            db.execute("UPDATE paper_proposals SET account_id='synthetic-other' WHERE id=?", (identifier,))
        elif mode == "missing_proposal":
            db.execute("DELETE FROM paper_proposals WHERE id=?", (identifier,))
        elif mode in ("different_order", "unsupported", "future_fill"):
            value = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (identifier,)).fetchone()[0])
            if mode == "different_order":
                value["orders"][0]["shares_exact"] = "11"
            elif mode == "unsupported":
                value["engine_version"] = "synthetic-unknown-v1"
            else:
                value["as_of"] = "2024-02-01"
            db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(value), identifier))
        elif mode == "nonfinite":
            db.execute("UPDATE paper_holdings SET shares='Infinity'")
        else:
            db.execute("UPDATE paper_holdings SET cost_basis='1001'")
    row = first(workspace)
    assert reason in row["reasons"] and row["status"] == "unavailable"
    assert row["conditional_after"] is None and row["events"][0]["after"] is None


def test_next_open_uses_effective_session_and_rejects_missing_effective_provenance(workspace):
    identifier = fill(workspace[1], DAYS[0], method="alphaview-paper-next-open-v1")
    capture(splits={DAYS[5]: 2.})
    assert first(workspace)["status"] == "conditional"
    with store.connect() as db:
        value = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (identifier,)).fetchone()[0])
        value["effective_session"] = DAYS[1]
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(value), identifier))
    assert "fill_session_unavailable" in first(workspace)["reasons"]


def test_nonfinite_arithmetic_invalidates_whole_chain_without_zero_or_partial_total(workspace):
    fill(workspace[1], DAYS[0])
    capture(splits={DAYS[5]: 2., DAYS[8]: 1e308})
    row = first(workspace)
    assert row["reasons"] == ["calculation_nonfinite"] and row["conditional_after"] is None
    assert row["coverage"]["calculated_splits"] == 0
    assert all(event["after"] is None for event in row["events"])


def test_underflow_does_not_fabricate_zero_shares(workspace):
    fill(workspace[1], DAYS[0])
    capture(splits={DAYS[5]: 1e-308, DAYS[8]: 1e-308})
    row = first(workspace)
    assert row["status"] == "unavailable" and row["conditional_after"] is None
    assert "calculation_nonfinite" in row["reasons"]
    assert all(event["after"] is None for event in row["events"])


@pytest.mark.parametrize("missing", ["as_of", "effective_session"])
def test_missing_next_open_session_never_uses_signal_or_wall_clock(workspace, missing):
    identifier = fill(workspace[1], DAYS[0], method="alphaview-paper-next-open-v1")
    capture(splits={DAYS[5]: 2.})
    with store.connect() as db:
        value = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (identifier,)).fetchone()[0])
        value.pop(missing)
        value["signal_session"] = DAYS[0]
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(value), identifier))
    row = first(workspace)
    assert row["status"] == "unavailable" and "fill_session_unavailable" in row["reasons"]


def test_same_day_entry_is_unknown_and_weekend_fill_is_invalid(workspace):
    identifier = fill(workspace[1], DAYS[5])
    capture(splits={DAYS[5]: 2.})
    assert "fill_on_or_after_split" in first(workspace)["reasons"]
    with store.connect() as db:
        value = json.loads(db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (identifier,)).fetchone()[0])
        value["as_of"] = "2024-01-06"
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(value), identifier))
    assert "fill_session_unavailable" in first(workspace)["reasons"]


def test_inference_alone_does_not_create_split_arithmetic(workspace):
    fill(workspace[1], DAYS[0])
    capture()
    with store.connect() as db:
        db.execute("UPDATE bars SET close=200,adj_close=100 WHERE symbol='SYNTA' AND date<?", (DAYS[5],))
    row = first(workspace)
    assert row["events"] == [] and row["conditional_after"] is None
    assert row["coverage"]["calculated_splits"] == 0


def test_out_of_order_historical_sessions_fail_closed(workspace):
    fill(workspace[1], DAYS[2])
    fill(workspace[1], DAYS[1])
    capture(splits={DAYS[5]: 2.})
    row = first(workspace)
    assert "fill_session_unavailable" in row["reasons"] and row["conditional_after"] is None


def test_invalid_ancient_session_is_unavailable_without_calendar_exception(workspace):
    fill(workspace[1], "0001-01-01")
    capture(splits={DAYS[5]: 2.})
    row = first(workspace)
    assert "fill_session_unavailable" in row["reasons"] and row["conditional_after"] is None


def test_non_session_split_event_does_not_gain_entitlement_from_current_shares(workspace):
    fill(workspace[1], DAYS[0])
    capture(splits={"2024-01-06": 2.}, days=sorted([*DAYS, "2024-01-06"]))
    row = first(workspace)
    assert "split_event_session_unavailable" in row["reasons"] and row["conditional_after"] is None


def test_empty_and_unknown_account_do_not_borrow_other_account_evidence(workspace):
    assert read(workspace)["status"] == "empty" and read(workspace)["coverage"]["holdings"] == 0
    assert workspace[0].get("/api/paper/accounts/missing/corporate-actions/ledger-preview").status_code == 404
    fill(workspace[1], DAYS[0])
    capture(splits={DAYS[5]: 2.})
    other = paper.create_account(paper.AccountInput(name="Synthetic empty", initial_cash=1000., idempotency_key="synthetic-empty-account"))["account"]
    result = workspace[0].get(f"/api/paper/accounts/{other['id']}/corporate-actions/ledger-preview").json()
    assert result["holdings"] == [] and result["account_id"] == other["id"]
