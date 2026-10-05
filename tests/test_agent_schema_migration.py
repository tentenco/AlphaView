"""Trusted source-only historical schema migration, without any user database."""
import hashlib
import json
from pathlib import Path
import sqlite3

from alphaview.panel import backup_preflight, store

PRIOR_SIGNATURE = '8a1f5650abe50f8d7df39196c8797646795777169cb33e4612cdde0ee64d1ad4'
CURRENT_SIGNATURE = 'e0421409f585846e07e71027e17b2383e0dbabf469cd3920d3176e1ee6efdb5e'
PREVIOUS_EXECUTION_STUDY_SIGNATURE = '248d5b9375fc6f1af5dac6798de45bb4f952857add4d9f6e70a87fb774c70393'
PREVIOUS_PATH_RECEIPT_SIGNATURE = '64f9858587f7c7d8f18a86987ac16749d780f6bf018ae97f50b01cde2afd78de'
PREVIOUS_LOCAL_REVIEW_SIGNATURE = '4ff5095a0e505f6415dcdb4f57edebfc215beaa669fd922e67da323949154d76'
PREVIOUS_PREFIX_RECEIPT_SIGNATURE = '4e1f1eee546a88e99bfe65455c11516ab8b129d2e84bacd4c0c332f05895675b'
PREVIOUS_SWEEP_HISTORY_SIGNATURE = 'b7a7add8694ff79cbbd4da5b08b9b5e9d1515d25ffdc099b6967e5e23720162f'
PREVIOUS_RESEARCH_RECEIPT_SIGNATURE = '2518cbb3858f0342cea88fff807ee653ca4c9ce1ee1d2bfe11cfc109c7599db6'
PREVIOUS_CORPORATE_SIGNATURE = '78316155e8535270d39eda6333e6ed99164367298f4744cf1648a1ee2974a76b'
PREVIOUS_RECEIPT_SIGNATURE = 'bd3cdc172e3e2811d65984e85f2da25bb62b3e635b948fa5aa76fc88a904b919'
PREVIOUS_INBOX_SIGNATURE = '9f8db7b3b459ab3fde58554fc8c781678d16eda6e2977b14d6d25da01db2ca1c'


def schema_digest(path):
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
    return hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def test_prior_agent_schema_upgrades_to_fresh_schema_and_retains_identity(tmp_path, monkeypatch):
    old = tmp_path / 'old-synthetic.db'
    fixture = Path(__file__).parent / 'fixtures/agent-portfolio-schema-2026-09-20.sql'
    with sqlite3.connect(old) as db:
        db.executescript(fixture.read_text())
        db.execute("INSERT INTO panel_revisions(id,identity,data_revision,job_revision,inputs_revision) VALUES(1,'synthetic-identity',7,8,9)")
    assert schema_digest(old) == PRIOR_SIGNATURE
    assert backup_preflight.KNOWN_SCHEMAS[PRIOR_SIGNATURE] == 'migration_required'
    monkeypatch.setenv('PANEL_DB_PATH', str(old))
    store.init_db()
    assert schema_digest(old) == CURRENT_SIGNATURE
    assert store.input_revision() == 'synthetic-identity:9'
    with store.connect() as db:
        row = db.execute('SELECT * FROM panel_revisions').fetchone()
        assert (row['data_revision'], row['job_revision']) == (7, 8)
        assert db.execute('SELECT COUNT(*) FROM paper_symbol_policy_history').fetchone()[0] == 0
    store.init_db()
    assert schema_digest(old) == CURRENT_SIGNATURE
    assert store.input_revision() == 'synthetic-identity:9'
    fresh = tmp_path / 'fresh-synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(fresh))
    store.init_db()
    assert schema_digest(fresh) == schema_digest(old)
    assert backup_preflight.KNOWN_SCHEMAS[CURRENT_SIGNATURE] == 'current'


