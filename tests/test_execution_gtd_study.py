"""Synthetic open-only GTD progression, unknown evidence and exact calendar boundaries."""
import json
import sqlite3

import pytest

from alphaview.panel import execution_gtd_study as gtd, sessions, store
from tests.test_execution_volume_study import workspace, bar, state, SIGNAL, EXECUTION  # noqa: F401
from tests.test_execution_limit_study import sell_proposal

DAYS = ["2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12"]


@pytest.fixture
def ready(workspace):
    workspace[0].app.include_router(gtd.router)
    with store.connect() as db:
        for day in DAYS[1:]:
            for symbol in ("SYNTA", "SYNTB"):
                bar(db, symbol, day, 100, 100)
    workspace[3]["session"] = DAYS[-1]
    return workspace


def url(ready):
    return f"/api/paper/accounts/{ready[1]['id']}/proposals/{ready[2]['id']}/gtd-study"


def body(ready, **changes):
    response = ready[0].get(url(ready) + "/context")
    assert response.status_code == 200, response.text
    value = response.json()
    return {"expected_account_version": value["account_version"], "expected_input_revision": value["input_revision"],
            "expected_as_of": value["as_of"], "expected_proposal_fingerprint": value["source"]["proposal_fingerprint"],
            "participation_pct": 10, "limits": [], "gtd_date": DAYS[-1], **changes}


def study(ready, **changes):
    response = ready[0].post(url(ready), json=body(ready, **changes))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    json.dumps(result, allow_nan=False)
    fingerprint = result.pop("evidence_fingerprint")
    assert fingerprint == gtd.paper._hash(result)
    result["evidence_fingerprint"] = fingerprint
    return result


def test_full_scenario_carries_fixed_remainder_and_does_not_claim_expiry_even_with_future_gtd(ready):
    ready[3]["session"] = DAYS[2]
    before = state()
    result = study(ready)
    first, second = result["orders"]
    assert result["engine_version"] == gtd.ENGINE_VERSION and result["time_in_force"] == "GTD"
    assert not result["gtd_session_completed"] and result["status"] == "complete"
    assert first["status"] == "scenario_full" and first["final_scenario_shares"] == 30
    assert [step["scenario_shares"] for step in first["sessions"]] == [10, 10, 10, None, None]
    assert [step["remaining_after"] for step in first["sessions"]] == [20, 10, 0, None, None]
    assert [step["status"] for step in first["sessions"]][-2:] == ["not_required_scenario_full"] * 2
    assert first["completed_in_scenario_at"] == DAYS[2]
    assert first["expired_shares"] is None and first["expiry_verified"] is False
    assert first["expiry_state"] == "not_applicable_scenario_full"
    assert second["coverage"]["evaluated_sessions"] == 1 and second["final_scenario_shares"] == 20
    assert result["source"]["current"] is False and result["source"]["available"] is True
    assert "NOT opening liquidity" in result["method"] and state() == before
    assert study(ready) == result


def test_partial_expiry_requires_every_active_session_completed_with_evidence(ready):
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=100 WHERE date>?", (SIGNAL,))
    result = study(ready, participation_pct=1)
    first = result["orders"][0]
    assert first["status"] == "partial_expired" and first["expiry_verified"]
    assert first["final_scenario_shares_exact"] == "5.000000" and first["expired_shares_exact"] == "25.000000"
    assert first["coverage"] == {"required_sessions": 5, "evaluated_sessions": 5, "not_required_sessions": 0, "unknown_sessions": 0, "complete": True}
    assert first["final_reference_notional_exact"] == "510.00000000"
    assert first["sessions"][0]["raw_open"] == 110


def test_future_sessions_are_not_read_even_if_future_bars_exist_and_prefix_is_not_final(ready):
    ready[3]["session"] = DAYS[1]
    row = study(ready)["orders"][0]
    assert row["status"] == "unavailable" and row["reason"] == "execution_session_not_completed"
    assert row["observed_prefix_scenario_shares"] == 20 and row["last_known_remaining_shares"] == 10
    assert row["observed_prefix_end"] == DAYS[1]
    assert row["final_scenario_shares"] is row["expired_shares"] is row["final_reference_notional"] is None
    assert row["sessions"][2]["status"] == "future_unknown"
    assert row["sessions"][2]["evidence"]["execution_bar"] is None
    assert all(step["scenario_shares"] is step["remaining_after"] is None for step in row["sessions"][2:])
    assert study(ready)["status"] == "unavailable"


