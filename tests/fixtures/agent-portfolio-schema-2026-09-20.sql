-- Trusted prior schema captured from the baseline source in a synthetic empty database.
CREATE TABLE agent_automation_attempts (
        id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, session_date TEXT NOT NULL,
        mandate_version INTEGER NOT NULL, account_id TEXT NOT NULL, account_version INTEGER NOT NULL,
        mode TEXT NOT NULL, trigger_kind TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, run_id TEXT NOT NULL,
        paper_proposal_id TEXT, reason_code TEXT, reason TEXT, result_json TEXT,
        engine_version TEXT NOT NULL, input_revision TEXT NOT NULL,
        UNIQUE(mandate_id,session_date)
    );

CREATE TABLE agent_mandates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT NOT NULL,
        workflow_json TEXT NOT NULL,
        candidate_source TEXT NOT NULL DEFAULT 'explicit' CHECK(candidate_source IN ('explicit','scan_pool')),
        selector_limit INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        mode TEXT NOT NULL DEFAULT 'proposal_only' CHECK(mode IN ('proposal_only','auto_simulate')),
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_checked_at TEXT, last_status TEXT, last_reason TEXT
    );

CREATE TABLE backtests (
            id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
            symbol TEXT NOT NULL, strategy TEXT NOT NULL, result TEXT NOT NULL
        );

CREATE TABLE bars (
            symbol TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL,
            high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
            adj_close REAL NOT NULL, volume REAL NOT NULL,
            PRIMARY KEY(symbol, date)
        );

CREATE TABLE datasets (
            symbol TEXT PRIMARY KEY, name TEXT, currency TEXT, exchange TEXT,
            fetched_at TEXT, last_date TEXT, bar_count INTEGER DEFAULT 0,
            status TEXT, error TEXT, source TEXT NOT NULL DEFAULT 'Yahoo Finance / yfinance'
        );

CREATE TABLE jobs (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
            started_at TEXT NOT NULL, finished_at TEXT, progress TEXT,
            result TEXT, error TEXT
        , scope TEXT NOT NULL DEFAULT 'portfolio', cancel_requested INTEGER NOT NULL DEFAULT 0);

CREATE TABLE local_agent_runs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        source_run_id TEXT NOT NULL, engine_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','blocked','failed','cancelled','stale','interrupted')),
        phase TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        as_of TEXT NOT NULL, input_revision TEXT NOT NULL,
        request_json TEXT NOT NULL, source_json TEXT NOT NULL, model_json TEXT NOT NULL,
        facts_json TEXT NOT NULL, prompt_json TEXT NOT NULL, prompt_digest TEXT NOT NULL,
        schema_digest TEXT NOT NULL, result_json TEXT, error_json TEXT
    );

CREATE TABLE market_universe (
            symbol TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
            discovered_at TEXT NOT NULL, market_cap REAL
        );

CREATE TABLE market_universe_metadata (
            id INTEGER PRIMARY KEY CHECK(id=1), requested_limit INTEGER NOT NULL,
            provider_total INTEGER, raw_count INTEGER NOT NULL,
            accepted_count INTEGER NOT NULL, pages INTEGER NOT NULL,
            discovered_at TEXT NOT NULL
        );

CREATE TABLE panel_revisions (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, data_revision INTEGER NOT NULL DEFAULT 0, job_revision INTEGER NOT NULL DEFAULT 0, inputs_revision INTEGER NOT NULL DEFAULT 0);

CREATE TABLE paper_account_origins (
        account_id TEXT PRIMARY KEY, source_account_id TEXT NOT NULL,
        source_account_version INTEGER NOT NULL, source_input_revision TEXT NOT NULL,
        as_of TEXT NOT NULL, engine_version TEXT NOT NULL, source_digest TEXT NOT NULL,
        source_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES paper_accounts(id),
        FOREIGN KEY(source_account_id) REFERENCES paper_accounts(id)
    );

CREATE TABLE paper_accounts (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency='USD'),
            initial_cash TEXT NOT NULL, cash TEXT NOT NULL, realized_pnl TEXT NOT NULL DEFAULT '0',
            version INTEGER NOT NULL DEFAULT 1, kill_switch INTEGER NOT NULL DEFAULT 0,
            limits_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        , execution_policy_json TEXT NOT NULL DEFAULT '{"fee_bps":0,"min_trade_notional":0,"share_precision":6,"slippage_bps":0}');

