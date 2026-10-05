"""Read-time proposal provenance: derived from stored evidence only, never stored, never guessed."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alphaview.panel import paper_portfolio as paper, sessions, store

SESSION = "2024-01-05"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "provenance.db"))
    monkeypatch.setattr(sessions, "latest_completed_session", lambda at=None: SESSION)
    store.init_db()
    with store.connect() as db:
        db.execute("INSERT INTO datasets(symbol,currency,status,last_date) VALUES ('SYNTH','USD','ok',?)", (SESSION,))
        db.execute("INSERT OR REPLACE INTO bars VALUES ('SYNTH',?,100,101,99,100,100,1000)", (SESSION,))
    app = FastAPI()
    app.include_router(paper.router)
    with TestClient(app) as value:
        yield value


def view(**changes):
    return {"rationale": "", "automation_source": None, "violations": [], "notices": [], "status": "proposed", **changes}


def test_manual_proposal_has_manual_source_and_no_tags(client):
    account = client.post("/api/paper/accounts", json={"name": "Synthetic", "initial_cash": 10000, "idempotency_key": "prov-account"}).json()["account"]
    revision = store.input_revision()
    created = client.post(f"/api/paper/accounts/{account['id']}/proposals", json={
        "expected_version": account["version"], "targets": [{"symbol": "SYNTH", "weight_pct": 30}], "idempotency_key": "prov-manual-01"}).json()
    assert created["provenance"] == {"engine_version": "alphaview-proposal-provenance-v1", "source": "manual", "tags": []}
    snapshot = client.get(f"/api/paper/accounts/{account['id']}").json()
    assert snapshot["proposals"][0]["provenance"] == created["provenance"]
    with store.connect() as db:
        stored = json.loads(db.execute("SELECT preview_json FROM paper_proposals").fetchone()[0])
    assert "provenance" not in stored
    assert paper._fingerprint(stored) == paper._fingerprint({k: v for k, v in created.items() if k in stored})
    assert store.input_revision() == revision
    json.dumps(created, allow_nan=False)


def test_position_stop_and_bridge_rationales_are_recognised():
    stop = paper.provenance(view(rationale="Position stops alphaview-position-stops-v1；2024-01-05；觸發：SYNTH（stop_loss）"))
    assert (stop["source"], stop["tags"]) == ("position_stops", ["position_stop"])
    note = json.dumps({"v": "alphaview-validation-v1", "mode": "require_pass", "gate": "overridden", "overall": "fail",
                       "counts": {"pass": 0, "warn": 0, "fail": 1, "unavailable": 0}, "verdicts": {"SYNTH": "fail"}}, ensure_ascii=False, separators=(",", ":"))
    bridge = paper.provenance(view(rationale=f"Research Desk 策略 SMA 交叉 5/20；alphaview-strategy-bridge-v1；訊號日 2024-01-05；{{}}；validation={note}"))
    assert (bridge["source"], bridge["tags"]) == ("strategy_bridge", ["validation:overridden"])
    for gate in ("pass", "warn"):
        assert f"validation:{gate}" in paper.provenance(view(rationale=f"Research Desk 策略 X；v；訊號日 d；{{}}；validation={{\"gate\":\"{gate}\"}}"))["tags"]
    assert paper.provenance(view(rationale="Research Desk 策略 X；v；訊號日 d；{}；validation=off"))["tags"] == ["validation:off"]
    assert paper.provenance(view(rationale="Research Desk 策略 X；v；訊號日 d；{}；validation={broken"))["tags"] == []


def test_automation_evidence_markers_become_tags():
    rationale = ("本機規則 Agent run r1；alphaview-portfolio-agent-v2；選股 2024-01-05，3 檔風險感知配置（inverse_volatility，alphaview-allocator-v1），"
                 "保留現金 10%；proposal fingerprint abc。完整角色理由與拒絕原因保存於 Agent 工作流。 自動化任務 m1 v2。"
                 " 目標已經 Jev 決策閘過濾，未通過的標的歸零保留現金。市場風險覆蓋 alphaview-regime-overlay-v1：總曝險 90.00%→60.00%（elevated，上限 60%）。"
                 "純減倉模式 alphaview-reduce-only-v1（paused）：目標不得高於目前權重，1 個新標的已略去。")
    result = paper.provenance(view(rationale=rationale, automation_source={"mandate_id": "m1", "mandate_version": 2, "attempt_id": "a1"},
                                   status="submitted_external", notices=[{"code": "corporate_action_since_entry", "message": "x"}]))
    assert result["source"] == "automation"
    assert result["tags"] == ["allocator:inverse_volatility", "corporate_action_notice", "execution:alpaca_paper", "jev_gate",
                              "reduce_only", "regime_overlay:scale"]
    workflow = paper.provenance(view(rationale="本機規則 Agent run r2；v；選股 2024-01-05，2 檔固定配置，保留現金 10%；proposal fingerprint x。"))
    assert (workflow["source"], workflow["tags"]) == ("rules_workflow", ["allocator:equal"])
    blocked = paper.provenance(view(violations=[{"code": "regime_exposure_cap", "message": "over"}]))
    assert blocked == {"engine_version": "alphaview-proposal-provenance-v1", "source": "manual", "tags": ["regime_overlay:block"]}
    jev = paper.provenance(view(jev_source={"run_id": "j1", "engine_version": "alphaview-jev-decision-v1"}))
    assert (jev["source"], jev["tags"]) == ("jev", ["jev_gate"])
    local = paper.provenance(view(local_agent_source={"analysis_id": "l1", "engine_version": "alphaview-local-agent-v1"}))
    assert (local["source"], local["tags"]) == ("local_agent", [])
    assert paper.provenance(view(rationale="我自己的理由，固定配置"))["tags"] == []
    json.dumps(result, allow_nan=False)
