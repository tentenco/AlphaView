"""Populated pre-policy source receipts, not generated through the current engine.

Frozen solely from the three pre-policy Python sources in the 2026-09-29
source-only checkpoint, using the trusted 2026-09-20 SQL schema and synthetic
SYNTH quotes/accounts. No user database, positions, notes or credentials were read.
The source SHA-256 values below document the producer; tests only need the checked-in
schema plus these literal synthetic receipts, never gitignored Harness artifacts.
"""
import hashlib
import json
from pathlib import Path
import sqlite3

import pandas as pd
import pytest

from alphaview.panel import paper_forks as forks, paper_next_open as next_open, paper_portfolio as paper, sessions, store


def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_canonical(value).encode()).hexdigest()

SOURCE_SHA256 = {'paper_forks': '656c95812c648888cd000fa902230d0afbaa8588accfee96f61297b524337132',
 'paper_next_open': '2e124682b4d2958be559e1ccebd06f5e155652c30a9805db0c2e94cede90e0e6',
 'paper_portfolio': '49e3dac764e40d4595381f71203afbd6f98f187c050d05bddc6f25649b024316'}

LEGACY_METHOD = ('獨立 USD 虛擬帳戶；目標權重以模擬前完整淨值為分母，未指定標的目標為 0%，剩餘權重保留現金，缺價不重分配。僅用最新已完成 XNYS '
 '交易日的本機未調整收盤價，接受提案後按該參考價加不利滑價模擬，不是次日開盤、即時行情或券商成交。下單股數按設定 0–6 位小數向零截斷，金額取 8 '
 '位；低於最小交易金額的委託跳過，保留原現金與持倉，再核對扣費後實際權重。周轉率為買賣參考名目金額合計／模擬前淨值。手續費按模擬成交金額計算；買入成本包含費用、賣出損益扣除費用，採移動平均成本。不含稅、流動性、市場衝擊、股息及拆併股自動調整。')

LEGACY_WARNINGS = ['僅供本機流程演練；沒有連接券商，也不會改動真實持股。', '同日收盤參考價無法證明真實可成交；費用與滑價是使用者設定的假設，未建模流動性及公司行動，不能視為策略回測或實際績效。']

LEGACY_INITIAL_PREVIEW = {'account_id': 'synthetic-legacy-account',
 'account_version': 1,
 'as_of': '2024-01-05',
 'automation_source': None,
 'cash_after': 9000.0,
 'cash_after_exact': '9000.00000000',
 'cash_before': 10000.0,
 'cash_weight_after_pct': 90.0,
 'cost_total': 0.0,
 'coverage': {'missing': [], 'priced': 1, 'required': 1},
 'engine_version': 'alphaview-paper-portfolio-v2',
 'equity_after': 10000.0,
 'equity_before': 10000.0,
 'executable': True,
 'execution_policy': {'fee_bps': 0, 'min_trade_notional': 0, 'share_precision': 6, 'slippage_bps': 0},
 'fees_total': 0.0,
 'input_revision': 'synthetic-policy-migration:2',
 'limits': {'max_position_weight_pct': 35, 'max_turnover_pct': 100, 'min_cash_weight_pct': 10},
 'method': LEGACY_METHOD,
 'orders': [{'cash_delta': -1000.0,
             'cash_delta_exact': '-1000.00000000',
             'current_shares': 0.0,
             'fee': 0.0,
             'fee_exact': '0E-8',
             'fill_price': 100.0,
             'fill_price_exact': '100.00000000',
             'notional': 1000.0,
             'notional_exact': '1000.00000000',
             'projected_weight_pct': 10.0,
             'reference_notional': 1000.0,
             'reference_price': 100.0,
             'shares': 10.0,
             'shares_exact': '10.000000',
             'side': 'buy',
             'slippage_cost': 0.0,
             'slippage_cost_exact': '0E-8',
             'symbol': 'SYNTH',
             'target_shares': 10.0,
             'target_weight_pct': 10.0}],
 'projected_holdings': [{'market_value': 1000.0, 'shares': 10.0, 'symbol': 'SYNTH', 'weight_pct': 10.0}],
 'quote_details': [{'price': 100.0,
                    'price_date': '2024-01-05',
                    'quote_status': 'ok',
                    'reason': None,
                    'symbol': 'SYNTH'}],
 'rationale': '',
 'skipped_orders': [],
 'slippage_total': 0.0,
 'targets': [{'symbol': 'SYNTH', 'weight_pct': 10.0}],
 'turnover_pct': 10.0,
 'valuation_complete': True,
 'violations': [],
 'warnings': LEGACY_WARNINGS}