@pytest.mark.parametrize("mutation,reason", [
    ("DELETE FROM bars WHERE symbol='SYNTA' AND date='2024-01-09'", "missing_execution_bar"),
    ("UPDATE bars SET volume='missing' WHERE symbol='SYNTA' AND date='2024-01-09'", "invalid_execution_volume"),
    ("UPDATE bars SET open=0 WHERE symbol='SYNTA' AND date='2024-01-09'", "invalid_execution_open"),
    ("UPDATE bars SET adj_close=50 WHERE symbol='SYNTA' AND date='2024-01-09'", "adjustment_factor_changed"),
    ("UPDATE bars SET adj_close=99 WHERE symbol='SYNTA' AND date='2024-01-09'", "adjustment_factor_changed"),
    ("UPDATE bars SET high=1 WHERE symbol='SYNTA' AND date='2024-01-09'", "invalid_execution_bar"),
])
def test_missing_or_changed_evidence_stops_subsequent_simulation_without_redistributing(ready, mutation, reason):
    with store.connect() as db:
        db.execute(mutation)
        db.execute("UPDATE bars SET volume=999999 WHERE symbol='SYNTA' AND date>'2024-01-09'")
    result = study(ready)
    row = result["orders"][0]
    assert row["reason"] == reason and row["status"] == "unavailable"
    assert row["observed_prefix_scenario_shares_exact"] == "10.000000" and row["last_known_remaining_shares_exact"] == "20.000000"
    assert row["sessions"][1]["remaining_before"] == 20 and row["sessions"][1]["remaining_after"] is None
    assert all(step["status"] == "blocked_by_unknown" and step["evidence"] is None for step in row["sessions"][2:])
    assert row["final_scenario_shares"] is row["expired_shares"] is None
    assert result["orders"][1]["final_scenario_shares"] == 20 and result["status"] == "unavailable"


@pytest.mark.parametrize("limit,expected", [(99, [0, 0, 0]), (100, [0, 10, 10]), (110, [10, 10, 10])])
def test_fixed_buy_limit_only_uses_each_raw_open_with_equality(ready, limit, expected):
    with store.connect() as db:
        db.execute("UPDATE bars SET low=1,high=999 WHERE symbol='SYNTA' AND date>?", (SIGNAL,))
    row = study(ready, gtd_date=DAYS[2], limits=[{"symbol": "SYNTA", "limit_price": limit}])["orders"][0]
    assert [step["scenario_shares"] for step in row["sessions"]] == expected
    assert all(step["intraday_outcome"] == "unknown_from_daily_bars" for step in row["sessions"])
    assert row["final_scenario_shares"] == sum(expected)
    if sum(expected) < 30:
        assert row["expired_shares"] == 30 - sum(expected) and row["expiry_verified"]


def test_fixed_sell_limit_and_holiday_calendar(ready):
    ready[3]["session"] = EXECUTION
    selling = sell_proposal(ready)
    context = selling[0].get(url(selling) + "/context").json()
    assert [item["date"] for item in context["allowed_expiry_sessions"]] == ["2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12", "2024-01-16"]
    with store.connect() as db:
        bar(db, "SYNTA", "2024-01-10", 110, 100)
    selling[3]["session"] = "2024-01-10"
    row = study(selling, gtd_date="2024-01-10", limits=[{"symbol": "SYNTA", "limit_price": 100}])["orders"][0]
    assert row["side"] == "sell"
    assert [step["open_condition"] for step in row["sessions"]] == ["not_satisfied", "satisfied"]
    assert [step["scenario_shares"] for step in row["sessions"]] == [0, 10]


def test_decimal_rounding_each_day_never_reuses_another_symbols_capacity(ready):
    with store.connect() as db:
        db.execute("UPDATE bars SET volume=1.23456789 WHERE symbol='SYNTA' AND date>?", (SIGNAL,))
    row = study(ready, participation_pct=1)["orders"][0]
    assert [step["scenario_shares_exact"] for step in row["sessions"]] == ["0.012345"] * 5
    assert row["final_scenario_shares_exact"] == "0.061725" and row["expired_shares_exact"] == "29.938275"