def test_previous_trading_schema_adds_inbox_receipts_without_changing_inputs(tmp_path, monkeypatch):
    database = tmp_path / 'previous-trading-synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(database))
    store.init_db()
    revision = store.input_revision()
    with store.connect() as db:
        db.execute('DROP TABLE execution_study_receipts')
        db.execute('DROP TABLE workflow_path_receipts')
        db.execute('DROP TABLE local_agent_review_events')
        db.execute('DROP TABLE research_integrity_receipts')
        db.execute('DROP TABLE execution_sweep_events')
        db.execute('DROP TABLE allocation_research_receipts')
        db.execute('DROP TABLE corporate_action_coverage')
        db.execute('DROP TABLE corporate_action_evidence')
        db.execute('DROP TABLE broker_reconciliation_receipts')
        db.execute('DROP TABLE inbox_attention_receipts')
    assert schema_digest(database) == PREVIOUS_INBOX_SIGNATURE
    assert backup_preflight.KNOWN_SCHEMAS[PREVIOUS_INBOX_SIGNATURE] == 'migration_required'
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM inbox_attention_receipts').fetchone()[0] == 0
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision


def test_previous_inbox_schema_adds_broker_receipt_without_changing_inputs(tmp_path, monkeypatch):
    database = tmp_path / 'previous-inbox-synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(database))
    store.init_db()
    revision = store.input_revision()
    with store.connect() as db:
        db.execute('DROP TABLE execution_study_receipts')
        db.execute('DROP TABLE workflow_path_receipts')
        db.execute('DROP TABLE local_agent_review_events')
        db.execute('DROP TABLE research_integrity_receipts')
        db.execute('DROP TABLE execution_sweep_events')
        db.execute('DROP TABLE allocation_research_receipts')
        db.execute('DROP TABLE corporate_action_coverage')
        db.execute('DROP TABLE corporate_action_evidence')
        db.execute('DROP TABLE broker_reconciliation_receipts')
    assert schema_digest(database) == PREVIOUS_RECEIPT_SIGNATURE
    assert backup_preflight.KNOWN_SCHEMAS[PREVIOUS_RECEIPT_SIGNATURE] == 'migration_required'
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM broker_reconciliation_receipts').fetchone()[0] == 0
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision


def test_previous_receipt_schema_adds_corporate_evidence_without_changing_inputs(tmp_path, monkeypatch):
    database = tmp_path / 'previous-receipt-synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(database))
    store.init_db()
    revision = store.input_revision()
    with store.connect() as db:
        db.execute('DROP TABLE execution_study_receipts')
        db.execute('DROP TABLE workflow_path_receipts')
        db.execute('DROP TABLE local_agent_review_events')
        db.execute('DROP TABLE research_integrity_receipts')
        db.execute('DROP TABLE execution_sweep_events')
        db.execute('DROP TABLE allocation_research_receipts')
        db.execute('DROP TABLE corporate_action_coverage')
        db.execute('DROP TABLE corporate_action_evidence')
    assert schema_digest(database) == PREVIOUS_CORPORATE_SIGNATURE
    assert backup_preflight.KNOWN_SCHEMAS[PREVIOUS_CORPORATE_SIGNATURE] == 'migration_required'
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM corporate_action_evidence').fetchone()[0] == 0
        assert db.execute('SELECT COUNT(*) FROM corporate_action_coverage').fetchone()[0] == 0
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision


def test_previous_corporate_schema_adds_research_receipts_without_changing_inputs(tmp_path, monkeypatch):
    database = tmp_path / 'previous-corporate-synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(database))
    store.init_db()
    revision = store.input_revision()
    with store.connect() as db:
        db.execute('DROP TABLE execution_study_receipts')
        db.execute('DROP TABLE workflow_path_receipts')
        db.execute('DROP TABLE local_agent_review_events')
        db.execute('DROP TABLE research_integrity_receipts')
        db.execute('DROP TABLE execution_sweep_events')
        db.execute('DROP TABLE allocation_research_receipts')
    assert schema_digest(database) == PREVIOUS_RESEARCH_RECEIPT_SIGNATURE
    assert backup_preflight.KNOWN_SCHEMAS[PREVIOUS_RESEARCH_RECEIPT_SIGNATURE] == 'migration_required'
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM allocation_research_receipts').fetchone()[0] == 0
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision


