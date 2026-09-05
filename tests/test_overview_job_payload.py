import json

from fastapi.testclient import TestClient

from alphaview.panel import store
from alphaview.panel.api import app


def test_overview_omits_large_job_result_without_deleting_persisted_detail(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "panel.db"))
    payload = json.dumps({"audit_sentinel": "large-result-" * 20000})
    public = {
        "id": "payload-test", "kind": "refresh", "status": "partial",
        "started_at": "2026-09-05T00:00:00+00:00", "finished_at": "2026-09-05T00:01:00+00:00",
        "progress": "已更新 999 檔", "error": "一檔缺少行情", "scope": "market", "cancel_requested": 0,
    }
    with TestClient(app) as client:
        with store.connect() as db:
            db.execute("INSERT INTO jobs(id,kind,status,started_at,finished_at,progress,error,scope,cancel_requested,result) VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (*public.values(), payload))
        response = client.get("/api/overview")
        assert response.status_code == 200
        assert response.json()["jobs"] == [public]
        assert "audit_sentinel" not in response.text
        with store.connect() as db:
            assert db.execute("SELECT result FROM jobs WHERE id=?", (public["id"],)).fetchone()["result"] == payload
