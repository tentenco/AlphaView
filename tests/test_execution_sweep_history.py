"""Synthetic per-submission sweep history, with fake broker and isolated SQLite."""
import json
import sqlite3
import uuid

import pytest
from fastapi import HTTPException

from alphaview.panel import alpaca_paper as alpaca, execution, execution_sweep_history as history, store
from tests.test_execution import account, connect, proposal, setup, submit  # noqa: F401


@pytest.fixture
def ready(setup):
    setup["client"].app.include_router(history.router)
    connect()
    acct = account("Synthetic sweep history")
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 30}, {"symbol": "SYNTB", "weight_pct": 20}])
    sent = submit(setup, acct, prop)
    assert sent.status_code == 201, sent.text
    return setup, acct, sent.json()


def url(acct):
    return f"/api/execution/accounts/{acct['id']}/sweep-history"


def rows():
    with store.connect() as db:
        return [tuple(row) for row in db.execute("SELECT * FROM execution_sweep_events ORDER BY id")]


def summary(identifier):
    with store.connect() as db:
        return json.loads(db.execute("SELECT summary_json FROM execution_submissions WHERE id=?", (identifier,)).fetchone()[0])


def protected():
    with store.connect() as db:
        return {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")] for table in
                ("paper_accounts", "paper_ledger", "paper_holdings", "positions", "paper_proposals", "execution_orders", "execution_submissions", "panel_revisions")}


def sweep(ready, reason="synthetic-first"):
    setup, acct, sent = ready
    response = setup["client"].post(f"/api/execution/accounts/{acct['id']}/cancel-working", json={"expected_account_version": acct["version"], "reason": reason})
    assert response.status_code == 200, response.text
    return response.json()


def test_two_sweeps_remain_exact_after_later_reconciliation_and_reads_never_write(ready, monkeypatch):
    setup, acct, sent = ready
    first = sweep(ready)
    initial = rows()
    first_payload = json.loads(initial[0][-1])
    assert first_payload["results"] == first["results"] and len(initial) == 1
    assert summary(sent["id"])["kill_switch_sweep"] == {key: first_payload[key] for key in ("at", "reason", "results")}
    # Reconciliation reports a working order again, allowing a genuinely distinct sweep.
    setup["broker"].orders["broker-0001"]["status"] = "accepted"
    setup["client"].post(f"/api/execution/submissions/{sent['id']}/reconcile")
    second = sweep(ready, "synthetic-second")
    assert len(second["results"]) == 1 and len(rows()) == 2
    setup["broker"].fill("broker-0001")
    current = setup["client"].post(f"/api/execution/submissions/{sent['id']}/reconcile").json()
    assert current["orders"][0]["status"] == "filled"
    assert first_payload["results"][0]["action"] == "cancel_requested"
    assert initial[0] in rows()
    assert summary(sent["id"])["kill_switch_sweep"]["reason"] == "synthetic-second"
    saved_rows, state, revision = rows(), protected(), store.input_revision()
    monkeypatch.setattr(alpaca, "_request", lambda *a, **k: pytest.fail("GET must not access broker"))
    original = history._view
    def readonly(row, **kwargs):
        with store.connect() as db:
            assert db.execute("PRAGMA query_only").fetchone()[0] == 1
            with pytest.raises(sqlite3.OperationalError):
                db.execute("UPDATE execution_sweep_events SET created_at=created_at")
        return original(row, **kwargs)
    monkeypatch.setattr(history, "_view", readonly)
    response = setup["client"].get(url(acct) + "?limit=1&offset=0")
    assert response.headers["cache-control"] == "no-store"
    listing = response.json()
    assert listing["pagination"] == {"limit": 1, "offset": 0, "total": 2, "returned": 1}
    assert "event" not in listing["items"][0]
    detail = setup["client"].get(url(acct) + "/" + initial[0][0]).json()
    assert detail["event"] == first_payload and detail["counts"] == {"cancel_requested": 2}
    assert detail["integrity"] == {"available": True, "reason": None}
    assert rows() == saved_rows and protected() == state and store.input_revision() == revision


