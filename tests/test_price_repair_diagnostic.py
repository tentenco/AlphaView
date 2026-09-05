import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

spec = importlib.util.spec_from_file_location("compare_price_repair", Path(__file__).resolve().parents[1] / "scripts" / "compare_price_repair.py")
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


def frame():
    return pd.DataFrame({"Open": [100., 100.], "High": [101., 101.], "Low": [99., 99.], "Close": [100., 100.], "Adj Close": [100., 100.], "Volume": [1000., 1000.]}, index=pd.to_datetime(["2024-01-02", "2024-01-03"]))


def test_nonfinite_is_explicit_issue_and_json_null():
    raw = frame()
    raw.iloc[1, 4] = np.inf
    result = diagnostic.inspect(raw)
    assert not result["quality"]["valid"]
    assert result["issues"] == [{"index": "2024-01-03 00:00:00", "column": "Adj Close", "reason": "missing_or_nonfinite"}]
    assert json.loads(diagnostic.encode(result))["rows"][1]["values"]["Adj Close"] is None


def test_adjustment_diff_detected_even_when_repaired_flag_false():
    raw, repaired = frame(), frame()
    repaired.iloc[0, 4] = 99
    repaired["Repaired?"] = False
    left, right = diagnostic.inspect(raw), diagnostic.inspect(repaired)
    comparison = diagnostic.compare(left, right)
    assert comparison["changed_value_count"] == 1
    assert any(row["column"] == "Adj Close" for row in comparison["differences"])
    assert left["sha256"] != right["sha256"]


def test_added_missing_dates_and_duplicate_rows_preserved():
    raw, repaired = frame(), frame()
    repaired.index = pd.to_datetime(["2024-01-03", "2024-01-04"])
    comparison = diagnostic.compare(diagnostic.inspect(raw), diagnostic.inspect(repaired))
    assert comparison["added_dates"] == ["2024-01-04"]
    assert comparison["missing_dates"] == ["2024-01-02"]
    duplicate = pd.concat([raw, raw.iloc[:1]])
    checked = diagnostic.inspect(duplicate)
    assert len(checked["rows"]) == 3 and not checked["quality"]["valid"]
    assert any(row["column"] == "__duplicate_rows__" for row in diagnostic.compare(checked, diagnostic.inspect(raw))["differences"])


def test_evidence_cannot_be_overwritten(tmp_path):
    path = tmp_path / "evidence.json"
    diagnostic.write_new(path, {"first": True})
    with pytest.raises(FileExistsError):
        diagnostic.write_new(path, {"first": False})
    assert json.loads(path.read_text()) == {"first": True}


def test_parent_timeout_records_failure_without_adoption(tmp_path, monkeypatch):
    import subprocess
    folder = tmp_path / "report"
    monkeypatch.setattr(diagnostic.sys, "argv", ["compare", "SPY", "--output-dir", str(folder), "--per-symbol-seconds", "1"])
    def timed_out(command, log, timeout, marker):
        assert timeout <= 1
        return "timeout", None
    monkeypatch.setattr(diagnostic, "run_worker", timed_out)
    diagnostic.main()
    result = json.loads((folder / "manifest.json").read_text())
    assert result["outcomes"] == [{"symbol": "SPY", "status": "timeout"}]
    assert result["adopted"] is False


def test_expired_harness_deadline_starts_no_download(tmp_path, monkeypatch):
    folder = tmp_path / "report"
    monkeypatch.setattr(diagnostic.sys, "argv", ["compare", "SPY", "--output-dir", str(folder), "--stop-at", "2020-01-01T00:00:00+00:00"])
    monkeypatch.setattr(diagnostic, "run_worker", lambda *args, **kwargs: pytest.fail("No request may start after deadline"))
    diagnostic.main()
    result = json.loads((folder / "manifest.json").read_text())
    assert result["outcomes"] == [{"symbol": "SPY", "status": "not_started_deadline"}]


def test_stop_marker_terminates_active_worker(tmp_path, monkeypatch):
    from unittest.mock import Mock
    marker = tmp_path / "STOP"
    marker.touch()
    process = Mock()
    process.poll.return_value = None
    monkeypatch.setattr(diagnostic.subprocess, "Popen", lambda *args, **kwargs: process)
    assert diagnostic.run_worker(["unused"], None, 1, marker) == ("stopped", None)
    process.kill.assert_called_once()
    process.wait.assert_called_once()


def test_stop_marker_prevents_new_requests(tmp_path, monkeypatch):
    marker = tmp_path / "STOP"
    marker.touch()
    folder = tmp_path / "output"
    monkeypatch.setattr(diagnostic.sys, "argv", ["compare", "SPY", "--output-dir", str(folder), "--stop-marker", str(marker)])
    monkeypatch.setattr(diagnostic, "run_worker", lambda *args: pytest.fail("STOP must prevent requests"))
    diagnostic.main()
    assert json.loads((folder / "manifest.json").read_text())["outcomes"][0]["status"] == "not_started_stop_marker"


@pytest.mark.parametrize("columns", [["Open", "Open"], [1, "1"]])
def test_duplicate_columns_and_string_collisions_are_rejected(columns):
    source = pd.DataFrame([[1, 2]], columns=columns, index=pd.to_datetime(["2024-01-02"]))
    with pytest.raises(ValueError, match="Duplicate column labels"):
        diagnostic.inspect(source)
