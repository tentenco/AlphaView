"""CSV export and setup_quality rank correlation of the decision outcome ledger on synthetic rows."""
import csv
import io
import json

from alphaview.panel import decision_ledger as ledger, store
from tests.test_decision_ledger import S1, S2, forward, insert_jev, insert_scan, setup  # noqa: F401  (fixture re-export)


def insert_jev_scored(db, identifier, as_of, decisions, created="synthetic"):
    """Like insert_jev, with a setup_quality score block per decision (None = question absent)."""
    payload = []
    for symbol, gate, checks, score in decisions:
        decision = {"symbol": symbol, "status": gate, "checks": [{"question": q, "value": v} for q, v in checks.items()]}
        if score is not None:
            decision["setup_quality"] = {"type": "score", "score": score, "confidence": 0.8, "probabilities": {}, "legend": {}}
        payload.append(decision)
    db.execute("""INSERT INTO jev_decision_runs(id,idempotency_key,request_hash,source_run_id,engine_version,question_set_version,status,
        created_at,as_of,input_revision,model_requested,model_answered,request_json,source_json,state_json,questions_json,request_digest,
        answers_json,usage_json,latency_ms,result_json,error_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
               (identifier, f"key-{identifier}", "hash", "run", "alphaview-jev-decision-v1", "alphaview-jev-questions-v1", "completed",
                created, as_of, "synthetic", "jev-1.13.0", "jev-1.13.0", "{}", "{}", "{}", "{}", "digest", None, None, None,
                json.dumps({"decisions": payload}), None))


def rows_of(response):
    assert response.status_code == 200, response.text
    reader = csv.DictReader(io.StringIO(response.text))
    return reader.fieldnames, list(reader)


def test_csv_has_header_blank_pending_cells_formula_guard_and_headers(setup):
    with store.connect() as db:
        insert_scan(db, S1, "market", [("SYNTA", "turtle")])
        insert_scan(db, S2, "market", [("SYNTA", "turtle"), ("=SYNTX", "trend")])
    revision = store.input_revision()
    response = setup["client"].get("/api/trading-agent/outcomes.csv?horizon_sessions=5")
    columns, rows = rows_of(response)
    assert columns == ledger.CSV_COLUMNS
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-disposition"].startswith('attachment; filename="decision-outcomes-')
    by_key = {(row["symbol"], row["decision_session"]): row for row in rows}
    settled = by_key[("SYNTA", S1)]
    assert settled["status"] == "settled" and settled["return_pct"] == str(forward("SYNTA", S1, 5)) and settled["hit"] == "true"
    assert settled["excess_pct"] != "" and settled["benchmark"] == "SPY" and settled["horizon_sessions"] == "5"
    pending = by_key[("SYNTA", S2)]
    assert pending["status"] == "pending" and pending["reason"] == "horizon_not_elapsed"
    assert pending["entry_session"] != "" and pending["exit_session"] == ""
    assert (pending["return_pct"], pending["excess_pct"], pending["benchmark_return_pct"], pending["hit"]) == ("", "", "", "")
    guarded = by_key[("'=SYNTX", S2)]
    assert guarded["status"] == "pending" and guarded["decision"] == "trend"
    assert all(row["engine_version"] == ledger.ENGINE_VERSION and row["input_revision"] == revision for row in rows)
    assert store.input_revision() == revision
    assert setup["client"].get("/api/trading-agent/outcomes.csv?horizon_sessions=7").status_code == 422


def test_jev_rows_carry_probabilities_realizations_and_setup_quality_correlation(setup):
    with store.connect() as db:
        insert_jev_scored(db, "jev-s1", S1, [("SYNTA", "pass", {"overextended": 0.1, "uptrend_intact": 0.9}, 80.0),
                                             ("SYNTB", "fail", {"overextended": 0.7}, 40.0)])
        insert_jev_scored(db, "jev-s2", S2, [("SYNTA", "pass", {"overextended": 0.2}, 70.0)])
    client = setup["client"]
    columns, rows = rows_of(client.get("/api/trading-agent/outcomes.csv?horizon_sessions=5"))
    jev = {(row["symbol"], row["decision_session"]): row for row in rows if row["family"] == "jev_gate"}
    assert jev[("SYNTA", S1)]["jev_overextended_probability"] == "0.1" and jev[("SYNTA", S1)]["jev_overextended_realized"] == "false"
    assert jev[("SYNTB", S1)]["jev_overextended_probability"] == "0.7" and jev[("SYNTB", S1)]["jev_overextended_realized"] == "true"
    assert jev[("SYNTA", S1)]["jev_uptrend_intact_realized"] == "true" and jev[("SYNTB", S1)]["jev_uptrend_intact_probability"] == ""
    assert jev[("SYNTA", S1)]["jev_setup_quality_score"] == "80.0" and jev[("SYNTA", S2)]["jev_overextended_realized"] == ""
    data = client.get("/api/trading-agent/outcomes?horizon_sessions=5").json()
    json.dumps(data, allow_nan=False)
    correlation = data["calibration"]["score_correlation"]
    # Higher setup_quality (SYNTA 80, rising) earned the higher realized return than SYNTB (40, falling): perfect rank agreement.
    assert correlation == {**correlation, "status": "available", "n": 2, "n_pending": 1, "n_unavailable": 0,
                           "spearman": 1.0, "low_sample": True, "reason": None, "question": "setup_quality"}
    item = next(item for item in data["items"] if item["family"] == "jev_gate" and item["symbol"] == "SYNTB")
    assert item["realizations"] == {"overextended": {"realized": True, "reason": None}} and item["setup_quality_score"] == 40.0


def test_score_correlation_is_unavailable_without_scores_or_settled_items(setup):
    with store.connect() as db:
        insert_jev(db, "jev-s1", S1, [("SYNTA", "pass", {"overextended": 0.1})])
    absent = setup["client"].get("/api/trading-agent/outcomes?horizon_sessions=5").json()["calibration"]["score_correlation"]
    assert absent["status"] == "unavailable" and absent["reason"] == "question_absent" and absent["spearman"] is None
    with store.connect() as db:
        insert_jev_scored(db, "jev-s2", S2, [("SYNTA", "pass", {}, 55.0)])
    pending = setup["client"].get("/api/trading-agent/outcomes?horizon_sessions=5").json()["calibration"]["score_correlation"]
    assert pending["status"] == "unavailable" and pending["reason"] == "insufficient_settled" and pending["n_pending"] == 1
    assert ledger._spearman([1.0, 2.0, 3.0], [3.0, 2.0, 1.0]) == -1.0
    assert ledger._spearman([1.0, 1.0, 2.0], [1.0, 2.0, 3.0]) == 0.8660254037844387
    assert ledger._spearman([1.0, 1.0], [1.0, 2.0]) is None
