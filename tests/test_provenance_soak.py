import importlib.util
from pathlib import Path

from alphaview.panel import store

spec = importlib.util.spec_from_file_location("provenance_soak", Path(__file__).resolve().parents[1] / "scripts/provenance_soak.py")
soak = importlib.util.module_from_spec(spec)
spec.loader.exec_module(soak)


def test_synthetic_cycle_checks_staleness_recovery_and_atomic_race(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "synthetic.db"))
    monkeypatch.setenv("ALPHAVIEW_PROVENANCE_SOAK", "1")
    as_of = soak.seed()
    result = soak.cycle(as_of)
    assert result["checks"] == 8 and result["retained_scan_rows"] == 120
    assert len(store.positions()) == 3
    assert len(store.history("SYNTA")) == 250


def test_subprocess_writer_obeys_same_input_revision_contract(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "synthetic.db"))
    monkeypatch.setenv("ALPHAVIEW_PROVENANCE_SOAK", "1")
    as_of = soak.seed()
    result = soak.cycle(as_of, subprocess_writer=True)
    assert result["writer"] == "subprocess" and result["checks"] == 8
