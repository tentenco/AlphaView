"""Single-symbol refresh tests use only synthetic paper-only holdings and fake Yahoo."""
import json
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from alphaview.panel import corporate_action_refresh as refresh
from alphaview.panel import corporate_actions, jobs, market, paper_portfolio as paper, sessions, store

DAYS = sessions.expected_sessions("2026-09-01", "2026-09-04")
SYMBOL = "PAPERONLY"


def history(close=100.):
    return pd.DataFrame({"Open": [close] * 4, "High": [close + 1] * 4, "Low": [close - 1] * 4,
        "Close": [close] * 4, "Adj Close": [close] * 4, "Volume": [1000.] * 4,
        "Dividends": [0., 0., 0., 2.], "Stock Splits": [0.] * 4}, index=pd.to_datetime(DAYS))


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "synthetic-corporate-refresh.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: DAYS[-1])
    monkeypatch.setattr(market, "latest_completed_session", lambda: DAYS[-1])
    store.init_db()
    app = FastAPI()
    for router in (refresh.router, jobs.router, paper.router, corporate_actions.router):
        app.include_router(router)
    client = TestClient(app)
    account = client.post("/api/paper/accounts", json={"name": "Synthetic corporate refresh", "initial_cash": 10000,
        "idempotency_key": "synthetic-account"}).json()["account"]
    with store.connect() as db:
        db.execute("INSERT INTO paper_holdings VALUES (?,?,?,?)", (account["id"], SYMBOL, "5", "500"))
        db.executemany("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", [(SYMBOL, day, 90., 91., 89., 90., 90., 1000.) for day in DAYS])
        db.execute("INSERT INTO datasets(symbol,name,currency,exchange,last_date,bar_count,status) VALUES (?,?, 'USD','NMS',?,4,'ok')", (SYMBOL, "Synthetic", DAYS[-1]))
    calls = []
    class Ticker:
        def __init__(self, symbol):
            assert symbol == SYMBOL
        def history(self, **kwargs):
            calls.append(kwargs)
            return history()
        def get_history_metadata(self):
            return {"currency": "USD", "longName": "Synthetic paper-only", "exchangeName": "NMS"}
    monkeypatch.setattr("yfinance.Ticker", Ticker)
    value = {"client": client, "account": account, "calls": calls,
             "path": f"/api/paper/accounts/{account['id']}/corporate-actions/refresh"}
    yield value
    if jobs.RUN_LOCK.locked():
        jobs.RUN_LOCK.release()
    client.close()


def body(setup, **extra):
    return {"symbol": SYMBOL, "expected_account_version": setup["account"]["version"],
            "expected_input_revision": store.input_revision(), "expected_as_of": DAYS[-1],
            "idempotency_key": "synthetic-refresh-key", **extra}


def start(setup, payload=None):
    payload = payload or body(setup)
    with patch.object(jobs, "launch_locked") as launch:
        response = setup["client"].post(setup["path"], json=payload)
    assert response.status_code == 202, response.text
    if not response.json()["replayed"]:
        assert launch.call_args.args[1] == refresh.KIND
    return response.json()["job"]


def run(setup, job):
    jobs.worker(job["id"], refresh.KIND)
    return setup["client"].get(setup["path"] + "/" + job["id"]).json()["job"]


def books():
    with store.connect() as db:
        return {name: [tuple(row) for row in db.execute(f"SELECT * FROM {name} ORDER BY 1")]
                for name in ("paper_accounts", "paper_holdings", "paper_ledger", "positions", "market_universe")}


def test_paper_only_symbol_refreshes_once_and_never_changes_books_or_universe(setup):
    before = books()
    original = body(setup)
    job = start(setup, original)
    assert start(setup, original)["id"] == job["id"]
    finished = run(setup, job)
    assert finished["status"] == "completed" and len(setup["calls"]) == 1
    assert finished["result"]["after"]["resolution"] == "not_proven"
    assert finished["result"]["holding_context"] == "unchanged"
    assert finished["result"]["after"]["returned_events"] == 1
    assert finished["result"]["after"]["provider_status"] == "available"
    assert books() == before
    assert "不代表" in finished["progress"] and "帳本未調整" in finished["progress"]
    assert not jobs.RUN_LOCK.locked()
    # The identical old request remains idempotent even though input_revision advanced.
    assert start(setup, original)["id"] == job["id"] and len(setup["calls"]) == 1
    assert setup["client"].get(setup["path"]).json()["job"]["id"] == job["id"]
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM scans").fetchone()[0] == 0