CREATE TABLE paper_holdings (
            account_id TEXT NOT NULL, symbol TEXT NOT NULL, shares TEXT NOT NULL,
            cost_basis TEXT NOT NULL, PRIMARY KEY(account_id,symbol),
            FOREIGN KEY(account_id) REFERENCES paper_accounts(id)
        );

CREATE TABLE paper_idempotency (
            scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
            response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,key)
        );

CREATE TABLE paper_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
            kind TEXT NOT NULL, symbol TEXT, shares_delta TEXT NOT NULL DEFAULT '0',
            price TEXT, cash_delta TEXT NOT NULL, cash_after TEXT NOT NULL,
            realized_pnl TEXT NOT NULL DEFAULT '0', proposal_id TEXT, created_at TEXT NOT NULL, fee TEXT NOT NULL DEFAULT '0', slippage_cost TEXT NOT NULL DEFAULT '0', reference_price TEXT,
            UNIQUE(proposal_id,symbol), FOREIGN KEY(account_id) REFERENCES paper_accounts(id)
        );

CREATE TABLE paper_nav_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
        as_of TEXT NOT NULL, account_version INTEGER NOT NULL, input_revision TEXT NOT NULL,
        engine_version TEXT NOT NULL, observed_at TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        UNIQUE(account_id,as_of,account_version,input_revision,engine_version),
        FOREIGN KEY(account_id) REFERENCES paper_accounts(id)
    );

CREATE TABLE paper_next_open_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL,
            trigger_kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            status TEXT NOT NULL, reason_code TEXT NOT NULL, reason TEXT NOT NULL,
            input_revision TEXT NOT NULL, evaluation_json TEXT, created_at TEXT NOT NULL,
            UNIQUE(order_id,idempotency_key),
            FOREIGN KEY(order_id) REFERENCES paper_next_open_orders(id)
        );

CREATE TABLE paper_next_open_orders (
            id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source_proposal_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('waiting_session','waiting_prices','blocked','filled','cancelled','invalidated')),
            version INTEGER NOT NULL DEFAULT 1, engine_version TEXT NOT NULL,
            signal_session TEXT NOT NULL, execution_session TEXT NOT NULL,
            enqueue_before TEXT NOT NULL, eligible_after TEXT NOT NULL,
            frozen_json TEXT NOT NULL, source_manifest_json TEXT NOT NULL,
            prefix_digest TEXT NOT NULL, prefix_rows INTEGER NOT NULL,
            evaluation_json TEXT, reason_code TEXT NOT NULL, reason TEXT NOT NULL,
            execution_proposal_id TEXT UNIQUE, last_checked_revision TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
            FOREIGN KEY(account_id) REFERENCES paper_accounts(id),
            FOREIGN KEY(source_proposal_id) REFERENCES paper_proposals(id)
        );

CREATE TABLE paper_proposals (
            id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL,
            preview_json TEXT NOT NULL, request_json TEXT NOT NULL,
            created_at TEXT NOT NULL, accepted_at TEXT,
            FOREIGN KEY(account_id) REFERENCES paper_accounts(id)
        );

CREATE TABLE portfolio_agent_runs (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, engine_version TEXT NOT NULL,
        as_of TEXT NOT NULL, input_revision TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('proposed','blocked')),
        request TEXT NOT NULL, result TEXT NOT NULL
    );

CREATE TABLE positions (
            symbol TEXT PRIMARY KEY, name TEXT NOT NULL, shares REAL NOT NULL DEFAULT 0,
            cost REAL, sector TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
            snapshot_price REAL, snapshot_change REAL, updated_at TEXT NOT NULL
        );

CREATE TABLE refresh_schedule (
            id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
            scope TEXT NOT NULL DEFAULT 'market' CHECK(scope IN ('market','portfolio')),
            universe_limit INTEGER NOT NULL DEFAULT 250 CHECK(universe_limit IN (250,500,1000)),
            version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
        );