def test_previous_research_receipt_schema_adds_sweep_history_without_changing_inputs(tmp_path, monkeypatch):
    database = tmp_path / 'previous-research-receipt-synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(database))
    store.init_db()
    revision = store.input_revision()
    with store.connect() as db:
        db.execute('DROP TABLE execution_study_receipts')
        db.execute('DROP TABLE workflow_path_receipts')
        db.execute('DROP TABLE local_agent_review_events')
        db.execute('DROP TABLE research_integrity_receipts')
        db.execute('DROP TABLE execution_sweep_events')
    assert schema_digest(database) == PREVIOUS_SWEEP_HISTORY_SIGNATURE
    assert backup_preflight.KNOWN_SCHEMAS[PREVIOUS_SWEEP_HISTORY_SIGNATURE] == 'migration_required'
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM execution_sweep_events').fetchone()[0] == 0
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision


def test_previous_sweep_schema_adds_prefix_receipts_without_changing_inputs(tmp_path, monkeypatch):
    database = tmp_path / 'previous-prefix-receipt-synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(database))
    store.init_db()
    revision = store.input_revision()
    with store.connect() as db:
        db.execute('DROP TABLE execution_study_receipts')
        db.execute('DROP TABLE workflow_path_receipts')
        db.execute('DROP TABLE local_agent_review_events')
        db.execute('DROP TABLE research_integrity_receipts')
    assert schema_digest(database) == PREVIOUS_PREFIX_RECEIPT_SIGNATURE
    assert backup_preflight.KNOWN_SCHEMAS[PREVIOUS_PREFIX_RECEIPT_SIGNATURE] == 'migration_required'
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM research_integrity_receipts').fetchone()[0] == 0
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision


def test_previous_prefix_schema_adds_local_review_events_without_changing_inputs(tmp_path, monkeypatch):
    database = tmp_path / 'previous-local-review-synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(database))
    store.init_db()
    revision = store.input_revision()
    with store.connect() as db:
        db.execute('DROP TABLE execution_study_receipts')
        db.execute('DROP TABLE workflow_path_receipts')
        db.execute('DROP TABLE local_agent_review_events')
    assert schema_digest(database) == PREVIOUS_LOCAL_REVIEW_SIGNATURE
    assert backup_preflight.KNOWN_SCHEMAS[PREVIOUS_LOCAL_REVIEW_SIGNATURE] == 'migration_required'
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM local_agent_review_events').fetchone()[0] == 0
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision


def test_previous_local_review_schema_adds_path_receipts_without_changing_inputs(tmp_path, monkeypatch):
    database = tmp_path / 'previous-path-receipts-synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(database))
    store.init_db()
    revision = store.input_revision()
    with store.connect() as db:
        db.execute('DROP TABLE execution_study_receipts')
        db.execute('DROP TABLE workflow_path_receipts')
    assert schema_digest(database) == PREVIOUS_PATH_RECEIPT_SIGNATURE
    assert backup_preflight.KNOWN_SCHEMAS[PREVIOUS_PATH_RECEIPT_SIGNATURE] == 'migration_required'
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM workflow_path_receipts').fetchone()[0] == 0
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision


def test_previous_path_schema_adds_execution_study_receipts_without_changing_inputs(tmp_path, monkeypatch):
    database = tmp_path / 'previous-execution-study-synthetic.db'
    monkeypatch.setenv('PANEL_DB_PATH', str(database))
    store.init_db()
    revision = store.input_revision()
    with store.connect() as db:
        db.execute('DROP TABLE execution_study_receipts')
    assert schema_digest(database) == PREVIOUS_EXECUTION_STUDY_SIGNATURE
    assert backup_preflight.KNOWN_SCHEMAS[PREVIOUS_EXECUTION_STUDY_SIGNATURE] == 'migration_required'
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM execution_study_receipts').fetchone()[0] == 0
    store.init_db()
    assert schema_digest(database) == CURRENT_SIGNATURE
    assert store.input_revision() == revision