@pytest.mark.parametrize("changes,status", [({"expected_account_version": 99}, 409),
    ({"expected_input_revision": "synthetic:old"}, 409), ({"expected_as_of": "2026-09-03"}, 409),
    ({"symbol": "UNHELD"}, 422), ({"symbol": "bad symbol"}, 422),
    ({"expected_as_of": "2026-02-30"}, 422), ({"expected_account_version": True}, 422),
    ({"symbols": [SYMBOL]}, 422), ({"idempotency_key": "x"}, 422)])
def test_strict_context_rejection_never_leaves_lock_or_ghost_job(setup, changes, status):
    response = setup["client"].post(setup["path"], json=body(setup, **changes))
    assert response.status_code == status, response.text
    assert not jobs.RUN_LOCK.locked() and setup["calls"] == []
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_busy_is_409_with_no_job_and_same_key_different_body_is_rejected(setup):
    assert jobs.RUN_LOCK.acquire(False)
    response = setup["client"].post(setup["path"], json=body(setup))
    assert response.status_code == 409 and response.json()["detail"]["code"] == "workspace_busy"
    jobs.RUN_LOCK.release()
    original = body(setup)
    job = start(setup, original)
    response = setup["client"].post(setup["path"], json={**original, "symbol": "OTHER"})
    assert response.status_code == 409 and response.json()["detail"]["code"] == "idempotency_conflict"
    assert setup["client"].post(setup["path"], json=original).json()["job"]["id"] == job["id"]


def test_existing_retry_admission_stays_restricted_and_new_kind_is_not_public_jobinput(setup):
    assert setup["client"].post("/api/jobs", json={"kind": "retry", "symbols": [SYMBOL]}).status_code == 422
    assert setup["client"].post("/api/jobs", json={"kind": refresh.KIND}).status_code == 422
    start(setup)


@pytest.mark.parametrize("change", ["account", "holdings", "inputs"])
def test_worker_rechecks_context_before_calling_provider(setup, change):
    job = start(setup)
    with store.connect() as db:
        if change == "account":
            db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup["account"]["id"],))
        elif change == "holdings":
            db.execute("DELETE FROM paper_holdings WHERE account_id=?", (setup["account"]["id"],))
        else:
            db.execute("UPDATE bars SET volume=volume+1 WHERE symbol=?", (SYMBOL,))
    finished = run(setup, job)
    assert finished["status"] == "failed" and setup["calls"] == []
    assert finished["result"]["resolution"] == "not_proven"
    assert not jobs.RUN_LOCK.locked()


def test_account_change_during_fetch_is_visible_and_does_not_claim_current_holding_validation(setup):
    job = start(setup)
    def fetch_history(**kwargs):
        with store.connect() as db:
            db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup["account"]["id"],))
        return history()
    fake = SimpleNamespace(history=fetch_history, get_history_metadata=lambda: {"currency": "USD", "longName": "Synthetic", "exchangeName": "NMS"})
    with patch("yfinance.Ticker", return_value=fake):
        finished = run(setup, job)
    assert finished["status"] == "completed"
    assert finished["result"]["holding_context"] == "changed_not_validated"
    assert "本次未驗證目前持倉" in finished["progress"]


def test_provider_failure_keeps_old_bars_and_finishes_with_failed_unresolved_receipt(setup):
    before = store.history(SYMBOL)
    job = start(setup)
    with patch("yfinance.Ticker", side_effect=RuntimeError("synthetic provider offline")):
        finished = run(setup, job)
    assert finished["status"] == "failed" and finished["error"] == "synthetic provider offline"
    assert finished["result"]["after"]["resolution"] == "not_proven"
    pd.testing.assert_frame_equal(store.history(SYMBOL), before)
    assert not jobs.RUN_LOCK.locked()


def test_cancel_before_provider_preserves_context_for_duplicate_and_latest_lookup(setup):
    payload = body(setup)
    job = start(setup, payload)
    assert setup["client"].post(f"/api/jobs/{job['id']}/cancel").status_code == 202
    finished = run(setup, job)
    assert finished["status"] == "cancelled" and setup["calls"] == []
    assert finished["progress"] == "公司行動重檢已取消；已完整保存的行情與回傳證據仍保留，帳本未調整；不代表異常已修復。"
    assert setup["client"].get(setup["path"]).json()["job"]["id"] == job["id"]
    assert start(setup, payload)["status"] == "cancelled"