LEGACY_PENDING_PREVIEW = {'account_id': 'synthetic-legacy-account',
 'account_version': 2,
 'as_of': '2024-01-05',
 'automation_source': None,
 'cash_after': 7000.0,
 'cash_after_exact': '7000.00000000',
 'cash_before': 9000.0,
 'cash_weight_after_pct': 70.0,
 'cost_total': 0.0,
 'coverage': {'missing': [], 'priced': 1, 'required': 1},
 'engine_version': 'alphaview-paper-portfolio-v2',
 'equity_after': 10000.0,
 'equity_before': 10000.0,
 'executable': True,
 'execution_policy': {'fee_bps': 0, 'min_trade_notional': 0, 'share_precision': 6, 'slippage_bps': 0},
 'fees_total': 0.0,
 'input_revision': 'synthetic-policy-migration:2',
 'limits': {'max_position_weight_pct': 35, 'max_turnover_pct': 100, 'min_cash_weight_pct': 10},
 'method': LEGACY_METHOD,
 'orders': [{'cash_delta': -2000.0,
             'cash_delta_exact': '-2000.00000000',
             'current_shares': 10.0,
             'fee': 0.0,
             'fee_exact': '0E-8',
             'fill_price': 100.0,
             'fill_price_exact': '100.00000000',
             'notional': 2000.0,
             'notional_exact': '2000.00000000',
             'projected_weight_pct': 30.0,
             'reference_notional': 2000.0,
             'reference_price': 100.0,
             'shares': 20.0,
             'shares_exact': '20.000000',
             'side': 'buy',
             'slippage_cost': 0.0,
             'slippage_cost_exact': '0E-8',
             'symbol': 'SYNTH',
             'target_shares': 30.0,
             'target_weight_pct': 30.0}],
 'projected_holdings': [{'market_value': 3000.0, 'shares': 30.0, 'symbol': 'SYNTH', 'weight_pct': 30.0}],
 'quote_details': [{'price': 100.0,
                    'price_date': '2024-01-05',
                    'quote_status': 'ok',
                    'reason': None,
                    'symbol': 'SYNTH'}],
 'rationale': '',
 'skipped_orders': [],
 'slippage_total': 0.0,
 'targets': [{'symbol': 'SYNTH', 'weight_pct': 30.0}],
 'turnover_pct': 20.0,
 'valuation_complete': True,
 'violations': [],
 'warnings': LEGACY_WARNINGS}

LEGACY_INITIAL_REQUEST = {'automation_source': None,
 'expected_as_of': None,
 'expected_input_revision': None,
 'expected_version': 1,
 'rationale': '',
 'targets': [{'symbol': 'SYNTH', 'weight_pct': 10.0}]}

LEGACY_PENDING_REQUEST = {'automation_source': None,
 'expected_as_of': None,
 'expected_input_revision': None,
 'expected_version': 2,
 'rationale': '',
 'targets': [{'symbol': 'SYNTH', 'weight_pct': 30.0}]}

LEGACY_FROZEN_QUEUE = {'account_fingerprint': '02887d14388c4a444b15a0cabb14192f7ad1de23a26f9049325e8d6f4cc71fdc',
 'adjustment_factors': {'SYNTH': '1'},
 'holdings': [{'cost_basis': '1000.00000000', 'shares': '10.000000', 'symbol': 'SYNTH'}],
 'max_buy_cash_debit_usd': 3000.0,
 'max_execution_cost_usd': 0.0,
 'quote_symbols': ['SYNTH'],
 'source_authorization': {'kind': 'explicit_saved_proposal'},
 'source_preview': LEGACY_PENDING_PREVIEW,
 'source_record_fingerprint': 'bbe9962c78413c8bfeeacef38901d0e98549e7c74e376cea50ec00f0017a4e2e',
 'source_request': LEGACY_PENDING_REQUEST}