@pytest.mark.parametrize("zero_kind", ["participation", "volume"])
def test_explicit_zero_expires_only_when_evidence_complete(ready, zero_kind):
    if zero_kind == "volume":
        with store.connect() as db:
            db.execute("UPDATE bars SET volume=0 WHERE date>?", (SIGNAL,))
    rows = study(ready, participation_pct=0 if zero_kind == "participation" else 10)["orders"]
    assert all(row["status"] == "unfilled_expired" and row["final_scenario_shares"] == 0 and row["expired_shares"] == row["shares"] for row in rows)


def test_no_available_first_session_does_not_fabricate_zero_observed_prefix(ready):
    ready[3]["session"] = SIGNAL
    row = study(ready)["orders"][0]
    assert row["observed_prefix_end"] is row["observed_prefix_scenario_shares"] is row["last_known_remaining_shares"] is None
    assert row["sessions"][0]["remaining_before"] == row["shares"]
    assert row["final_scenario_shares"] is row["expired_shares"] is None


def test_context_and_post_are_query_only_and_preserve_all_database_tables(ready, monkeypatch):
    original = gtd._context
    def readonly(db, *args):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM paper_accounts")
        return original(db, *args)
    monkeypatch.setattr(gtd, "_context", readonly)
    with store.connect() as db:
        before = list(db.iterdump())
    study(ready)
    with store.connect() as db:
        assert list(db.iterdump()) == before


@pytest.mark.parametrize("field,value", [("expected_input_revision", "stale"), ("expected_account_version", 999), ("expected_as_of", SIGNAL), ("expected_proposal_fingerprint", "f" * 64)])
def test_source_cas_rejects_stale_input(ready, field, value):
    response = ready[0].post(url(ready), json=body(ready, **{field: value}))
    assert response.status_code == 409


def test_completed_session_rollover_during_compute_returns_409(ready, monkeypatch):
    payload = body(ready)
    original = gtd._order
    def changed(*args):
        result = original(*args)
        ready[3]["session"] = "2024-01-16"
        return result
    monkeypatch.setattr(gtd, "_order", changed)
    assert ready[0].post(url(ready), json=payload).status_code == 409


@pytest.mark.parametrize("changes", [
    {"gtd_date": SIGNAL}, {"gtd_date": "2024-01-06"}, {"gtd_date": "2024-01-16"},
    {"gtd_date": "2024-02-30"}, {"gtd_date": None}, {"session_count": 5},
    {"participation_pct": True}, {"participation_pct": 101}, {"expected_account_version": 2_147_483_648},
    {"limits": [{"symbol": "SYNTA", "limit_price": True}]},
    {"limits": [{"symbol": "SYNTA", "limit_price": 0}]},
    {"limits": [{"symbol": "SYNTA", "limit_price": 100}] * 2},
    {"limits": [{"symbol": "UNKNOWN", "limit_price": 100}]},
])
def test_strict_finite_bounded_input(ready, changes):
    before = state()
    response = ready[0].post(url(ready), json=body(ready, **changes))
    assert response.status_code == 422 and state() == before


def test_duplicate_saved_symbols_cannot_reuse_daily_capacity(ready):
    with store.connect() as db:
        stored = db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (ready[2]["id"],)).fetchone()[0]
        preview = json.loads(stored)
        preview["orders"].append(preview["orders"][0])
        db.execute("UPDATE paper_proposals SET preview_json=? WHERE id=?", (json.dumps(preview), ready[2]["id"]))
    response = ready[0].get(url(ready) + "/context")
    assert response.status_code == 422 and response.json()["detail"]["code"] == "saved_proposal_unavailable"


def test_cross_account_source_is_not_exposed(ready):
    other = ready[0].post("/api/paper/accounts", json={"name": "SYNTHETIC other GTD", "initial_cash": 1000, "idempotency_key": "other-gtd"}).json()["account"]
    response = ready[0].get(url((ready[0], other, ready[2], ready[3])) + "/context")
    assert response.status_code == 404


def test_nonfinite_nested_limit_is_rejected_without_server_serialization_error(ready):
    payload = json.dumps(body(ready, limits=[{"symbol": "SYNTA", "limit_price": 100}])).replace('"limit_price": 100', '"limit_price": 1e999')
    response = ready[0].post(url(ready), content=payload, headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "nonfinite_input"
