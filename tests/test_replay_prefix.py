"""Synthetic R0 causality, coverage, finite-output, and isolation evidence."""
from copy import deepcopy
from datetime import date
import json

import numpy as np
import pandas as pd
import pytest

from alphaview.panel import market, replay_prefix, research, sessions, store


def bars(count=220, *, end=150., start="2024-01-02"):
    dates = sessions.expected_sessions(start, "2026-12-31")[:count]
    close = np.linspace(100., end, count)
    return pd.DataFrame({"date": dates, "open": close * .999, "high": close * 1.001,
                         "low": close * .998, "close": close, "adj_close": close,
                         "volume": np.full(count, 100.)})


def identities(pool):
    return {symbol: {"source": "synthetic-v1", "currency": "USD", "exchange": "XNYS"}
            for symbol in pool}


def evaluate(pool, as_of, identity=None):
    return replay_prefix.evaluate_prefix(pool, as_of, identities=identity or identities(pool))


@pytest.fixture(autouse=True)
def no_workspace_or_provider(monkeypatch, tmp_path):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "must-not-be-created.sqlite"))

    def forbidden(*args, **kwargs):
        raise AssertionError("Pure prefix evaluator accessed workspace, provider, or current clock")

    for name in ("connect", "input_revision", "now", "universe", "history"):
        monkeypatch.setattr(store, name, forbidden)
    monkeypatch.setattr(market, "fetch_symbol", forbidden)
    monkeypatch.setattr(research, "scan", forbidden)
    monkeypatch.setattr(sessions, "latest_completed_session", forbidden)
    yield
    assert not (tmp_path / "must-not-be-created.sqlite").exists()


@pytest.mark.parametrize("last_index", [0, 13, 20, 119, 120, 199, 204])
def test_full_capture_equals_independently_cut_raw_inputs(last_index):
    pool = {"A": bars(end=120), "B": bars(end=140), "C": bars(end=140), "D": bars(end=180)}
    as_of = pool["A"].date.iloc[last_index]
    independently_cut = {symbol: frame.loc[frame.date <= as_of].copy() for symbol, frame in pool.items()}
    actual = evaluate(pool, as_of)
    assert actual == evaluate(independently_cut, as_of)
    expected = research.evaluate({symbol: research.indicators(frame) for symbol, frame in independently_cut.items()}, as_of)
    for row, expected_row in zip(actual["symbols"], expected):
        assert {key: row[key] for key in ("symbol", "date", "bars", "indicators", "signals")} == expected_row


def test_dated_future_append_delete_mutate_cannot_change_result_or_fingerprint():
    pool = {"A": bars(end=130), "B": bars(end=150), "C": bars(end=170)}
    as_of = pool["A"].date.iloc[204]
    expected = evaluate(pool, as_of)
    modified = {}
    for symbol, source in pool.items():
        frame = source.astype(object).copy()
        for column in ("open", "high", "low", "close", "adj_close", "volume"):
            frame.loc[frame.date > as_of, column] = "unusable future value" if column == "open" else np.inf
        # Even an unsupported object is immaterial once its valid date is future.
        frame.at[219, "volume"] = {"future": object()}
        modified[symbol] = frame
    assert evaluate(modified, as_of) == expected
    deleted = {symbol: frame.loc[frame.date <= as_of].copy() for symbol, frame in pool.items()}
    assert evaluate(deleted, as_of) == expected
    appended = {symbol: pd.concat([frame, frame.iloc[-1:].assign(date="9999-12-31", close=np.nan)], ignore_index=True)
                for symbol, frame in pool.items()}
    assert evaluate(appended, as_of) == expected


def test_past_changes_and_identity_changes_change_prefix_identity():
    pool = {"A": bars(), "B": bars(end=130), "C": bars(end=170)}
    as_of = pool["A"].date.iloc[204]
    expected = evaluate(pool, as_of)
    changed = {symbol: frame.copy() for symbol, frame in pool.items()}
    changed["A"].loc[0, "volume"] += 1
    assert evaluate(changed, as_of)["fingerprint"] != expected["fingerprint"]
    changed["A"].loc[0, "close"] = -1
    invalid = evaluate(changed, as_of)
    assert invalid["fingerprint"] != expected["fingerprint"]
    assert invalid["symbols"][0]["signals"][0]["status"] == "data_error"
    identity = identities(pool)
    identity["A"]["source"] = "synthetic-v2"
    assert evaluate(pool, as_of, identity)["fingerprint"] != expected["fingerprint"]