LEGACY_FORK_SOURCE = {'account_id': 'synthetic-legacy-account',
 'account_name': 'Synthetic legacy source',
 'account_version': 2,
 'as_of': '2024-01-05',
 'cash': '9000.00000000',
 'execution_policy': {'fee_bps': 0, 'min_trade_notional': 0, 'share_precision': 6, 'slippage_bps': 0},
 'holdings': [{'opening_value': '1000.00000000',
               'reference_price': '100.0',
               'shares': '10.000000',
               'symbol': 'SYNTH'}],
 'initial_cash': '10000.00000000',
 'input_revision': 'synthetic-policy-migration:2',
 'kill_switch': False,
 'limits': {'max_position_weight_pct': 35, 'max_turnover_pct': 100, 'min_cash_weight_pct': 10},
 'paper_engine_version': 'alphaview-paper-portfolio-v2'}

LEGACY_PENDING_RESPONSE = {**LEGACY_PENDING_PREVIEW, **{'accepted_at': None,
 'created_at': '2024-01-06T12:00:00+00:00',
 'id': 'synthetic-legacy-pending',
 'status': 'proposed'}}

LEGACY_TABLES = {'bars': [{'adj_close': 100.0,
           'close': 100.0,
           'date': '2024-01-05',
           'high': 101.0,
           'low': 99.0,
           'open': 100.0,
           'symbol': 'SYNTH',
           'volume': 1000.0}],
 'datasets': [{'bar_count': 0,
               'currency': 'USD',
               'error': None,
               'exchange': None,
               'fetched_at': None,
               'last_date': '2024-01-05',
               'name': 'Synthetic fixture',
               'source': 'synthetic fixture',
               'status': 'ok',
               'symbol': 'SYNTH'}],
 'panel_revisions': [{'data_revision': 2,
                      'id': 1,
                      'identity': 'synthetic-policy-migration',
                      'inputs_revision': 2,
                      'job_revision': 0}],
 'paper_account_origins': [{'account_id': 'synthetic-legacy-fork',
                            'as_of': '2024-01-05',
                            'created_at': '2024-01-06T12:00:00+00:00',
                            'engine_version': 'alphaview-paper-fork-v1',
                            'source_account_id': 'synthetic-legacy-account',
                            'source_account_version': 2,
                            'source_digest': '62c2c13729b19fe21717737ef749f9b2ce537479bc1c7fc0e1fc907a45448e43',
                            'source_input_revision': 'synthetic-policy-migration:2',
                            'source_json': _canonical(LEGACY_FORK_SOURCE)}],
 'paper_accounts': [{'cash': '9000.00000000',
                     'created_at': '2024-01-06T12:00:00+00:00',
                     'currency': 'USD',
                     'execution_policy_json': '{"fee_bps":0,"min_trade_notional":0,"share_precision":6,"slippage_bps":0}',
                     'id': 'synthetic-legacy-account',
                     'initial_cash': '10000.00000000',
                     'kill_switch': 0,
                     'limits_json': '{"max_position_weight_pct":35,"max_turnover_pct":100,"min_cash_weight_pct":10}',
                     'name': 'Synthetic legacy source',
                     'realized_pnl': '0',
                     'updated_at': '2024-01-06T12:00:00+00:00',
                     'version': 2},
                    {'cash': '9000.00000000',
                     'created_at': '2024-01-06T12:00:00+00:00',
                     'currency': 'USD',
                     'execution_policy_json': '{"fee_bps":0,"min_trade_notional":0,"share_precision":6,"slippage_bps":0}',
                     'id': 'synthetic-legacy-fork',
                     'initial_cash': '10000.00000000',
                     'kill_switch': 0,
                     'limits_json': '{"max_position_weight_pct":35,"max_turnover_pct":100,"min_cash_weight_pct":10}',
                     'name': 'Synthetic legacy fork',
                     'realized_pnl': '0',
                     'updated_at': '2024-01-06T12:00:00+00:00',
                     'version': 1}],
 'paper_holdings': [{'account_id': 'synthetic-legacy-account',
                     'cost_basis': '1000.00000000',
                     'shares': '10.000000',
                     'symbol': 'SYNTH'},
                    {'account_id': 'synthetic-legacy-fork',
                     'cost_basis': '1000.00000000',
                     'shares': '10.000000',
                     'symbol': 'SYNTH'}],
 'paper_idempotency': [{'created_at': '2024-01-06T12:00:00+00:00',
                        'key': 'synthetic-legacy-pending',
                        'request_hash': 'a9c8072886eff48743146d252b95df7a47df7aa312c31ef59371ede7acf566c8',
                        'response_json': _canonical(LEGACY_PENDING_RESPONSE),
                        'scope': 'proposal:synthetic-legacy-account'}],
 'paper_ledger': [{'account_id': 'synthetic-legacy-account',
                   'cash_after': '10000.00000000',
                   'cash_delta': '10000.00000000',
                   'created_at': '2024-01-06T12:00:00+00:00',
                   'fee': '0',
                   'id': 1,
                   'kind': 'initial_cash',
                   'price': None,
                   'proposal_id': None,
                   'realized_pnl': '0',
                   'reference_price': None,
                   'shares_delta': '0',
                   'slippage_cost': '0',
                   'symbol': None},
                  {'account_id': 'synthetic-legacy-account',
                   'cash_after': '9000.00000000',
                   'cash_delta': '-1000.00000000',
                   'created_at': '2024-01-06T12:00:00+00:00',
                   'fee': '0E-8',
                   'id': 2,
                   'kind': 'simulated_fill',
                   'price': '100.00000000',
                   'proposal_id': 'synthetic-legacy-initial',
                   'realized_pnl': '0',
                   'reference_price': '100.0',
                   'shares_delta': '10.000000',
                   'slippage_cost': '0E-8',
                   'symbol': 'SYNTH'},
                  {'account_id': 'synthetic-legacy-fork',
                   'cash_after': '10000.00000000',
                   'cash_delta': '10000.00000000',
                   'created_at': '2024-01-06T12:00:00+00:00',
                   'fee': '0',
                   'id': 3,
                   'kind': 'initial_cash',
                   'price': None,
                   'proposal_id': None,
                   'realized_pnl': '0',
                   'reference_price': None,
                   'shares_delta': '0',
                   'slippage_cost': '0',
                   'symbol': None},
                  {'account_id': 'synthetic-legacy-fork',
                   'cash_after': '9000.00000000',
                   'cash_delta': '-1000.00000000',
                   'created_at': '2024-01-06T12:00:00+00:00',
                   'fee': '0',
                   'id': 4,
                   'kind': 'opening_mark',
                   'price': '100.0',
                   'proposal_id': None,
                   'realized_pnl': '0',
                   'reference_price': '100.0',
                   'shares_delta': '10.000000',
                   'slippage_cost': '0',
                   'symbol': 'SYNTH'}],
 'paper_next_open_orders': [{'account_id': 'synthetic-legacy-account',
                             'completed_at': None,
                             'created_at': '2024-01-06T12:00:00+00:00',
                             'eligible_after': '2024-01-08T21:15:00+00:00',
                             'engine_version': 'alphaview-paper-next-open-v1',
                             'enqueue_before': '2024-01-08T14:30:00+00:00',
                             'evaluation_json': None,
                             'execution_proposal_id': None,
                             'execution_session': '2024-01-08',
                             'frozen_json': _canonical(LEGACY_FROZEN_QUEUE),
                             'id': 'synthetic-legacy-queue',
                             'last_checked_revision': None,
                             'prefix_digest': '74583744a5eb1509baa3e0d5fd7eaadffee547980a44c64dc616aef83cd2d3c8',
                             'prefix_rows': 1,
                             'reason': '已凍結股數與上限，等待指定交易日完成後讀取本機開盤價',
                             'reason_code': 'waiting_session',
                             'signal_session': '2024-01-05',
                             'source_manifest_json': '["SYNTH"]',
                             'source_proposal_id': 'synthetic-legacy-pending',
                             'status': 'waiting_session',
                             'updated_at': '2024-01-06T12:00:00+00:00',
                             'version': 1}],
 'paper_proposals': [{'accepted_at': '2024-01-06T12:00:00+00:00',
                      'account_id': 'synthetic-legacy-account',
                      'created_at': '2024-01-06T12:00:00+00:00',
                      'id': 'synthetic-legacy-initial',
                      'preview_json': _canonical(LEGACY_INITIAL_PREVIEW),
                      'request_json': _canonical(LEGACY_INITIAL_REQUEST),
                      'status': 'simulated'},
                     {'accepted_at': None,
                      'account_id': 'synthetic-legacy-account',
                      'created_at': '2024-01-06T12:00:00+00:00',
                      'id': 'synthetic-legacy-pending',
                      'preview_json': _canonical(LEGACY_PENDING_PREVIEW),
                      'request_json': _canonical(LEGACY_PENDING_REQUEST),
                      'status': 'proposed'}]}