def test_cancel_during_fetch_keeps_completed_atomic_quotes_and_reports_cancelled(setup):
    job = start(setup)
    def fetch_history(**kwargs):
        jobs.cancel_job(job["id"])
        return history(120.)
    fake = SimpleNamespace(history=fetch_history, get_history_metadata=lambda: {"currency": "USD", "longName": "Synthetic", "exchangeName": "NMS"})
    with patch("yfinance.Ticker", return_value=fake):
        finished = run(setup, job)
    assert finished["status"] == "cancelled" and not jobs.RUN_LOCK.locked()
    assert store.history(SYMBOL).iloc[-1].close == 120.
    assert "行情與回傳證據仍保留" in finished["progress"]
    assert "帳本未調整" in finished["progress"] and "不代表異常已修復" in finished["progress"]
    assert "選股" not in finished["progress"]


def test_thread_failure_and_interrupted_recovery_preserve_original_request_context(setup):
    payload = body(setup)
    with patch.object(jobs.threading.Thread, "start", side_effect=RuntimeError("synthetic start failure")):
        with pytest.raises(HTTPException) as caught:
            refresh.start_refresh(setup["account"]["id"], refresh.RefreshInput(**payload))
    assert caught.value.status_code == 503 and not jobs.RUN_LOCK.locked()
    failed = setup["client"].get(setup["path"]).json()["job"]
    assert failed["status"] == "failed"
    assert start(setup, payload)["id"] == failed["id"]
    job = start(setup, body(setup, idempotency_key="synthetic-second-key"))
    jobs.RUN_LOCK.release()  # Simulate process termination releasing its kernel lock.
    assert jobs.RUN_LOCK.acquire(False)
    with store.connect() as db:
        jobs.recover_interrupted_locked(db)
    jobs.RUN_LOCK.release()
    interrupted = setup["client"].get(setup["path"] + "/" + job["id"]).json()["job"]
    assert interrupted["status"] == "interrupted"
    assert interrupted["error"] == "背景程序已中斷，請手動重新執行"


def test_account_context_is_checked_in_addition_to_id_namespace(setup):
    job = start(setup)
    with store.connect() as db:
        row = db.execute("SELECT result FROM jobs WHERE id=?", (job["id"],)).fetchone()
        context = json.loads(row[0]); context["account_id"] = "different-synthetic-account"
        db.execute("UPDATE jobs SET result=? WHERE id=?", (json.dumps(context), job["id"]))
    response = setup["client"].get(setup["path"])
    assert response.status_code == 409 and response.json()["detail"]["code"] == "job_context_invalid"
    response = setup["client"].post(setup["path"], json=body(setup))
    assert response.status_code == 409


def test_unknown_account_and_scoped_missing_job_are_explicit(setup):
    assert setup["client"].get("/api/paper/accounts/missing/corporate-actions/refresh").status_code == 404
    assert setup["client"].get(setup["path"] + "/missing").status_code == 404
    assert setup["client"].get(setup["path"]).json() == {"job": None}


def test_concurrent_repeat_requests_create_one_job_and_one_provider_fetch(setup):
    from concurrent.futures import ThreadPoolExecutor
    payload = body(setup)
    with patch.object(jobs, "launch_locked"), ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: setup["client"].post(setup["path"], json=payload), range(2)))
    assert all(response.status_code in (202, 409) for response in responses)
    accepted = [response.json()["job"] for response in responses if response.status_code == 202]
    assert accepted and len({job["id"] for job in accepted}) == 1
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    assert run(setup, accepted[0])["status"] == "completed" and len(setup["calls"]) == 1


def test_other_job_kinds_keep_the_existing_cancellation_message(setup):
    with store.connect() as db:
        db.execute("INSERT INTO jobs(id,kind,status,started_at,scope,cancel_requested) VALUES ('synthetic-scan','scan','running',?,'portfolio',1)", (store.now(),))
    assert jobs.RUN_LOCK.acquire(False)
    jobs.worker("synthetic-scan", "scan")
    with store.connect() as db:
        row = db.execute("SELECT status,progress FROM jobs WHERE id='synthetic-scan'").fetchone()
    assert tuple(row) == ("cancelled", "作業已取消；已完成下載及完整發布的選股紀錄保留，未完成計算不會發布。")
    assert not jobs.RUN_LOCK.locked() and setup["calls"] == []