def test_symbol_row_column_order_and_pandas_dtype_do_not_change_output_or_inputs():
    pool = {"A": bars(), "B": bars(end=130), "C": bars(end=170)}
    originals = {symbol: frame.copy(deep=True) for symbol, frame in pool.items()}
    identity = identities(pool)
    saved_identity = deepcopy(identity)
    as_of = pool["A"].date.iloc[204]
    expected = evaluate(pool, as_of, identity)
    reordered = {symbol: pool[symbol].sample(frac=1, random_state=17).loc[:, list(reversed(pool[symbol].columns))].astype(object)
                 for symbol in reversed(pool)}
    reordered["A"]["derived_future_signal"] = True
    reordered["A"].attrs["data_quality"] = {"valid": False, "issues": [{"date": None, "reason": "ignored caller attr"}]}
    assert evaluate(reordered, as_of, dict(reversed(list(identity.items())))) == expected
    for symbol in pool:
        pd.testing.assert_frame_equal(pool[symbol], originals[symbol])
    assert identity == saved_identity


def test_expanding_rsi_prefix_is_not_replaced_with_last_200_rows():
    source = bars(400)
    close = 100 + np.cumsum(np.sin(np.arange(400)) * 3 + .1)
    for column, multiple in {"open": .999, "high": 1.001, "low": .998, "close": 1, "adj_close": 1}.items():
        source[column] = close * multiple
    as_of = source.date.iloc[-1]
    result = evaluate({"A": source}, as_of)["symbols"][0]
    assert result["bars"] == 400
    assert result["indicators"]["rsi"] == research.finite(research.indicators(source).rsi.iloc[-1])
    assert result["first_observed_session"] == source.date.iloc[0]


def test_coverage_separates_requested_valid_current_complete_and_rps_peers():
    source = bars(121)
    as_of = source.date.iloc[-1]
    pool = {symbol: source.assign(close=[100.] * 120 + [last], adj_close=[100.] * 120 + [last],
                                  open=[99.] * 120 + [last * .99], high=[101.] * 120 + [last * 1.01],
                                  low=[98.] * 120 + [last * .98])
            for symbol, last in {"A": 110., "B": 120., "C": 120., "D": 130.}.items()}
    pool["STALE"] = source.iloc[:-1].copy()
    pool["SHORT"] = source.iloc[-20:].copy()
    pool["EMPTY"] = source.iloc[:0].copy()
    pool["BAD"] = source.copy()
    pool["BAD"].loc[120, "low"] = 1000
    result = evaluate(pool, as_of)
    coverage = result["coverage"]
    assert {key: coverage[key] for key in ("requested", "valid", "current", "complete", "rps_peers")} == {
        "requested": 8, "valid": 6, "current": 5, "complete": 0, "rps_peers": 4}
    assert coverage["strategies"] == {"turtle": 4, "trend": 0, "pullback": 0, "rps": 4}
    assert coverage["rps_peer_symbols"] == ["A", "B", "C", "D"]
    rows = {row["symbol"]: row for row in result["symbols"]}
    assert [rows[symbol]["indicators"]["rps"] for symbol in "ABCD"] == [25., 62.5, 62.5, 100.]
    assert {item["status"] for item in rows["STALE"]["missing_reasons"]} == {"stale"}
    assert {item["status"] for item in rows["BAD"]["missing_reasons"]} == {"data_error"}
    assert {item["status"] for item in rows["EMPTY"]["missing_reasons"]} == {"insufficient"}


def test_complete_and_rps_insufficient_peer_counts_are_explicit():
    pool = {"A": bars(), "B": bars(end=160), "C": bars(end=170)}
    as_of = pool["A"].date.iloc[-1]
    complete = evaluate(pool, as_of)
    assert complete["coverage"]["complete"] == 3
    del pool["C"]
    insufficient = evaluate(pool, as_of)
    assert insufficient["coverage"]["rps_peers"] == 2
    assert insufficient["coverage"]["complete"] == 0
    assert all(row["missing_reasons"][0]["strategy"] == "rps" for row in insufficient["symbols"])


@pytest.mark.parametrize("raw_date", [None, "not-a-date", "2024-02-30", "2024-1-02",
                                      pd.Timestamp("2024-01-02"), date(2024, 1, 2), date(2025, 1, 2),
                                      np.datetime64("2025-01-02")])