ACCOUNT = "synthetic-legacy-account"
FORK = "synthetic-legacy-fork"
PENDING = "synthetic-legacy-pending"
QUEUE = "synthetic-legacy-queue"
PREVIEW_SHA256 = "f08ceb98c9820d766d30f171be2cc1a1eb327bd05d44d0c63d1a02afeed638d8"
QUEUE_SHA256 = "ac600d566ca241178bca19394d699c5d4cb12683dd54db427c49313591db1ec9"


@pytest.fixture
def prior_workspace(tmp_path, monkeypatch):
    database = tmp_path / "populated-prior-policy.db"
    monkeypatch.setenv("PANEL_DB_PATH", str(database))
    clock = {"now": pd.Timestamp("2024-01-06T12:00:00Z")}
    real_latest = sessions.latest_completed_session
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: real_latest(clock["now"] if at is None else at))
    monkeypatch.setattr(next_open, "utcnow", lambda: clock["now"].to_pydatetime())
    monkeypatch.setattr(store, "now", lambda: clock["now"].isoformat())
    with sqlite3.connect(database) as db:
        db.executescript((Path(__file__).parent / "fixtures/agent-portfolio-schema-2026-09-20.sql").read_text())
        # Populate source-only schema with old-engine-produced rows. Revision
        # identity is restored last so insert triggers cannot alter its fixture.
        for table in [name for name in LEGACY_TABLES if name != "panel_revisions"] + ["panel_revisions"]:
            for row in LEGACY_TABLES[table]:
                names = list(row)
                db.execute(f"INSERT INTO {table} ({','.join(names)}) VALUES ({','.join('?' for _ in names)})",
                           tuple(row[name] for name in names))
        assert "symbol_policy_json" not in {row[1] for row in db.execute("PRAGMA table_info(paper_accounts)")}
        assert db.execute("SELECT name FROM sqlite_schema WHERE name='paper_symbol_policy_history'").fetchone() is None
    assert store.input_revision() == "synthetic-policy-migration:2"
    assert _digest(LEGACY_PENDING_PREVIEW) == PREVIEW_SHA256
    assert _digest(LEGACY_FROZEN_QUEUE) == QUEUE_SHA256
    return database, clock


