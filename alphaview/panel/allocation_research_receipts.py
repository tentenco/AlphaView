"""Immutable, server-rebuilt allocation research receipts; never an execution source."""
import hashlib
import json
import math

from fastapi import APIRouter, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import Field

from . import allocation_research as research, paper_portfolio as paper, portfolio_agent as agent, sessions, store

class _ReceiptRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def validate_without_input_echo(request):
            try:
                return await handler(request)
            except RequestValidationError as exc:
                # Invalid JSON numbers may be NaN/Infinity. Keep field diagnostics,
                # never echo values that the finite JSON response cannot represent.
                details = [{key: error[key] for key in ("loc", "msg", "type")} for error in exc.errors()]
                return JSONResponse({"detail": details}, status_code=422, headers={"Cache-Control": "no-store"})

        return validate_without_input_echo


router = APIRouter(route_class=_ReceiptRoute)
ENGINE_VERSION = "alphaview-allocation-research-receipt-v1"
MAX_BYTES, MAX_ACCOUNT, MAX_TOTAL = 256 * 1024, 50, 500
COMPARISON_VERSION = "alphaview-allocation-research-receipt-comparison-v1"
COMPARABLE_RESEARCH_VERSION = "alphaview-allocation-research-v1"


class SaveInput(research.AllocationResearchInput):
    run_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    expected_account_version: int = Field(ge=1)
    expected_evidence_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


class CompareInput(agent.StrictInput):
    baseline_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    selected_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_baseline_content_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_selected_content_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


