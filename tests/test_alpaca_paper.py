"""Alpaca connection fixtures are synthetic; no provider requests or real keys."""
import json
import os
from unittest.mock import MagicMock

import pytest
import requests
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from alphaview.panel import alpaca_paper as alpaca, store

KEY = "PKSYNTHETIC0000000000"
SECRET = "synthetic-secret-for-tests-only"
ACCOUNT = {"id": "synthetic-paper-account", "account_number": "SYNTHETIC", "status": "ACTIVE",
           "currency": "USD", "cash": "1234.000001", "equity": "2345.67", "buying_power": "4691.34"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PANEL_DB_PATH", str(tmp_path / "isolated.db"))
    monkeypatch.delenv("ALPHAVIEW_ALPACA_CREDENTIALS_PATH", raising=False)
    store.init_db()
    app = FastAPI()
    app.include_router(alpaca.router)
    # An accidental unmocked network request must fail locally.
    monkeypatch.setattr(requests.Session, "get", lambda *args, **kwargs: pytest.fail("Unexpected network request"))
    with TestClient(app) as value:
        yield value


def connect(client, monkeypatch, **extra):
    monkeypatch.setattr(alpaca, "_get", lambda *args, **kwargs: dict(ACCOUNT))
    result = client.post("/api/alpaca-paper/connection", json={"api_key": KEY, "secret_key": SECRET, **extra})
    assert result.status_code == 200, result.text
    return result.json()


def provider(config, path, params=None):
    return {"/v2/account": dict(ACCOUNT), "/v2/positions": [
        {"asset_id": "synthetic-asset", "symbol": "SYNTH", "qty": "1.000000001", "avg_entry_price": "NaN"}
    ], "/v2/orders": [{"id": "synthetic-order", "symbol": "SYNTH", "qty": "2", "filled_qty": "0",
                         "status": "new", "secret_extra": SECRET}],
        "/v2/clock": {"is_open": False, "timestamp": "2024-01-06T12:00:00Z", "next_open": "2024-01-08T09:30:00-05:00"}}[path]


def test_setup_reads_are_offline_and_do_not_expose_credentials(client, monkeypatch):
    assert client.get("/api/alpaca-paper/connection").json()["configured"] is False
    assert client.get("/api/alpaca-paper/snapshot").status_code == 409
    revision = store.input_revision()
    result = connect(client, monkeypatch)
    path = alpaca.credential_path()
    assert path.parent == store.db_path().parent
    assert path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text())["secret_key"] == SECRET
    public = client.get("/api/alpaca-paper/connection")
    assert public.headers["cache-control"] == "no-store"
    assert public.json()["configured"] is True
    assert public.json()["orders_enabled"] is False
    assert KEY not in public.text and SECRET not in public.text
    assert SECRET not in json.dumps(result) and KEY not in json.dumps(result)
    assert store.input_revision() == revision


@pytest.mark.parametrize("change", [
    {"api_key": "AKSYNTHETIC0000000000"}, {"secret_key": "too-short"},
    {"endpoint": "https://api.alpaca.markets"}, {"extra_secret": SECRET},
    {"expected_version": [SECRET]}, {"secret_key": "s" * 5000},
])
def test_invalid_setup_never_echoes_input_or_writes(client, change):
    result = client.post("/api/alpaca-paper/connection", json={"api_key": KEY, "secret_key": SECRET, **change})
    assert result.status_code == 422
    assert KEY not in result.text and SECRET not in result.text
    assert not alpaca.credential_path().exists()


def test_failed_rotation_and_version_conflict_preserve_existing_connection(client, monkeypatch):
    saved = connect(client, monkeypatch)
    before = alpaca.credential_path().read_bytes()
    assert client.post("/api/alpaca-paper/connection", json={"api_key": KEY, "secret_key": SECRET}).status_code == 409
    def reject(*args, **kwargs):
        raise alpaca._problem("authentication_failed", "Synthetic denial", 401)
    monkeypatch.setattr(alpaca, "_get", reject)
    result = client.post("/api/alpaca-paper/connection", json={"api_key": KEY, "secret_key": SECRET, "expected_version": saved["version"]})
    assert result.status_code == 401
    assert alpaca.credential_path().read_bytes() == before


def test_snapshot_preserves_decimal_strings_missing_values_and_history_scope(client, monkeypatch):
    connect(client, monkeypatch)
    monkeypatch.setattr(alpaca, "_get", provider)
    revision = store.input_revision()
    response = client.get("/api/alpaca-paper/snapshot?status=open&limit=1")
    result = response.json()
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert result["engine_version"] == alpaca.ENGINE_VERSION
    assert result["coverage"] == {"available": 4, "required": 4}
    assert result["resources"]["account"]["data"]["cash"] == "1234.000001"
    position = result["resources"]["positions"]["data"]["items"][0]
    assert position["qty"] == "1.000000001"
    assert position["avg_entry_price"] is None
    assert "avg_entry_price" in position["unavailable_fields"]
    orders = result["resources"]["orders"]["data"]
    assert orders["total"] is None and orders["possibly_truncated"] is True
    assert "secret_extra" not in orders["items"][0]
    assert SECRET not in response.text
    json.dumps(result, allow_nan=False)
    assert store.input_revision() == revision