def _old_columns_snapshot():
    with store.connect() as db:
        return {table: [dict(row) for row in db.execute(
            f"SELECT {','.join(rows[0])} FROM {table} ORDER BY rowid")]
            for table, rows in LEGACY_TABLES.items()}


def _stored_preview(identifier=PENDING):
    with store.connect() as db:
        return db.execute("SELECT preview_json FROM paper_proposals WHERE id=?", (identifier,)).fetchone()[0]


def _fills():
    with store.connect() as db:
        return [dict(row) for row in db.execute("SELECT * FROM paper_ledger WHERE kind='simulated_fill' ORDER BY id")]


def test_populated_prior_accounts_migrate_once_without_rewriting_old_columns_or_receipts(prior_workspace):
    before = _old_columns_snapshot()
    initial_receipt = _stored_preview("synthetic-legacy-initial")
    pending_receipt = _stored_preview()
    store.init_db()
    store.init_db()
    assert _old_columns_snapshot() == before
    assert store.input_revision() == "synthetic-policy-migration:2"
    assert _stored_preview("synthetic-legacy-initial") == initial_receipt
    assert _stored_preview() == pending_receipt
    with store.connect() as db:
        accounts = [dict(row) for row in db.execute("SELECT * FROM paper_accounts ORDER BY id")]
        history = [dict(row) for row in db.execute("SELECT * FROM paper_symbol_policy_history ORDER BY account_id,version")]
    assert len(history) == len(accounts) == 2
    expected = {"engine_version": paper.SYMBOL_POLICY_VERSION, "version": 1, "mode": "unrestricted", "symbols": []}
    assert all(json.loads(row["symbol_policy_json"]) == expected for row in accounts)
    assert all(json.loads(row["policy_json"]) == expected and row["version"] == 1 for row in history)
    assert {row["id"]: row["version"] for row in accounts} == {ACCOUNT: 2, FORK: 1}
    assert all(row["created_at"] == "2024-01-06T12:00:00+00:00" for row in history)