CREATE TABLE research_notes (
            symbol TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        );

CREATE TABLE scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
            as_of TEXT NOT NULL, universe TEXT NOT NULL, result TEXT NOT NULL
        , scope TEXT NOT NULL DEFAULT 'portfolio', input_revision TEXT);

CREATE TABLE schedule_attempts (
            session_date TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE,
            scope TEXT NOT NULL, universe_limit INTEGER NOT NULL, claimed_at TEXT NOT NULL
        );

CREATE INDEX idx_agent_automation_attempts_mandate ON agent_automation_attempts(mandate_id,session_date DESC);

CREATE UNIQUE INDEX idx_agent_mandates_enabled_account ON agent_mandates(account_id) WHERE enabled=1;

CREATE INDEX idx_local_agent_runs_created ON local_agent_runs(created_at,id);

CREATE INDEX idx_paper_ledger_account ON paper_ledger(account_id,id DESC);

CREATE INDEX idx_paper_nav_account_date ON paper_nav_snapshots(account_id,as_of,id);

CREATE INDEX idx_paper_next_open_account
            ON paper_next_open_orders(account_id,created_at DESC);

CREATE UNIQUE INDEX idx_paper_next_open_active
            ON paper_next_open_orders(account_id)
            WHERE status IN ('waiting_session','waiting_prices','blocked');

CREATE INDEX idx_paper_proposals_account ON paper_proposals(account_id,created_at DESC);

CREATE INDEX idx_portfolio_agent_runs_created ON portfolio_agent_runs(created_at,id);

CREATE INDEX idx_scan_scope_date ON scans(scope,as_of,id);

CREATE TRIGGER inputs_bars_delete AFTER DELETE ON bars BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_bars_insert AFTER INSERT ON bars BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_bars_update AFTER UPDATE ON bars BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_datasets_delete AFTER DELETE ON datasets BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_datasets_insert AFTER INSERT ON datasets BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_datasets_update AFTER UPDATE ON datasets BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_market_universe_delete AFTER DELETE ON market_universe BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_market_universe_insert AFTER INSERT ON market_universe BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_market_universe_metadata_delete AFTER DELETE ON market_universe_metadata BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_market_universe_metadata_insert AFTER INSERT ON market_universe_metadata BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_market_universe_metadata_update AFTER UPDATE ON market_universe_metadata BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_market_universe_update AFTER UPDATE ON market_universe BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_positions_delete AFTER DELETE ON positions BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_positions_insert AFTER INSERT ON positions BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER inputs_positions_update AFTER UPDATE ON positions BEGIN UPDATE panel_revisions SET inputs_revision=inputs_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_bars_delete AFTER DELETE ON bars BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_bars_insert AFTER INSERT ON bars BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_bars_update AFTER UPDATE ON bars BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_datasets_delete AFTER DELETE ON datasets BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_datasets_insert AFTER INSERT ON datasets BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_datasets_update AFTER UPDATE ON datasets BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_jobs_delete AFTER DELETE ON jobs BEGIN UPDATE panel_revisions SET job_revision=job_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_jobs_insert AFTER INSERT ON jobs BEGIN UPDATE panel_revisions SET job_revision=job_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_jobs_update AFTER UPDATE ON jobs BEGIN UPDATE panel_revisions SET job_revision=job_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_market_universe_delete AFTER DELETE ON market_universe BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_market_universe_insert AFTER INSERT ON market_universe BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_market_universe_metadata_delete AFTER DELETE ON market_universe_metadata BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_market_universe_metadata_insert AFTER INSERT ON market_universe_metadata BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_market_universe_metadata_update AFTER UPDATE ON market_universe_metadata BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_market_universe_update AFTER UPDATE ON market_universe BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_positions_delete AFTER DELETE ON positions BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_positions_insert AFTER INSERT ON positions BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_positions_update AFTER UPDATE ON positions BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_scans_delete AFTER DELETE ON scans BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_scans_insert AFTER INSERT ON scans BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;

CREATE TRIGGER revision_scans_update AFTER UPDATE ON scans BEGIN UPDATE panel_revisions SET data_revision=data_revision+1 WHERE id=1; END;