def test_unknown_date_errors_stay_unavailable_even_if_appended_after_capture(raw_date):
    source = bars()
    as_of = source.date.iloc[204]
    bad = pd.concat([source, source.iloc[-1:].assign(date=raw_date)], ignore_index=True)
    result = evaluate({"A": bad}, as_of)
    row = result["symbols"][0]
    assert result["coverage"]["valid"] == result["coverage"]["rps_peers"] == 0
    assert row["quality"]["status"] == "data_error"
    assert any(issue["date"] is None for issue in row["quality"]["issues"])
    assert {signal["status"] for signal in row["signals"]} == {"data_error"}
    assert result["fingerprint"] != evaluate({"A": source}, as_of)["fingerprint"]


@pytest.mark.parametrize("defect", ["missing-column", "duplicate", "gap", "weekend", "nan", "infinity", "negative"])
def test_invalid_prefix_is_unavailable_with_finite_json_and_deterministic_order(defect):
    source = bars()
    as_of = source.date.iloc[-1]
    if defect == "missing-column":
        source = source.drop(columns="close")
    elif defect == "duplicate":
        source = pd.concat([source, source.iloc[:1]], ignore_index=True)
    elif defect == "gap":
        source = source.drop(index=20)
    elif defect == "weekend":
        source.loc[1, "date"] = "2024-01-06"
    else:
        source.loc[20, "close"] = {"nan": np.nan, "infinity": np.inf, "negative": -1}[defect]
    result = evaluate({"A": source}, as_of)
    assert result["symbols"][0]["quality"]["status"] == "data_error"
    assert result == evaluate({"A": source.sample(frac=1, random_state=3)}, as_of)
    json.dumps(result, allow_nan=False)


def test_nonfinite_derived_metrics_never_enter_peer_ranks_or_json():
    source = bars(220)
    source.loc[:98, ["open", "high", "low", "close", "adj_close"]] = 1e-300
    source.loc[99:, ["open", "high", "low", "close", "adj_close"]] = 1e300
    pool = {symbol: source.copy() for symbol in ("A", "B", "C")}
    result = evaluate(pool, source.date.iloc[200])
    assert result["coverage"]["rps_peers"] == 0
    assert result["coverage"]["strategies"]["rps"] == 0
    assert all(row["indicators"]["return120"] is None for row in result["symbols"])
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("as_of", ["2024-03-08", "2024-03-11", "2024-11-01", "2024-11-04", "2024-11-29"])
def test_dst_and_early_close_use_explicit_session_labels(as_of):
    source = bars(250)
    result = evaluate({"A": source}, as_of)
    assert result["as_of"] == result["symbols"][0]["date"] == as_of
    assert result["symbols"][0]["bars"] == len(source.loc[source.date <= as_of])


@pytest.mark.parametrize("as_of", ["2024-03-10", "2024-07-04", "2024-11-28", "2024-2-01", "2024-02-30", "1989-12-29", "2101-01-03"])
def test_non_sessions_and_unsupported_request_dates_are_rejected(as_of):
    with pytest.raises(ValueError, match="as_of"):
        evaluate({"A": bars()}, as_of)


def test_admission_bounds_identity_and_calendar_span_are_explicit(monkeypatch):
    source = bars(3)
    as_of = source.date.iloc[-1]
    with pytest.raises(ValueError, match="1..50"):
        evaluate({}, as_of)
    with pytest.raises(ValueError, match="uppercase"):
        evaluate({"a": source}, as_of)
    with pytest.raises(ValueError, match="exactly match"):
        replay_prefix.evaluate_prefix({"A": source}, as_of, identities={})
    with pytest.raises(ValueError, match="exactly source"):
        evaluate({"A": source}, as_of, {"A": {"source": "synthetic"}})
    with pytest.raises(ValueError, match="unique columns"):
        evaluate({"A": pd.concat([source, source[["close"]]], axis=1)}, as_of)
    monkeypatch.setattr(replay_prefix, "MAX_CAPTURE_ROWS", 2)
    with pytest.raises(ValueError, match="exceeds 2 rows"):
        evaluate({"A": source}, as_of)
    monkeypatch.setattr(replay_prefix, "MAX_CAPTURE_ROWS", 500_000)
    source.loc[0, "date"] = "2010-01-04"
    result = evaluate({"A": source}, as_of)
    assert result["symbols"][0]["quality"]["status"] == "data_error"
    assert "six-year" in result["symbols"][0]["quality"]["issues"][0]["reason"]