def test_old_pending_proposal_recalculates_byte_identically_and_idempotent_replay_stays_old(prior_workspace):
    store.init_db()
    before_fills = _fills()
    old_bytes = _stored_preview()
    request = paper.PreviewInput.model_validate(LEGACY_PENDING_REQUEST)
    fresh = paper.preview(ACCOUNT, request)
    # Additive preview metadata (risk_direction, 2026-10-01) is excluded from replay checks by paper.PREVIEW_METADATA.
    assert fresh["risk_direction"] == "increasing"
    comparable = {key: value for key, value in fresh.items() if key not in paper.PREVIEW_METADATA}
    assert comparable == LEGACY_PENDING_PREVIEW
    assert _canonical(comparable) == old_bytes and _digest(comparable) == PREVIEW_SHA256
    assert "symbol_policy" not in fresh
    repeated = paper.create_proposal(ACCOUNT, paper.ProposalInput(
        **LEGACY_PENDING_REQUEST, idempotency_key="synthetic-legacy-pending"))
    assert repeated == LEGACY_PENDING_RESPONSE
    assert _fills() == before_fills
    accepted = paper.accept_proposal(ACCOUNT, PENDING,
        paper.AcceptInput(expected_version=2, idempotency_key="synthetic-after-policy-upgrade"))
    assert accepted["account"]["account"]["version"] == 3
    assert accepted["account"]["account"]["cash"] == 7000
    assert accepted["account"]["holdings"][0]["shares"] == 30
    assert _stored_preview() == old_bytes and len(_fills()) == len(before_fills) + 1


def test_actual_old_pending_queue_fingerprint_survives_upgrade_and_settles_same_fixed_shares(prior_workspace):
    _database, clock = prior_workspace
    store.init_db()
    before_fills, old_preview = _fills(), _stored_preview()
    with store.connect() as db:
        queue = dict(db.execute("SELECT * FROM paper_next_open_orders WHERE id=?", (QUEUE,)).fetchone())
        frozen = json.loads(queue["frozen_json"])
        assert _digest(frozen) == QUEUE_SHA256
        assert next_open._account_fingerprint(db, paper._account(db, ACCOUNT)) == frozen["account_fingerprint"]
        assert next_open._basic_invalid(db, queue, frozen) is None
        assert next_open._current_proposal(db, ACCOUNT, PENDING, "2024-01-05")[2] == LEGACY_PENDING_PREVIEW
        assert frozen["source_preview"]["orders"][0]["shares_exact"] == "20.000000"
    clock["now"] = pd.Timestamp("2024-01-08T21:15:00Z")
    with store.connect() as db:
        db.execute("UPDATE datasets SET last_date='2024-01-08' WHERE symbol='SYNTH'")
        db.execute("INSERT INTO bars VALUES('SYNTH','2024-01-08',110,111,109,110,110,1000)")
    request = next_open.OrderActionInput(expected_order_version=1, idempotency_key="synthetic-legacy-queue-process")
    result = next_open.process_order(ACCOUNT, QUEUE, request)
    assert result["status"] == "filled" and result["last_evaluation"]["orders"][0]["shares_exact"] == "20.000000"
    assert next_open.process_order(ACCOUNT, QUEUE, request) == result
    account = paper.account_snapshot(ACCOUNT)
    assert account["account"]["cash"] == 6800 and account["holdings"][0]["shares"] == 30
    assert len(_fills()) == len(before_fills) + 1
    assert _stored_preview() == old_preview
    with store.connect() as db:
        after = db.execute("SELECT frozen_json FROM paper_next_open_orders WHERE id=?", (QUEUE,)).fetchone()[0]
        assert after == queue["frozen_json"]
        assert db.execute("SELECT status FROM paper_proposals WHERE id=?", (PENDING,)).fetchone()[0] == "proposed"