def test_empty_or_legacy_summary_history_is_not_fabricated(ready):
    setup, acct, sent = ready
    with store.connect() as db:
        execution._refresh_status(db, sent["id"], {"kill_switch_sweep": {"at": "2024-01-05T00:00:00Z", "reason": "legacy", "results": []}})
    listing = setup["client"].get(url(acct)).json()
    assert listing["items"] == [] and listing["pagination"]["total"] == 0
    sweep(ready)
    count = len(rows())
    again = sweep(ready)
    assert again["nothing_to_do"] and len(rows()) == count


def test_exact_append_replay_and_conflict_never_overwrite(ready, monkeypatch):
    _, acct, sent = ready
    sweep(ready)
    before = rows()
    payload = json.loads(before[0][-1])
    receipt = {key: payload[key] for key in ("at", "reason", "results")}
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        assert history.append_event(db, acct["id"], sent["id"], receipt) == before[0][0]
    assert rows() == before
    monkeypatch.setattr(history, "_hash", lambda value: before[0][0])
    with pytest.raises(HTTPException) as error:
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            history.append_event(db, acct["id"], sent["id"], {**receipt, "reason": "different"})
    assert error.value.detail["code"] == "sweep_event_conflict" and rows() == before


@pytest.mark.parametrize("change", ["json", "content", "identity", "nonfinite", "missing_field"])
def test_corrupted_events_remain_listed_but_never_expose_valid_payload(ready, change):
    setup, acct, _ = ready
    sweep(ready)
    saved = rows()[0]
    with store.connect() as db:
        if change == "identity":
            db.execute("UPDATE execution_sweep_events SET submission_id='synthetic-other' WHERE id=?", (saved[0],))
        elif change == "json":
            db.execute("UPDATE execution_sweep_events SET payload_json='{' WHERE id=?", (saved[0],))
        else:
            payload = json.loads(saved[-1])
            if change == "content": payload["reason"] = "changed"
            if change == "nonfinite": payload["extra"] = float("nan")
            if change == "missing_field": del payload["results"][0]["action"]
            db.execute("UPDATE execution_sweep_events SET payload_json=? WHERE id=?", (json.dumps(payload), saved[0]))
    detail = setup["client"].get(url(acct) + "/" + saved[0]).json()
    listing = setup["client"].get(url(acct)).json()
    assert detail["integrity"]["available"] is False and detail["event"] is None
    assert detail["at"] is detail["reason"] is detail["counts"] is detail["results_count"] is None
    assert len(listing["items"]) == 1 and listing["items"][0]["integrity"]["available"] is False
    json.dumps(detail, allow_nan=False)


def test_cross_account_and_submission_filter_are_scoped(ready):
    setup, acct, sent = ready
    sweep(ready)
    other = account("Synthetic other account", key="synthetic-other-sweep")
    identifier = rows()[0][0]
    assert setup["client"].get(url(other) + "/" + identifier).status_code == 404
    assert setup["client"].get(url(other) + f"?submission_id={sent['id']}").status_code == 404
    filtered = setup["client"].get(url(acct) + f"?submission_id={sent['id']}").json()
    assert filtered["pagination"]["total"] == 1
    assert setup["client"].get(url(acct) + "/" + "0" * 64).status_code == 404


@pytest.mark.parametrize("query", ["limit=0", "limit=51", "limit=1.0", "limit=true", "offset=-1", "offset=5001", "offset=1.0", "submission_id=../bad"])
def test_query_bounds_and_types_are_strict(ready, query):
    setup, acct, _ = ready
    assert setup["client"].get(url(acct) + "?" + query).status_code == 422