def init_schema(db):
    """Host schema transaction only; reads and publication never create tables."""
    db.execute("""CREATE TABLE IF NOT EXISTS allocation_research_receipts (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, run_id TEXT NOT NULL,
        created_at TEXT NOT NULL, engine_version TEXT NOT NULL,
        request_json TEXT NOT NULL, content_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB))<=262144)
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_allocation_research_receipts_account ON allocation_research_receipts(account_id,created_at,id)")


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _problem(code, message, status=409):
    return research._problem(code, message, status)


def _account_context(db, account_id):
    row = paper._account(db, account_id)
    return {"account_id": row["id"], "version": row["version"], "kill_switch": bool(row["kill_switch"]),
            "limits": json.loads(row["limits_json"]), "execution_policy": json.loads(row["execution_policy_json"]),
            "symbol_policy": json.loads(row["symbol_policy_json"])}


def _source(run):
    return {"agent_run_id": run["id"], "record_fingerprint": _hash(run), "proposal_fingerprint": run["proposal_fingerprint"],
            "engine_version": run["engine_version"], "input_revision": run["input_revision"], "as_of": run["as_of"],
            "scan_engine_version": (run.get("scan") or {}).get("engine_version"),
            "account_binding": "workflow_bound" if run.get("account_context") else "review_association_only"}


def _decode(row):
    if not isinstance(row["payload_json"], str) or not isinstance(row["request_json"], str):
        return None, "receipt_evidence_unverifiable"
    if len(row["payload_json"].encode()) > MAX_BYTES:
        return None, "receipt_size_limit"
    try:
        payload = json.loads(row["payload_json"])
        request = json.loads(row["request_json"])
        if not isinstance(payload, dict) or _hash(payload) != row["content_fingerprint"]:
            return None, "receipt_content_changed"
        evidence = payload["evidence"]
        account, source = payload["account_context"], payload["source_context"]
        if (not isinstance(evidence, dict) or not isinstance(account, dict) or not isinstance(source, dict)
                or account["account_id"] != row["account_id"] or source["agent_run_id"] != row["run_id"]
                or evidence["agent_run_id"] != row["run_id"] or payload["engine_version"] != row["engine_version"]
                or _hash(request) != row["id"] or request["account_id"] != row["account_id"]
                or request["request"]["run_id"] != row["run_id"]
                or request["request"]["expected_account_version"] != account["version"]
                or request["request"]["expected_evidence_fingerprint"] != evidence["evidence_fingerprint"]
                or evidence["proposal_fingerprint"] != source["proposal_fingerprint"]
                or evidence["input_revision"] != source["input_revision"] or evidence["as_of"] != source["as_of"]
                or evidence["evidence_fingerprint"] != _hash({key: value for key, value in evidence.items() if key != "evidence_fingerprint"})):
            return None, "receipt_evidence_unverifiable"
        return payload, None
    except (ValueError, KeyError, TypeError, RecursionError, OverflowError):
        return None, "receipt_evidence_unverifiable"


def _currentness(db, payload):
    if payload is None:
        return {"current": None, "reasons": ["receipt_unverifiable"]}
    source, context, evidence = payload["source_context"], payload["account_context"], payload["evidence"]
    reasons = []
    if payload["engine_version"] != ENGINE_VERSION or evidence["engine_version"] != research.ENGINE_VERSION:
        reasons.append("research_method_changed")
    if source["engine_version"] != agent.ENGINE_VERSION:
        reasons.append("workflow_method_changed")
    if source["input_revision"] != store.input_revision(db):
        reasons.append("inputs_changed")
    if source["as_of"] != sessions.latest_completed_session():
        reasons.append("session_changed")
    if source["scan_engine_version"] != agent.scan_provenance.SCAN_ENGINE_VERSION:
        reasons.append("scan_method_changed")
    row = db.execute("SELECT * FROM paper_accounts WHERE id=?", (context["account_id"],)).fetchone()
    if row is None:
        reasons.append("account_missing")
    elif _account_context(db, context["account_id"]) != context:
        reasons.append("account_context_changed")
    row = db.execute("SELECT * FROM portfolio_agent_runs WHERE id=?", (source["agent_run_id"],)).fetchone()
    if row is None:
        reasons.append("workflow_missing")
    else:
        try:
            if _hash(agent._run(db, source["agent_run_id"])) != source["record_fingerprint"]:
                reasons.append("workflow_changed")
        except (ValueError, KeyError, TypeError, RecursionError):
            return {"current": None, "reasons": [*reasons, "workflow_unverifiable"]}
    return {"current": not reasons, "reasons": reasons}


def _view(db, row, *, detail=True):
    payload, issue = _decode(row)
    try:
        currentness = _currentness(db, payload)
    except (KeyError, TypeError, ValueError, RecursionError):
        currentness = {"current": None, "reasons": ["context_unverifiable"]}
    evidence = payload["evidence"] if payload else None
    result = {"id": row["id"], "account_id": row["account_id"], "run_id": row["run_id"],
              "created_at": row["created_at"], "engine_version": row["engine_version"],
              "content_fingerprint": row["content_fingerprint"], "integrity": {"available": payload is not None, "reason": issue},
              "currentness": currentness,
              "status": evidence.get("status") if evidence else None,
              "as_of": evidence.get("as_of") if evidence else None,
              "lookback_sessions": (evidence.get("request") or {}).get("lookback_sessions") if evidence else None}
    if detail:
        result["receipt"] = payload
    return result


def _lookup(db, account_id, identifier):
    return db.execute("SELECT * FROM allocation_research_receipts WHERE account_id=? AND id=?", (account_id, identifier)).fetchone()


def _reply(value):
    return JSONResponse(value, headers={"Cache-Control": "no-store"})


def _replay(db, account_id, identifier, request_json):
    existing = _lookup(db, account_id, identifier)
    if existing is None:
        return None
    if existing["request_json"] != request_json:
        raise _problem("receipt_request_conflict", "保存請求識別衝突")
    return {**_view(db, existing), "replayed": True}


@router.post("/api/paper/accounts/{account_id}/allocation-research-receipts")
def save_receipt(account_id: str, body: SaveInput):
    request = {"account_id": account_id, "request": body.model_dump()}
    request_json, identifier = _json(request), _hash(request)
    with store.read_snapshot():
        with store.connect() as db:
            replay = _replay(db, account_id, identifier, request_json)
            if replay is not None:
                return _reply(replay)
            context = _account_context(db, account_id)
            if context["version"] != body.expected_account_version:
                raise _problem("receipt_account_changed", "帳戶版本已變更；請重新檢查研究")
            run = agent._run(db, body.run_id)
            paper._validate_policy_binding(db, run.get("account_context"), account_id)
            source = _source(run)
            comparison = research.AllocationResearchInput.model_validate(body.model_dump(include=set(research.AllocationResearchInput.model_fields)))
            evidence = json.loads(research.compare_allocations(body.run_id, comparison).body)
            if evidence["evidence_fingerprint"] != body.expected_evidence_fingerprint:
                raise _problem("receipt_evidence_changed", "伺服器重建結果與已檢閱研究不一致；請重新比較")
            payload = {"engine_version": ENGINE_VERSION, "account_context": context, "source_context": source, "evidence": evidence}
            encoded = _json(payload)
            if len(encoded.encode()) > MAX_BYTES:
                raise _problem("receipt_size_limit", "研究收據超過 256 KiB；未截短或保存", 422)
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        replay = _replay(db, account_id, identifier, request_json)
        if replay is not None:
            return _reply(replay)
        # Compare the complete source/account context after leaving the expensive read snapshot.
        reasons = _currentness(db, payload)
        if reasons["current"] is not True:
            raise _problem("receipt_context_changed", "保存期間來源、政策、帳戶或交易日已變更；未保存")
        if (db.execute("SELECT count(*) FROM allocation_research_receipts WHERE account_id=?", (account_id,)).fetchone()[0] >= MAX_ACCOUNT
                or db.execute("SELECT count(*) FROM allocation_research_receipts").fetchone()[0] >= MAX_TOTAL):
            raise _problem("receipt_capacity", "研究收據已達保留上限；不自動刪除歷史紀錄")
        db.execute("INSERT INTO allocation_research_receipts VALUES (?,?,?,?,?,?,?,?)",
                   (identifier, account_id, body.run_id, store.now(), ENGINE_VERSION, request_json, _hash(payload), encoded))
        result = {**_view(db, _lookup(db, account_id, identifier)), "replayed": False}
    return _reply(result)


@router.get("/api/paper/accounts/{account_id}/allocation-research-receipts")
@store.snapshot_read
def list_receipts(account_id: str, limit: int = Query(default=20, ge=1, le=20), offset: int = Query(default=0, ge=0, le=500)):
    with store.connect() as db:
        paper._account(db, account_id)
        total = db.execute("SELECT count(*) FROM allocation_research_receipts WHERE account_id=?", (account_id,)).fetchone()[0]
        rows = db.execute("SELECT * FROM allocation_research_receipts WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
                          (account_id, limit, offset)).fetchall()
        return _reply({"engine_version": ENGINE_VERSION, "account_id": account_id, "as_of": sessions.latest_completed_session(),
                       "input_revision": store.input_revision(db), "items": [_view(db, row, detail=False) for row in rows],
                       "pagination": {"limit": limit, "offset": offset, "total": total, "returned": len(rows)},
                       "retention": {"per_account": MAX_ACCOUNT, "global": MAX_TOTAL, "max_bytes": MAX_BYTES, "automatic_deletion": False}})


@router.get("/api/paper/accounts/{account_id}/allocation-research-receipts/{identifier}")
@store.snapshot_read
def get_receipt(account_id: str, identifier: str):
    with store.connect() as db:
        row = _lookup(db, account_id, identifier)
        if row is None:
            raise _problem("receipt_not_found", "找不到這筆帳戶研究收據", 404)
        return _reply(_view(db, row))


def _finite_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        return value if math.isfinite(value) else None
    except OverflowError:
        return None


def _comparison_shape(evidence):
    """Bound only the containers this comparison understands; history stays untouched."""
    symbols = evidence.get('selected_symbols')
    if (not isinstance(evidence.get('engine_version'), str) or not isinstance(evidence.get('request'), dict)
            or not isinstance(symbols, list) or len(symbols) > 30
            or any(not isinstance(symbol, str) for symbol in symbols) or len(set(symbols)) != len(symbols)):
        return False
    lookback = evidence['request'].get('lookback_sessions')
    if type(lookback) is not int or not 20 <= lookback <= 120:
        return False
    coverage, methods = evidence.get('coverage'), evidence.get('methods')
    if not isinstance(coverage, dict) or not isinstance(methods, dict):
        return False
    covered = coverage.get('per_symbol', [])
    if (not isinstance(covered, list) or len(covered) > 30
            or any(not isinstance(row, dict) or not isinstance(row.get('symbol'), str) for row in covered)):
        return False
    for name in ('rank_sum', 'equal_risk_contribution'):
        scenario = methods.get(name)
        if scenario is None:
            continue
        if not isinstance(scenario, dict):
            return False
        weights = scenario.get('weights', [])
        if (not isinstance(weights, list) or len(weights) > 30
                or any(not isinstance(row, dict) or not isinstance(row.get('symbol'), str) for row in weights)):
            return False
        for stage in ('risk_before', 'risk_after'):
            risk = scenario.get(stage)
            if risk is None:
                continue
            if not isinstance(risk, dict):
                return False
            for field in ('contributions_annualized_pct', 'risk_shares_pct'):
                values = risk.get(field)
                if values is not None and (not isinstance(values, list) or len(values) > 30):
                    return False
    return True


def _complete_coverage(evidence):
    symbols, coverage = evidence.get('selected_symbols'), evidence.get('coverage')
    lookback = (evidence.get('request') or {}).get('lookback_sessions')
    if (not isinstance(symbols, list) or not 1 <= len(symbols) <= 30
            or any(not isinstance(symbol, str) for symbol in symbols) or len(set(symbols)) != len(symbols)
            or type(lookback) is not int or not 20 <= lookback <= 120 or not isinstance(coverage, dict)):
        return False
    rows = coverage.get('per_symbol')
    if not isinstance(rows, list) or len(rows) != len(symbols) or any(not isinstance(row, dict) for row in rows):
        return False
    if set(row.get('symbol') for row in rows) != set(symbols):
        return False
    return (coverage.get('required_symbols') == coverage.get('complete_symbols') == len(symbols)
            and coverage.get('required_closes') == coverage.get('valid_closes') == len(symbols) * (lookback + 1)
            and coverage.get('required_return_sessions') == coverage.get('common_return_sessions') == lookback
            and all(row.get('status') == 'complete' and row.get('required_closes') == row.get('valid_closes') == lookback + 1
                    and row.get('valid_returns') == lookback and row.get('missing_dates') == [] and row.get('invalid_dates') == [] for row in rows))


def _comparison_reasons(before, after):
    reasons = []
    if before.get('engine_version') != COMPARABLE_RESEARCH_VERSION or after.get('engine_version') != COMPARABLE_RESEARCH_VERSION:
        reasons.append('research_method_incompatible')
    if (before.get('request') or {}).get('lookback_sessions') != (after.get('request') or {}).get('lookback_sessions'):
        reasons.append('lookback_changed')
    if set(before.get('selected_symbols') or []) != set(after.get('selected_symbols') or []):
        reasons.append('selected_symbols_changed')
    if not _complete_coverage(before) or not _complete_coverage(after):
        reasons.append('coverage_incomplete')
    return reasons


def _change(before, after, reason=None):
    before, after = _finite_number(before), _finite_number(after)
    if before is None or after is None:
        reason = reason or 'value_unavailable'
    delta = _finite_number(after - before) if reason is None else None
    return {'baseline': before, 'selected': after, 'delta': delta,
            'reason': reason or (None if delta is not None else 'delta_nonfinite')}


def _scenario_changes(before, after, name, reasons):
    first, second = (before.get('methods') or {}).get(name) or {}, (after.get('methods') or {}).get(name) or {}
    method_reasons = list(reasons)
    if first.get('status') != 'calculated' or second.get('status') != 'calculated':
        method_reasons.append('method_unavailable')
    blocked = 'incompatible_receipts' if reasons else ('method_unavailable' if method_reasons else None)
    totals = {field: _change(first.get(field), second.get(field), blocked) for field in
              ('invested_before_pct', 'invested_after_pct', 'cash_before_pct', 'cash_after_pct', 'capped_or_rounded_to_cash_pct')}
    symbols = sorted(set(before.get('selected_symbols') or []) | set(after.get('selected_symbols') or []))
    def weight(scenario, symbol, field):
        matches = [row for row in scenario.get('weights', []) if isinstance(row, dict) and row.get('symbol') == symbol]
        return matches[0].get(field) if len(matches) == 1 else None
    def risk(scenario, evidence, stage, field, symbol=None):
        value = scenario.get(stage) or {}
        data = value.get(field)
        if symbol is None:
            return data
        order = evidence.get('selected_symbols') or []
        if not isinstance(data, list) or len(data) != len(order) or symbol not in order:
            return None
        return data[order.index(symbol)]
    rows = []
    for symbol in symbols:
        row = {'symbol': symbol}
        for field in ('raw_weight_pct', 'capped_weight_pct'):
            row[field] = _change(weight(first, symbol, field), weight(second, symbol, field), blocked)
        for stage in ('risk_before', 'risk_after'):
            risk_reason = blocked or (None if (first.get(stage) or {}).get('status') == (second.get(stage) or {}).get('status') == 'calculated' else 'risk_unavailable')
            for field in ('contributions_annualized_pct', 'risk_shares_pct'):
                row[f'{stage}_{field}'] = _change(risk(first, before, stage, field, symbol), risk(second, after, stage, field, symbol), risk_reason)
        rows.append(row)
    for stage in ('risk_before', 'risk_after'):
        risk_reason = blocked or (None if (first.get(stage) or {}).get('status') == (second.get(stage) or {}).get('status') == 'calculated' else 'risk_unavailable')
        totals[f'{stage}_volatility_annualized_pct'] = _change(risk(first, before, stage, 'volatility_annualized_pct'), risk(second, after, stage, 'volatility_annualized_pct'), risk_reason)
    return {'comparable': not method_reasons, 'reasons': method_reasons, 'totals': totals, 'symbols': rows}


def _comparison_source(value):
    evidence, context = value['receipt']['evidence'], value['receipt']['account_context']
    policy = context.get('symbol_policy')
    coverage = {key: _finite_number(evidence['coverage'].get(key)) for key in
                ('complete_symbols', 'required_symbols', 'common_return_sessions', 'required_return_sessions', 'valid_closes', 'required_closes')}
    return {**{key: item for key, item in value.items() if key != 'receipt'},
            'research_engine_version': evidence.get('engine_version'), 'input_revision': evidence.get('input_revision'),
            'account_version': _finite_number(context.get('version')), 'symbol_policy_version': _finite_number(policy.get('version')) if isinstance(policy, dict) else None,
            'selected_symbols': evidence.get('selected_symbols'), 'coverage': coverage,
            'invested_budget_pct': evidence.get('invested_budget_pct'), 'position_cap_pct': evidence.get('position_cap_pct')}


@router.post('/api/paper/accounts/{account_id}/allocation-research-receipts/compare')
@store.snapshot_read
def compare_receipts(account_id: str, body: CompareInput):
    if body.baseline_id == body.selected_id:
        raise _problem('receipt_selection_identical', '請選擇兩筆不同收據', 422)
    with store.connect() as db:
        values = []
        for identifier, expected in ((body.baseline_id, body.expected_baseline_content_fingerprint),
                                     (body.selected_id, body.expected_selected_content_fingerprint)):
            row = _lookup(db, account_id, identifier)
            if row is None:
                raise _problem('receipt_not_found', '找不到這筆帳戶研究收據', 404)
            value = _view(db, row)
            if not value['integrity']['available']:
                raise _problem('receipt_evidence_unverifiable', '收據證據不可用；不能比較')
            if value['content_fingerprint'] != expected:
                raise _problem('receipt_content_changed', '收據識別已變更；請重新讀取歷史')
            if not _comparison_shape(value['receipt']['evidence']):
                raise _problem('receipt_comparison_shape_unavailable', '收據保留的資料結構不支援比較；歷史原值仍可讀取')
            values.append(value)
        before, after = [value['receipt']['evidence'] for value in values]
        reasons = _comparison_reasons(before, after)
        result = {'engine_version': COMPARISON_VERSION, 'account_id': account_id,
                  'baseline': _comparison_source(values[0]), 'selected': _comparison_source(values[1]),
                  'comparability': {'compatible': not reasons, 'reasons': reasons},
                  'methods': {name: _scenario_changes(before, after, name, reasons) for name in ('rank_sum', 'equal_risk_contribution')}}
        return _reply(result)