def test_old_fork_origin_and_plan_survive_and_new_forks_have_independent_policy_history(prior_workspace):
    with store.connect() as db:
        old_origin = dict(db.execute("SELECT * FROM paper_account_origins WHERE account_id=?", (FORK,)).fetchone())
    store.init_db()
    plan = forks.preview_fork(ACCOUNT, forks.ForkPreviewInput(expected_version=2))
    assert plan["source"] == LEGACY_FORK_SOURCE
    assert plan["source_digest"] == old_origin["source_digest"]
    assert "symbol_policy" not in plan["source"]
    unrestricted_child = forks.create_fork(ACCOUNT, forks.ForkInput(
        expected_version=2, name="Synthetic upgraded fork", expected_source_digest=plan["source_digest"],
        idempotency_key="synthetic-upgraded-fork"))["account"]["account"]
    changed = paper.update_controls(ACCOUNT, paper.ControlsInput(expected_version=2,
        symbol_policy={"mode": "allowlist", "symbols": []}))["account"]
    restricted_plan = forks.preview_fork(ACCOUNT, forks.ForkPreviewInput(expected_version=changed["version"]))
    restricted_child = forks.create_fork(ACCOUNT, forks.ForkInput(
        expected_version=changed["version"], name="Synthetic restricted fork",
        expected_source_digest=restricted_plan["source_digest"], idempotency_key="synthetic-restricted-fork"))["account"]["account"]
    assert restricted_child["symbol_policy"] == {"engine_version": paper.SYMBOL_POLICY_VERSION, "version": 1, "mode": "allowlist", "symbols": []}
    for identifier in (FORK, unrestricted_child["id"]):
        assert paper.account_snapshot(identifier)["account"]["symbol_policy"]["mode"] == "unrestricted"
        assert len(paper.symbol_policy_history(identifier)["items"]) == 1
    preview = paper.preview(restricted_child["id"], paper.PreviewInput(expected_version=1,
        targets=[{"symbol": "SYNTH", "weight_pct": 11}]))
    assert not preview["executable"] and "symbol_not_allowed" in {row["code"] for row in preview["violations"]}
    with store.connect() as db:
        assert dict(db.execute("SELECT * FROM paper_account_origins WHERE account_id=?", (FORK,)).fetchone()) == old_origin
    history = paper.symbol_policy_history(ACCOUNT)["items"]
    store.init_db()
    assert paper.symbol_policy_history(ACCOUNT)["items"] == history


def test_policy_roundtrip_after_migration_invalidates_old_manual_and_queue_authority(prior_workspace):
    store.init_db()
    preview, fills = _stored_preview(), _fills()
    account = paper.update_controls(ACCOUNT, paper.ControlsInput(expected_version=2,
        symbol_policy={"mode": "allowlist", "symbols": ["SYNTH"]}))["account"]
    account = paper.update_controls(ACCOUNT, paper.ControlsInput(expected_version=account["version"],
        symbol_policy={"mode": "unrestricted", "symbols": []}))["account"]
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        paper.accept_proposal(ACCOUNT, PENDING, paper.AcceptInput(expected_version=account["version"],
            idempotency_key="synthetic-invalidated-legacy"))
    assert error.value.status_code == 409
    result = next_open.process_order(ACCOUNT, QUEUE,
        next_open.OrderActionInput(expected_order_version=1, idempotency_key="synthetic-invalidated-queue"))
    assert result["status"] == "invalidated" and result["reason_code"] == "account_changed"
    assert _stored_preview() == preview and _fills() == fills
    assert [item["policy"]["version"] for item in paper.symbol_policy_history(ACCOUNT)["items"]] == [3, 2, 1]