def test_partial_resource_failure_does_not_invent_empty_positions(client, monkeypatch):
    connect(client, monkeypatch)
    def partial(config, path, params=None):
        if path == "/v2/positions":
            raise alpaca._problem("network_unavailable", "Synthetic unavailable", 503)
        return provider(config, path, params)
    monkeypatch.setattr(alpaca, "_get", partial)
    result = client.get("/api/alpaca-paper/snapshot").json()
    assert result["status"] == "partial"
    assert result["coverage"]["available"] == 3
    assert result["resources"]["positions"]["data"] is None
    assert result["resources"]["orders"]["status"] == "available"


def test_changed_account_stops_other_reads(client, monkeypatch):
    connect(client, monkeypatch)
    calls = []
    def changed(config, path, params=None):
        calls.append(path)
        return {**ACCOUNT, "id": "different-synthetic-account"}
    monkeypatch.setattr(alpaca, "_get", changed)
    result = client.get("/api/alpaca-paper/snapshot").json()
    assert calls == ["/v2/account"]
    assert result["coverage"]["available"] == 0
    assert result["resources"]["account"]["error"]["code"] == "account_changed"
    assert result["resources"]["positions"]["fetched_at"] is None


def test_connection_changed_while_reading_discards_snapshot(client, monkeypatch):
    connect(client, monkeypatch)
    def changing(config, path, params=None):
        if path == "/v2/clock":
            alpaca.credential_path().unlink()
        return provider(config, path, params)
    monkeypatch.setattr(alpaca, "_get", changing)
    assert client.get("/api/alpaca-paper/snapshot").status_code == 409


def test_disconnect_removes_only_local_credentials(client, monkeypatch):
    saved = connect(client, monkeypatch)
    monkeypatch.setattr(alpaca, "_get", lambda *a, **kw: pytest.fail("Disconnect must not call provider"))
    assert client.request("DELETE", "/api/alpaca-paper/connection", json={"expected_version": "old"}).status_code == 409
    result = client.request("DELETE", "/api/alpaca-paper/connection", json={"expected_version": saved["version"]})
    assert result.status_code == 200 and result.json()["configured"] is False
    assert not alpaca.credential_path().exists()
    assert store.db_path().exists()


def test_loose_permissions_and_symlinks_are_rejected(client, monkeypatch, tmp_path):
    connect(client, monkeypatch)
    path = alpaca.credential_path()
    path.chmod(0o644)
    result = client.get("/api/alpaca-paper/connection")
    assert result.status_code == 503 and SECRET not in result.text
    path.chmod(0o600)
    target = tmp_path / "another.json"
    path.rename(target)
    path.symlink_to(target)
    assert client.get("/api/alpaca-paper/connection").status_code == 503


def test_transport_is_fixed_get_only_without_redirects_or_proxy_credentials(monkeypatch):
    response = MagicMock(status_code=200)
    response.__enter__.return_value = response
    response.iter_content.return_value = [json.dumps(ACCOUNT).encode()]
    session = MagicMock()
    session.__enter__.return_value = session
    session.get.return_value = response
    monkeypatch.setattr(requests, "Session", lambda: session)
    config = {"api_key": KEY, "secret_key": SECRET, "endpoint": alpaca.BASE_URL}
    assert alpaca._get(config, "/v2/account")["id"] == ACCOUNT["id"]
    assert session.trust_env is False
    args, kwargs = session.get.call_args
    assert args == ("https://paper-api.alpaca.markets/v2/account",)
    assert kwargs["allow_redirects"] is False
    assert kwargs["headers"]["APCA-API-SECRET-KEY"] == SECRET
    for path in ("/v2/orders/synthetic-id", "https://api.alpaca.markets/v2/account"):
        with pytest.raises(HTTPException):
            alpaca._get(config, path)
    with pytest.raises(HTTPException):
        alpaca._get({**config, "endpoint": "https://api.alpaca.markets"}, "/v2/account")
    assert session.get.call_count == 1
    for status in (301, 401, 429, 500):
        response.status_code = status
        with pytest.raises(HTTPException) as error:
            alpaca._get(config, "/v2/account")
        assert SECRET not in str(error.value.detail)
    session.get.side_effect = requests.ConnectionError(SECRET)
    with pytest.raises(HTTPException) as error:
        alpaca._get(config, "/v2/account")
    assert SECRET not in str(error.value.detail)


def test_response_size_and_nonfinite_json_are_rejected(monkeypatch):
    response = MagicMock()
    response.iter_content.return_value = [b'{"cash": NaN}']
    with pytest.raises(HTTPException):
        alpaca._json(response, alpaca.time.monotonic())
    monkeypatch.setattr(alpaca, "MAX_RESPONSE_BYTES", 10)
    response.iter_content.return_value = [b"x" * 11]
    with pytest.raises(HTTPException):
        alpaca._json(response, alpaca.time.monotonic())


def test_order_limits_and_writes_are_not_exposed(client):
    for query in ("limit=0", "limit=101", "status=anything"):
        assert client.get("/api/alpaca-paper/snapshot?" + query).status_code == 422
    for method in ("POST", "PATCH", "DELETE"):
        assert client.request(method, "/api/alpaca-paper/orders", json={"symbol": "SYNTH"}).status_code == 404