def test_final_transaction_failure_rolls_back_all_events_and_summaries_but_does_not_replay_cancels(ready, monkeypatch):
    setup, acct, sent = ready
    prop = proposal(acct, [{"symbol": "SYNTA", "weight_pct": 10}], key="synthetic-second-proposal-history")
    second = submit(setup, acct, prop, idempotency_key="synthetic-second-submit-history").json()
    before = {identifier: summary(identifier) for identifier in (sent["id"], second["id"])}
    original = history.append_event
    calls = []
    def append_then_fail(db, account_id, submission_id, receipt):
        value = original(db, account_id, submission_id, receipt)
        calls.append(submission_id)
        if len(calls) == 2:
            raise HTTPException(409, {"code": "synthetic-publication-failure"})
        return value
    monkeypatch.setattr(history, "append_event", append_then_fail)
    response = setup["client"].post(f"/api/execution/accounts/{acct['id']}/cancel-working", json={"expected_account_version": acct["version"], "reason": "rollback"})
    assert response.status_code == 409 and len(calls) == 2 and rows() == []
    assert {identifier: summary(identifier) for identifier in before} == before
    # External fake cancellations already occurred before the final publication transaction.
    assert sum(call[0] == "DELETE" for call in setup["broker"].calls) == 3
    with store.connect() as db:
        assert {row[0] for row in db.execute("SELECT status FROM execution_orders")} == {"cancel_requested"}
    again = sweep(ready)
    assert again["nothing_to_do"] and rows() == []
    assert sum(call[0] == "DELETE" for call in setup["broker"].calls) == 3


def add_historical(ready, at, reason):
    _, acct, sent = ready
    # Reuse only the synthetic order identity; each distinct receipt is content-addressed.
    with store.connect() as db:
        order = db.execute('SELECT * FROM execution_orders WHERE submission_id=? ORDER BY id', (sent['id'],)).fetchone()
        db.execute('BEGIN IMMEDIATE')
        return history.append_event(db, acct['id'], sent['id'], {
            'at': at, 'reason': reason,
            'results': [{'order_id': order['id'], 'submission_id': sent['id'],
                         'symbol': order['symbol'], 'side': order['side'],
                         'previous_status': 'accepted', 'action': 'cancel_requested', 'error': None}],
        })


def test_verified_filters_precede_pagination_and_use_utc_inclusive_dates(ready):
    setup, acct, sent = ready
    add_historical(ready, '2026-10-01T00:00:00Z', 'manual_sweep')
    included = add_historical(ready, '2026-10-02T01:00:00+08:00', 'manual_sweep')  # October 1 UTC
    add_historical(ready, '2026-10-02T01:00:00Z', 'manual_sweep')
    add_historical(ready, '2026-10-01T18:00:00Z', 'kill_switch')
    query = '?start_date=2026-10-01&end_date=2026-10-01&reason=manual_sweep&limit=1'
    result = setup['client'].get(url(acct) + query).json()
    assert result['pagination'] == {'limit': 1, 'offset': 0, 'total': 2, 'returned': 1}
    assert result['items'][0]['id'] == included
    assert result['filters'] == {'submission_id': None, 'start_date': '2026-10-01', 'end_date': '2026-10-01', 'reason': 'manual_sweep'}
    assert result['filter_coverage']['unverifiable_excluded'] == 0
    second = setup['client'].get(url(acct) + query + '&offset=1').json()
    assert second['pagination']['total'] == 2 and second['items'][0]['id'] != included
    scoped = setup['client'].get(url(acct) + query + f'&submission_id={sent["id"]}').json()
    assert scoped['pagination']['total'] == 2
    assert setup['client'].get(url(acct) + '?reason=manual').json()['pagination']['total'] == 0


def test_filters_exclude_unverifiable_records_explicitly_without_hiding_them_from_all_history(ready):
    setup, acct, _ = ready
    valid = add_historical(ready, '2026-10-01T00:00:00Z', 'manual_sweep')
    broken = add_historical(ready, '2026-10-01T01:00:00Z', 'manual_sweep')
    with store.connect() as db:
        db.execute("UPDATE execution_sweep_events SET payload_json='{' WHERE id=?", (broken,))
    before, revision = protected(), store.input_revision()
    result = setup['client'].get(url(acct) + '?reason=manual_sweep').json()
    assert result['pagination']['total'] == 1 and result['items'][0]['id'] == valid
    assert result['filter_coverage']['unverifiable_excluded'] == 1
    unfiltered = setup['client'].get(url(acct)).json()
    assert unfiltered['pagination']['total'] == 2
    assert unfiltered['filter_coverage']['unverifiable_excluded'] is None
    assert protected() == before and store.input_revision() == revision


