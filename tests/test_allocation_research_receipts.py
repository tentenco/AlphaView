"""Synthetic immutable research receipts: reconstruction, publication races and historical reads."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import sqlite3

import pytest

from alphaview.panel import allocation_research as research, allocation_research_receipts as receipts, paper_portfolio as paper, store, sessions
from tests.test_allocation_research import workspace, saved, compare, body, state, DAYS  # noqa: F401


@pytest.fixture
def setup(workspace):
    workspace.app.include_router(receipts.router)
    account = paper.create_account(paper.AccountInput(name="Synthetic receipt account", initial_cash=10000, idempotency_key="synthetic-receipt-account"))["account"]
    run = saved(workspace)
    evidence = compare(workspace, run)
    return workspace, account, run, evidence


def request(setup, **changes):
    _, account, run, evidence = setup
    return {**body(run), "run_id": run["id"], "expected_account_version": account["version"],
            "expected_evidence_fingerprint": evidence["evidence_fingerprint"], **changes}


def url(setup):
    return f"/api/paper/accounts/{setup[1]['id']}/allocation-research-receipts"


def save(setup, **changes):
    response = setup[0].post(url(setup), json=request(setup, **changes))
    assert response.status_code == 200, response.text
    json.dumps(response.json(), allow_nan=False)
    return response.json()


def rows():
    with store.connect() as db:
        return [tuple(row) for row in db.execute("SELECT * FROM allocation_research_receipts ORDER BY id")]


def test_server_rebuilds_exact_evidence_and_reads_do_not_recalculate_or_write(setup, monkeypatch):
    before = state()
    value = save(setup)
    assert value["replayed"] is False and value["integrity"] == {"available": True, "reason": None}
    assert value["currentness"] == {"current": True, "reasons": []}
    assert value["receipt"]["evidence"] == setup[3]
    assert value["receipt"]["account_context"]["version"] == setup[1]["version"]
    assert value["receipt"]["source_context"]["account_binding"] == "review_association_only"
    assert state() == before and len(rows()) == 1
    saved_rows = rows()
    monkeypatch.setattr(research, "compare_allocations", lambda *a: pytest.fail("Historical reads must not recalculate"))
    original = receipts._view
    def read_only(db, *args, **kwargs):
        assert db.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM allocation_research_receipts")
        return original(db, *args, **kwargs)
    monkeypatch.setattr(receipts, "_view", read_only)
    history = setup[0].get(url(setup)).json()
    assert history["pagination"] == {"limit": 20, "offset": 0, "total": 1, "returned": 1}
    assert "receipt" not in history["items"][0]
    detail = setup[0].get(f"{url(setup)}/{value['id']}")
    assert detail.headers["cache-control"] == "no-store"
    assert detail.json()["receipt"] == value["receipt"]
    assert rows() == saved_rows and state() == before


def test_identical_request_replays_immutable_values_even_after_context_and_methods_change(setup, monkeypatch):
    original = save(setup)
    with store.connect() as db:
        db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[1]["id"],))
        db.execute("UPDATE bars SET adj_close=adj_close+1 WHERE date=?", (DAYS[-1],))
    monkeypatch.setattr(research, "ENGINE_VERSION", "synthetic-future-method")
    monkeypatch.setattr(research, "compare_allocations", lambda *a: pytest.fail("Replay must not recalculate"))
    replay = save(setup)
    assert replay["replayed"] is True
    assert replay["id"] == original["id"] and replay["receipt"] == original["receipt"]
    assert replay["content_fingerprint"] == original["content_fingerprint"]
    assert set(replay["currentness"]["reasons"]) == {"account_context_changed", "inputs_changed", "research_method_changed"}
    assert len(rows()) == 1


@pytest.mark.parametrize("change", [
    {"expected_evidence_fingerprint": "0" * 64}, {"expected_proposal_fingerprint": "0" * 64},
    {"expected_account_version": 999}, {"expected_input_revision": "synthetic:changed"},
    {"expected_as_of": "2024-01-01"},
])
def test_forged_or_stale_identity_cannot_publish(setup, change):
    response = setup[0].post(url(setup), json=request(setup, **change))
    assert response.status_code == 409
    assert rows() == []


@pytest.mark.parametrize("change", [{"result": {}}, {"lookback_sessions": 20.5}, {"expected_account_version": True},
                                         {"lookback_sessions": float("inf")}, {"expected_account_version": float("nan")},
                                         {"result": {"forged": float("inf")}}, {"expected_evidence_fingerprint": "invalid"}])
def test_strict_input_never_accepts_client_results(setup, change):
    response = setup[0].post(url(setup), content=json.dumps(request(setup, **change)), headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and rows() == []
    json.dumps(response.json(), allow_nan=False)
    assert all("input" not in error for error in response.json()["detail"])


@pytest.mark.parametrize("change", ["account", "policy", "limits", "run", "bars", "session", "method"])
def test_post_snapshot_cas_refuses_any_source_or_context_race(setup, monkeypatch, change):
    original = store.read_snapshot
    depth = 0
    fired = False
    @contextmanager
    def snapshot_then_change():
        nonlocal depth, fired
        depth += 1
        try:
            with original():
                yield
        finally:
            depth -= 1
        if depth == 0 and not fired:
            fired = True
            with store.connect() as db:
                if change == "account": db.execute("UPDATE paper_accounts SET version=version+1 WHERE id=?", (setup[1]["id"],))
                if change == "policy":
                    policy = json.loads(db.execute("SELECT symbol_policy_json FROM paper_accounts WHERE id=?", (setup[1]["id"],)).fetchone()[0])
                    policy["version"] += 1
                    db.execute("UPDATE paper_accounts SET symbol_policy_json=? WHERE id=?", (json.dumps(policy), setup[1]["id"]))
                if change == "limits": db.execute("UPDATE paper_accounts SET limits_json=? WHERE id=?", (json.dumps({"max_position_weight_pct": 1}), setup[1]["id"]))
                if change == "run":
                    result = json.loads(db.execute("SELECT result FROM portfolio_agent_runs WHERE id=?", (setup[2]["id"],)).fetchone()[0])
                    result["method"] = "Synthetic changed saved record"
                    db.execute("UPDATE portfolio_agent_runs SET result=? WHERE id=?", (json.dumps(result), setup[2]["id"]))
                if change == "bars": db.execute("UPDATE bars SET adj_close=adj_close+1 WHERE date=?", (DAYS[-1],))
            if change == "session": monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2099-01-01")
            if change == "method": monkeypatch.setattr(research, "ENGINE_VERSION", "synthetic-changed")
    monkeypatch.setattr(store, "read_snapshot", snapshot_then_change)
    response = setup[0].post(url(setup), json=request(setup))
    assert fired and response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "receipt_context_changed"
    assert rows() == []


def test_unavailable_evidence_is_saved_with_nulls_and_never_filled_in(setup):
    client, account, _, _ = setup
    with store.connect() as db:
        db.execute("DELETE FROM bars WHERE date=?", (DAYS[-2],))
    # A fresh trusted saved scan/run after the synthetic input mutation.
    from tests.test_portfolio_agent import seed_scan, scan_row, SYMBOLS
    seed_scan(rows=[scan_row(symbol) for symbol in SYMBOLS])
    run = saved(client)
    evidence = compare(client, run)
    assert evidence["status"] == "unavailable"
    value = save((client, account, run, evidence))
    assert value["receipt"]["evidence"] == evidence
    assert value["receipt"]["evidence"]["covariance_annualized"] is None
    assert value["receipt"]["evidence"]["methods"]["rank_sum"]["cash_after_pct"] is None


def test_capacity_refuses_without_deletion_but_allows_replay(setup, monkeypatch):
    assert (receipts.MAX_ACCOUNT, receipts.MAX_TOTAL, receipts.MAX_BYTES) == (50, 500, 262144)
    original = save(setup)
    before = rows()
    other_evidence = compare(setup[0], setup[2], lookback_sessions=21)
    for cap in ("MAX_ACCOUNT", "MAX_TOTAL"):
        with monkeypatch.context() as scope:
            scope.setattr(receipts, cap, 1)
            response = setup[0].post(url(setup), json=request(setup, lookback_sessions=21, expected_evidence_fingerprint=other_evidence["evidence_fingerprint"]))
            assert response.status_code == 409 and response.json()["detail"]["code"] == "receipt_capacity"
            assert save(setup)["id"] == original["id"]
            assert rows() == before


def test_size_refusal_and_database_bound_preserve_original_data(setup, monkeypatch):
    monkeypatch.setattr(receipts, "MAX_BYTES", 10)
    response = setup[0].post(url(setup), json=request(setup))
    assert response.status_code == 422 and response.json()["detail"]["code"] == "receipt_size_limit"
    assert rows() == []
    with store.connect() as db, pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO allocation_research_receipts VALUES ('x','x','x','x','x','{}','x',?)", ("x" * 262145,))


@pytest.mark.parametrize("damage", ["json", "blob", "hash", "evidence", "request"])
def test_damaged_receipts_stay_visible_but_unverifiable_results_are_not_returned(setup, damage):
    value = save(setup)
    with store.connect() as db:
        if damage == "json": db.execute("UPDATE allocation_research_receipts SET payload_json='broken' WHERE id=?", (value["id"],))
        elif damage == "blob": db.execute("UPDATE allocation_research_receipts SET payload_json=? WHERE id=?", (b"broken", value["id"]))
        elif damage == "hash": db.execute("UPDATE allocation_research_receipts SET content_fingerprint=? WHERE id=?", ("0" * 64, value["id"]))
        elif damage == "request": db.execute("UPDATE allocation_research_receipts SET request_json='[]' WHERE id=?", (value["id"],))
        else:
            payload = value["receipt"]
            payload["evidence"]["invested_budget_pct"] = 999
            db.execute("UPDATE allocation_research_receipts SET payload_json=?,content_fingerprint=? WHERE id=?", (receipts._json(payload), receipts._hash(payload), value["id"]))
    detail = setup[0].get(f"{url(setup)}/{value['id']}").json()
    assert detail["receipt"] is None and detail["integrity"]["available"] is False
    assert detail["currentness"]["current"] is None
    assert setup[0].get(url(setup)).json()["pagination"]["total"] == 1


def test_account_scope_and_pagination_and_concurrent_dedup(setup):
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: setup[0].post(url(setup), json=request(setup)), range(2)))
    assert [response.status_code for response in outcomes] == [200, 200]
    values = [response.json() for response in outcomes]
    assert values[0]["id"] == values[1]["id"] and sorted(value["replayed"] for value in values) == [False, True]
    assert len(rows()) == 1
    other = paper.create_account(paper.AccountInput(name="Synthetic other", initial_cash=10000, idempotency_key="synthetic-other-receipt-account"))["account"]
    assert setup[0].get(f"/api/paper/accounts/{other['id']}/allocation-research-receipts/{values[0]['id']}").status_code == 404
    empty = setup[0].get(url(setup) + "?limit=1&offset=1").json()
    assert empty["items"] == [] and empty["pagination"]["total"] == 1
    assert setup[0].get(url(setup) + "?limit=21").status_code == 422
    assert setup[0].get(url(setup) + "?offset=501").status_code == 422


def test_bound_workflow_cannot_be_associated_with_another_account(setup):
    client, account, original_run, _ = setup
    response = client.post('/api/portfolio-agent/runs', json={**original_run['request'],
        'account_context': {'account_id': account['id'], 'expected_policy_version': account['symbol_policy']['version']}})
    assert response.status_code == 201, response.text
    run = response.json()
    evidence = compare(client, run)
    bound = (client, account, run, evidence)
    value = save(bound)
    assert value['receipt']['source_context']['account_binding'] == 'workflow_bound'
    other = paper.create_account(paper.AccountInput(name='Synthetic unrelated account', initial_cash=10000,
        idempotency_key='synthetic-unrelated-receipt-account'))['account']
    unrelated = (client, other, run, evidence)
    before = rows()
    response = client.post(url(unrelated), json=request(unrelated))
    assert response.status_code == 409 and rows() == before


@pytest.fixture
def receipt_pair(setup):
    baseline = save(setup)
    other_run = saved(setup[0], max_position_weight_pct=30)
    selected = save((setup[0], setup[1], other_run, compare(setup[0], other_run)))
    return setup, baseline, selected


def comparison_body(baseline, selected):
    return {'baseline_id': baseline['id'], 'selected_id': selected['id'],
            'expected_baseline_content_fingerprint': baseline['content_fingerprint'],
            'expected_selected_content_fingerprint': selected['content_fingerprint']}


def compare_saved(receipt_pair, **changes):
    setup, baseline, selected = receipt_pair
    return setup[0].post(url(setup) + '/compare', json={**comparison_body(baseline, selected), **changes})


def historical_value(setup, value, change):
    """Construct a signed-by-content synthetic historical variant, never via client input."""
    with store.connect() as db:
        row = receipts._lookup(db, setup[1]['id'], value['id'])
        payload, request_value = json.loads(row['payload_json']), json.loads(row['request_json'])
        change(payload['evidence'])
        payload['evidence'].pop('evidence_fingerprint')
        payload['evidence']['evidence_fingerprint'] = receipts._hash(payload['evidence'])
        request_value['request']['expected_evidence_fingerprint'] = payload['evidence']['evidence_fingerprint']
        identifier = receipts._hash(request_value)
        db.execute('UPDATE allocation_research_receipts SET id=?,payload_json=?,request_json=?,content_fingerprint=? WHERE id=?',
                   (identifier, receipts._json(payload), receipts._json(request_value), receipts._hash(payload), value['id']))
    return setup[0].get(url(setup) + '/' + identifier).json()


def test_receipt_comparison_reads_exact_saved_values_without_recomputation_or_writes(receipt_pair, monkeypatch):
    setup, baseline, selected = receipt_pair
    before = state(), rows()
    monkeypatch.setattr(research, 'compare_allocations', lambda *a: pytest.fail('Historical comparison must not recompute'))
    original = receipts._view
    def read_only(db, *args, **kwargs):
        assert db.execute('PRAGMA query_only').fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError): db.execute('DELETE FROM allocation_research_receipts')
        return original(db, *args, **kwargs)
    monkeypatch.setattr(receipts, '_view', read_only)
    response = compare_saved(receipt_pair)
    assert response.status_code == 200, response.text
    result = response.json()
    assert response.headers['cache-control'] == 'no-store'
    assert result['engine_version'] == receipts.COMPARISON_VERSION
    assert result['comparability'] == {'compatible': True, 'reasons': []}
    assert result['baseline']['id'] == baseline['id'] and result['selected']['id'] == selected['id']
    rank = result['methods']['rank_sum']
    assert rank['totals']['cash_after_pct'] == {'baseline': 15, 'selected': 25, 'delta': 10, 'reason': None}
    assert rank['symbols'][0]['capped_weight_pct'] == {'baseline': 40, 'selected': 30, 'delta': -10, 'reason': None}
    assert rank['symbols'][0]['raw_weight_pct']['delta'] == 0
    assert compare_saved(receipt_pair).json() == result
    assert (state(), rows()) == before
    json.dumps(result, allow_nan=False)


def test_old_stale_receipt_values_remain_comparable_with_read_time_currentness(receipt_pair, monkeypatch):
    original = compare_saved(receipt_pair).json()
    with store.connect() as db:
        db.execute('UPDATE bars SET adj_close=adj_close+1 WHERE date=?', (DAYS[-1],))
        db.execute('UPDATE paper_accounts SET version=version+1 WHERE id=?', (receipt_pair[0][1]['id'],))
    monkeypatch.setattr(research, 'compare_allocations', lambda *a: pytest.fail('Do not rebuild stale receipts'))
    result = compare_saved(receipt_pair).json()
    assert result['methods'] == original['methods']
    for name in ('baseline', 'selected'):
        assert result[name]['currentness']['current'] is False
        assert set(result[name]['currentness']['reasons']) == {'inputs_changed', 'account_context_changed'}
        assert result[name]['as_of'] == original[name]['as_of']


@pytest.mark.parametrize('change,reason', [('method', 'research_method_incompatible'), ('coverage', 'coverage_incomplete'), ('symbols', 'selected_symbols_changed')])
def test_incompatible_receipts_show_saved_values_but_never_numeric_deltas(receipt_pair, change, reason):
    setup, baseline, selected = receipt_pair
    def mutate(evidence):
        if change == 'method': evidence['engine_version'] = 'synthetic-unknown-research-v9'
        if change == 'coverage': evidence['coverage']['valid_closes'] -= 1
        if change == 'symbols': evidence['selected_symbols'] = evidence['selected_symbols'][:-1]
    selected = historical_value(setup, selected, mutate)
    result = compare_saved((setup, baseline, selected)).json()
    assert result['comparability']['compatible'] is False and reason in result['comparability']['reasons']
    for method in result['methods'].values():
        assert method['comparable'] is False
        assert all(value['delta'] is None for value in method['totals'].values())
        assert all(value['delta'] is None for row in method['symbols'] for key, value in row.items() if key != 'symbol')
    assert result['methods']['rank_sum']['totals']['cash_after_pct']['selected'] == 25


def test_different_lookbacks_keep_original_values_and_explicitly_withhold_deltas(receipt_pair):
    setup, baseline, _ = receipt_pair
    evidence = compare(setup[0], setup[2], lookback_sessions=21)
    selected = save((setup[0], setup[1], setup[2], evidence), lookback_sessions=21)
    result = compare_saved((setup, baseline, selected)).json()
    assert result['baseline']['lookback_sessions'] == 20 and result['selected']['lookback_sessions'] == 21
    assert result['comparability'] == {'compatible': False, 'reasons': ['lookback_changed']}
    assert result['methods']['rank_sum']['totals']['cash_after_pct']['delta'] is None


def test_nulls_zeroes_and_signed_risk_contributions_are_not_coerced_or_filled(receipt_pair):
    setup, baseline, selected = receipt_pair
    def before(evidence):
        evidence['methods']['rank_sum']['risk_after']['contributions_annualized_pct'][0] = -3.5
    def after(evidence):
        evidence['methods']['rank_sum']['cash_after_pct'] = None
        evidence['methods']['rank_sum']['risk_after']['contributions_annualized_pct'][0] = -5
        evidence['methods']['rank_sum']['weights'][0]['raw_weight_pct'] = 0
    baseline = historical_value(setup, baseline, before)
    selected = historical_value(setup, selected, after)
    result = compare_saved((setup, baseline, selected)).json()['methods']['rank_sum']
    assert result['totals']['cash_after_pct'] == {'baseline': 15, 'selected': None, 'delta': None, 'reason': 'value_unavailable'}
    assert result['symbols'][0]['risk_after_contributions_annualized_pct'] == {'baseline': -3.5, 'selected': -5, 'delta': -1.5, 'reason': None}
    assert result['symbols'][0]['raw_weight_pct'] == {'baseline': 45, 'selected': 0, 'delta': -45, 'reason': None}


@pytest.mark.parametrize('fault', ['same', 'missing', 'fingerprint', 'corrupt', 'cross_account', 'extra'])
def test_comparison_rejects_wrong_identity_and_unverified_payloads(receipt_pair, fault):
    setup, baseline, selected = receipt_pair
    changes = {}
    expected = 409
    if fault == 'same': changes = {'selected_id': baseline['id']}; expected = 422
    if fault == 'missing': changes = {'selected_id': '0' * 64}; expected = 404
    if fault == 'fingerprint': changes = {'expected_selected_content_fingerprint': '0' * 64}
    if fault == 'corrupt':
        with store.connect() as db: db.execute("UPDATE allocation_research_receipts SET payload_json='broken' WHERE id=?", (selected['id'],))
    if fault == 'cross_account':
        with store.connect() as db: db.execute("UPDATE allocation_research_receipts SET account_id='synthetic-unrelated' WHERE id=?", (selected['id'],))
        expected = 404
    if fault == 'extra': changes = {'result': {'cash': 0}}; expected = 422
    before = state(), rows()
    response = compare_saved(receipt_pair, **changes)
    assert response.status_code == expected, response.text
    assert (state(), rows()) == before


@pytest.mark.parametrize('malformed', ['symbol_object', 'duplicate_symbol', 'methods_list', 'scenario_string', 'risk_list', 'weights_string', 'coverage_symbol_object', 'risk_array_string'])
def test_checksum_valid_unsupported_shapes_remain_historically_readable_but_comparison_rejects(receipt_pair, malformed):
    setup, baseline, selected = receipt_pair
    def mutate(evidence):
        evidence['engine_version'] = 'synthetic-future-version'
        if malformed == 'symbol_object': evidence['selected_symbols'][0] = {'symbol': 'SYNTA'}
        if malformed == 'duplicate_symbol': evidence['selected_symbols'][0] = evidence['selected_symbols'][1]
        if malformed == 'methods_list': evidence['methods'] = []
        if malformed == 'scenario_string': evidence['methods']['rank_sum'] = 'unsupported'
        if malformed == 'risk_list': evidence['methods']['rank_sum']['risk_after'] = []
        if malformed == 'weights_string': evidence['methods']['rank_sum']['weights'] = 'unsupported'
        if malformed == 'coverage_symbol_object': evidence['coverage']['per_symbol'][0]['symbol'] = {'symbol': 'SYNTA'}
        if malformed == 'risk_array_string': evidence['methods']['rank_sum']['risk_after']['risk_shares_pct'] = 'unsupported'
    selected = historical_value(setup, selected, mutate)
    assert selected['integrity']['available'] is True
    assert selected['receipt']['evidence']['engine_version'] == 'synthetic-future-version'
    response = compare_saved((setup, baseline, selected))
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'receipt_comparison_shape_unavailable'
    assert setup[0].get(url(setup) + '/' + selected['id']).json()['receipt'] == selected['receipt']


def test_comparison_numeric_boundary_never_publishes_nonfinite_or_coerced_values():
    assert receipts._change(-1e308, 1e308) == {'baseline': -1e308, 'selected': 1e308, 'delta': None, 'reason': 'delta_nonfinite'}
    for value in (True, '1', float('inf'), float('nan'), 10**400):
        result = receipts._change(value, 1)
        assert result['baseline'] is None and result['delta'] is None and result['reason'] == 'value_unavailable'
        json.dumps(result, allow_nan=False)


def test_comparison_aligns_risk_arrays_by_saved_symbol_order_not_table_position(receipt_pair):
    setup, baseline, selected = receipt_pair
    expected = compare_saved(receipt_pair).json()['methods']
    def permute(evidence):
        evidence['selected_symbols'].reverse()
        for method in evidence['methods'].values():
            method['weights'].reverse()
            for phase in ('risk_before', 'risk_after'):
                for field in ('contributions_annualized_pct', 'risk_shares_pct'):
                    method[phase][field].reverse()
    selected = historical_value(setup, selected, permute)
    actual = compare_saved((setup, baseline, selected)).json()
    assert actual['comparability']['compatible'] is True
    assert actual['methods'] == expected


def test_missing_or_unavailable_risk_fields_preserve_null_deltas(receipt_pair):
    setup, baseline, selected = receipt_pair
    def mutate(evidence):
        evidence['methods']['rank_sum']['risk_after']['risk_shares_pct'] = [1]
        evidence['methods']['equal_risk_contribution']['status'] = 'unavailable'
    selected = historical_value(setup, selected, mutate)
    value = compare_saved((setup, baseline, selected)).json()
    assert value['comparability']['compatible'] is True
    for row in value['methods']['rank_sum']['symbols']:
        assert row['risk_after_risk_shares_pct']['selected'] is None
        assert row['risk_after_risk_shares_pct']['delta'] is None
        assert row['risk_after_risk_shares_pct']['reason'] == 'value_unavailable'
    assert value['methods']['equal_risk_contribution']['comparable'] is False
    assert value['methods']['equal_risk_contribution']['reasons'] == ['method_unavailable']
    assert all(metric['delta'] is None for metric in value['methods']['equal_risk_contribution']['totals'].values())