def test_issue_output_and_scalar_cells_are_bounded():
    source = bars(30)
    as_of = source.date.iloc[-1]
    source["date"] = "unknown"
    result = evaluate({"A": source}, as_of)
    quality = result["symbols"][0]["quality"]
    assert quality["invalid_count"] == 30
    assert len(quality["issues"]) == replay_prefix.MAX_ISSUE_EXAMPLES
    assert quality["issues_truncated"]
    source.loc[0, "date"] = "x" * 257
    with pytest.raises(ValueError, match="exceeds 256"):
        evaluate({"A": source}, as_of)
    source.loc[0, "date"] = "unknown"
    source = source.astype(object)
    source.at[0, "close"] = {"not": "a scalar"}
    with pytest.raises(ValueError, match="must be scalar"):
        evaluate({"A": source}, as_of)


def test_methods_and_fixed_pool_are_part_of_identity(monkeypatch):
    pool = {"A": bars(), "B": bars(end=160), "C": bars(end=170)}
    as_of = pool["A"].date.iloc[-1]
    result = evaluate(pool, as_of)
    assert result["engine_version"] == replay_prefix.ENGINE_VERSION
    assert result["calendar"] == "XNYS"
    assert all(result[key] for key in ("schema_version", "fingerprint_version", "scan_engine_version", "exchange_calendars_version"))
    monkeypatch.setattr(replay_prefix, "SCAN_ENGINE_VERSION", "synthetic-test-method-v2")
    assert evaluate(pool, as_of)["fingerprint"] != result["fingerprint"]
    monkeypatch.setattr(replay_prefix, "SCAN_ENGINE_VERSION", result["scan_engine_version"])
    assert evaluate({"A": pool["A"]}, as_of)["fingerprint"] != result["fingerprint"]
    assert not {"targets", "orders", "nav", "return", "performance"}.intersection(result)


def test_lossy_integer_and_numeric_text_changes_remain_part_of_raw_identity():
    source = bars(1)
    as_of = source.date.iloc[0]
    source["volume"] = pd.Series([2 ** 53], dtype="int64")
    expected = evaluate({"A": source}, as_of)
    source.loc[0, "volume"] += 1
    assert evaluate({"A": source}, as_of)["fingerprint"] != expected["fingerprint"]
    # Text spellings are raw input, including text that overflows float64.
    source = source.astype(object)
    source.at[0, "volume"] = "1e999"
    first = evaluate({"A": source}, as_of)
    source.at[0, "volume"] = "2e999"
    second = evaluate({"A": source}, as_of)
    assert first["fingerprint"] != second["fingerprint"]
    assert first["symbols"][0]["quality"]["status"] == second["symbols"][0]["quality"]["status"] == "data_error"
    source.at[0, "volume"] = 2 ** 1023 + 1
    large = evaluate({"A": source}, as_of)
    source.at[0, "volume"] += 1
    assert evaluate({"A": source}, as_of)["fingerprint"] != large["fingerprint"]
    source.at[0, "volume"] = 2 ** 1024 - 1
    overflowing = evaluate({"A": source}, as_of)
    source.at[0, "volume"] -= 1
    assert evaluate({"A": source}, as_of)["fingerprint"] != overflowing["fingerprint"]
    assert overflowing["symbols"][0]["quality"]["status"] == "data_error"
    json.dumps(overflowing, allow_nan=False)
    source.at[0, "volume"] = 2 ** 1_000_000
    with pytest.raises(ValueError, match="1024-bit"):
        evaluate({"A": source}, as_of)


@pytest.mark.parametrize("derived_only", [False, True])
def test_no_recognized_columns_preserves_undatable_observation_count_and_identity(derived_only):
    fingerprints = set()
    for count in (0, 1, 3):
        source = pd.DataFrame({"derived": [True] * count}) if derived_only else pd.DataFrame(index=range(count))
        result = evaluate({"A": source}, "2024-01-02")
        row = result["symbols"][0]
        assert row["quality"]["status"] == "data_error"
        assert row["bars"] == row["quality"]["checked_rows"] == row["quality"]["invalid_count"] == count
        assert row["quality"]["issues"][0]["date"] is None
        fingerprints.add(result["fingerprint"])
    assert len(fingerprints) == 3
