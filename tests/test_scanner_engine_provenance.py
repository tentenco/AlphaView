import json

import pytest

from alphaview.panel import changes, research, scan_context, scan_provenance, sessions, store


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "engine.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda: "2024-01-04")
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO positions(symbol,name,shares,source,updated_at) VALUES ('TEST','Synthetic',0,'test','now')")
        db.executemany("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", [("TEST", day, 100., 101., 99., 100., 100., 1000.) for day in ("2024-01-02", "2024-01-03", "2024-01-04")])


def snapshot(day, token, matched):
    row = {"symbol": "TEST", "date": day, "signals": [{"strategy": "trend", "status": "match" if matched else "watch", "matched": matched}]}
    with store.connect() as db:
        db.execute("INSERT INTO scans(created_at,as_of,universe,result,scope,input_revision) VALUES ('now',?,'[\"TEST\"]',?,'portfolio',?)", (day, json.dumps([row]), token))


def test_engine_bump_invalidates_without_any_input_or_schema_change(workspace, monkeypatch):
    research.scan()
    inputs = store.input_revision()
    before = scan_context.decorate(store.latest_scan())
    assert before["scan_engine_version"] == "alphaview-scan-v1" and before["input_status"] == "current"
    monkeypatch.setattr(scan_provenance, "SCAN_ENGINE_VERSION", "alphaview-scan-v2")
    after = scan_context.decorate(store.latest_scan())
    assert after["input_status"] == "stale" and after["input_stale"]
    assert after["scan_engine_version"] == "alphaview-scan-v1"
    assert after["current_scan_engine_version"] == "alphaview-scan-v2"
    assert store.input_revision() == inputs
    research.scan()
    assert scan_context.decorate(store.latest_scan())["input_status"] == "current"


def test_unversioned_input_only_snapshot_is_unknown(workspace):
    snapshot("2024-01-04", store.input_revision(), True)
    result = scan_context.decorate(store.latest_scan())
    assert result["input_status"] == "unknown" and result["scan_engine_version"] is None


def test_engine_change_mid_calculation_aborts_atomic_publication(workspace, monkeypatch):
    research.scan()
    identifier = store.latest_scan()["id"]
    def progress(message):
        monkeypatch.setattr(scan_provenance, "SCAN_ENGINE_VERSION", "alphaview-scan-v2")
    with pytest.raises(ValueError, match="引擎版本已變更"):
        research.scan(progress)
    assert store.latest_scan()["id"] == identifier


def test_different_engine_snapshots_never_claim_signal_entry(workspace):
    inputs = store.input_revision()
    snapshot("2024-01-03", scan_provenance.token(inputs, "alphaview-scan-v1"), False)
    snapshot("2024-01-04", scan_provenance.token(inputs, "alphaview-scan-v2"), True)
    result = changes.report("portfolio")
    assert result["provenance"]["comparison_status"] == "mismatch"
    assert result["counts"]["entered"] == 0 and result["counts"]["unavailable"] == 1


def test_same_old_engine_can_compare_but_is_labeled_historical(workspace, monkeypatch):
    token = scan_provenance.current_token()
    snapshot("2024-01-03", token, False)
    snapshot("2024-01-04", token, True)
    monkeypatch.setattr(scan_provenance, "SCAN_ENGINE_VERSION", "alphaview-scan-v2")
    result = changes.report("portfolio")
    assert result["counts"]["entered"] == 1
    assert result["provenance"]["uses_current_inputs"] is False
    assert result["provenance"]["current_snapshot_engine_version"] == "alphaview-scan-v1"


@pytest.mark.parametrize("token", [None, "", "oldtoken", "alphaview-scan-v1|wrong", "alphaview-scan-v0|" + "0" * 32 + ":1"])
def test_malformed_or_legacy_tokens_never_parse_as_current(token):
    assert scan_provenance.parse(token) is None


def test_engine_bump_changes_polling_revision_without_touching_database(workspace, monkeypatch):
    from alphaview.panel import api
    before = api.polling_status()
    db_revision = store.revision("2024-01-04")
    monkeypatch.setattr(scan_provenance, "SCAN_ENGINE_VERSION", "alphaview-scan-v2")
    after = api.polling_status()
    assert before["revision"] != after["revision"]
    assert before["jobs_revision"] == after["jobs_revision"]
    assert store.revision("2024-01-04") == db_revision
    assert api.overview()["revision"] == after["revision"]


def test_backtest_only_engine_bump_also_refreshes_polling_clients(workspace, monkeypatch):
    from alphaview.panel import api
    before = api.polling_status()
    scanner_token = scan_provenance.current_token()
    monkeypatch.setattr(research, "BACKTEST_ENGINE_VERSION", "alphaview-backtest-next-test")
    assert api.polling_status()["revision"] != before["revision"]
    assert scan_provenance.current_token() == scanner_token