@pytest.mark.parametrize('query', [
    'start_date=2026-02-30', 'start_date=20261001', 'end_date=2026-1-1',
    'start_date=2026-10-02&end_date=2026-10-01', 'reason=', 'reason=%20',
    'reason=%20manual_sweep', 'reason=manual_sweep%0A', 'reason=' + 'x' * 201,
])
def test_invalid_filter_inputs_are_rejected(ready, query):
    setup, acct, _ = ready
    assert setup['client'].get(url(acct) + '?' + query).status_code == 422


def test_filter_utc_conversion_overflow_is_unavailable_not_server_error(ready):
    setup, acct, _ = ready
    add_historical(ready, '0001-01-01T00:00:00+14:00', 'manual_sweep')
    result = setup['client'].get(url(acct) + '?reason=manual_sweep')
    assert result.status_code == 200
    assert result.json()['filter_coverage']['unverifiable_excluded'] == 1


def test_batch_export_contains_all_matching_complete_saved_envelopes_and_no_writes(ready, monkeypatch):
    setup, acct, sent = ready
    first = add_historical(ready, '2026-10-01T00:00:00Z', 'manual_sweep')
    second = add_historical(ready, '2026-10-02T00:00:00Z', 'manual_sweep')
    broken = add_historical(ready, '2026-10-03T00:00:00Z', 'kill_switch')
    with store.connect() as db:
        db.execute("UPDATE execution_sweep_events SET payload_json='{' WHERE id=?", (broken,))
    before, revision = protected(), store.input_revision()
    monkeypatch.setattr(alpaca, '_request', lambda *a, **k: pytest.fail('Export must not call broker'))
    response = setup['client'].get(url(acct) + '/export')
    assert response.status_code == 200 and response.headers['cache-control'] == 'no-store'
    exported = response.json()
    assert exported['coverage'] == {'matching_events': 3, 'exported_events': 3, 'verified_events': 2,
                                   'unverifiable_events': 1, 'complete_for_filters': True,
                                   'max_events': 250, 'max_bytes': 2097152}
    assert [item['id'] for item in exported['items']] == [broken, second, first]
    assert exported['items'][0]['event'] is None
    assert exported['items'][1] == setup['client'].get(url(acct) + '/' + second).json()
    filtered = setup['client'].get(url(acct) + '/export?reason=manual_sweep').json()
    assert filtered['coverage']['matching_events'] == 2 and filtered['filter_coverage']['unverifiable_excluded'] == 1
    assert protected() == before and store.input_revision() == revision
    other = account('Synthetic export isolation', key='synthetic-export-isolation')
    assert setup['client'].get(url(other) + f'/export?submission_id={sent["id"]}').status_code == 404


def test_batch_export_bounds_refuse_partial_copies_and_allow_narrower_query(ready, monkeypatch):
    setup, acct, _ = ready
    add_historical(ready, '2026-10-01T00:00:00Z', 'manual_sweep')
    add_historical(ready, '2026-10-02T00:00:00Z', 'kill_switch')
    monkeypatch.setattr(history, 'MAX_EXPORT_EVENTS', 1)
    response = setup['client'].get(url(acct) + '/export')
    assert response.status_code == 413 and response.json()['detail']['code'] == 'sweep_export_limit'
    assert setup['client'].get(url(acct) + '/export?reason=manual_sweep').status_code == 200
    monkeypatch.setattr(history, 'MAX_EXPORT_BYTES', 100)
    response = setup['client'].get(url(acct) + '/export?reason=manual_sweep')
    assert response.status_code == 413 and response.json()['detail']['code'] == 'sweep_export_size'
