"""Validation verdicts gate the strategy → paper bridge: synthetic bars, isolated DB, explicit override only."""
import json

import pytest

from alphaview.panel import sessions, store, strategy_bridge as bridge
from tests.test_strategy_bridge import AS_OF, account, body, client, proposals  # noqa: F401  (fixture re-export)

SMA = {"strategy": "sma_cross", "params": {"fast": 5, "slow": 20}}


def losing_closes(count):
    """Slow 25-session ramps followed by a gap down: every SMA 5/20 crossover trade loses."""
    closes = []
    for index in range(count):
        step = index % 50
        closes.append(100 + step * 0.4 if step < 25 else 88 - (step - 25) * 0.2)
    return closes


@pytest.fixture
def losing_symbol():
    days = sessions.expected_sessions("2020-01-02", AS_OF)[-500:]
    assert days[-1] == AS_OF
    with store.connect() as db:
        db.execute("INSERT OR IGNORE INTO datasets(symbol,currency,status) VALUES ('SYNTL','USD','ok')")
        for day, close in zip(days, losing_closes(500)):
            db.execute("INSERT INTO bars VALUES (?,?,?,?,?,?,?,?)", ("SYNTL", day, close, close * 1.001, close * 0.999, close, close, 1000.0))
    return "SYNTL"


def preview(client, payload):
    response = client.post("/api/research-desk/paper-preview", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    return result


def test_require_pass_refuses_a_failing_symbol_and_writes_nothing(client, losing_symbol):
    acct = account()
    before, revision = proposals(), store.input_revision()
    payload = {**body(acct, [losing_symbol]), "config": SMA}
    result = preview(client, payload)
    validation = result["validation"]
    assert validation["mode"] == "require_pass" and validation["gate"] == "blocked" and result["would_refuse"] is True
    assert validation["verdicts"] == {losing_symbol: "fail"} and validation["failing"] == [losing_symbol]
    assert validation["overridable"] is True and validation["engine_version"] == "alphaview-validation-v1"
    assert validation["folds"] == 4 and validation["trials"] == 1 and validation["items"][0]["consistency"] == 0
    assert any("fail" in warning for warning in result["warnings"])
    assert result["paper_preview"]["executable"] is True  # paper limits are a separate gate
    refused = client.post("/api/research-desk/paper-proposal", json={**payload, "idempotency_key": "bridge-validation-01"})
    assert refused.status_code == 422, refused.text
    detail = refused.json()["detail"]
    assert detail["code"] == "validation_failed" and detail["failing"] == [losing_symbol] and detail["overridable"] is True
    assert proposals() == before and store.input_revision() == revision


def test_acknowledged_fail_creates_the_proposal_with_the_override_recorded(client, losing_symbol):
    acct = account()
    before = proposals()
    payload = {**body(acct, [losing_symbol]), "config": SMA, "idempotency_key": "bridge-validation-02",
               "validation": {"mode": "require_pass", "acknowledge_fail": True}}
    response = client.post("/api/research-desk/paper-proposal", json=payload)
    assert response.status_code == 201, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    assert result["validation"]["gate"] == "overridden" and result["validation"]["acknowledge_fail"] is True
    rationale = result["paper_proposal"]["rationale"]
    assert '"ack":true' in rationale and '"gate":"overridden"' in rationale and f'"{losing_symbol}":"fail"' in rationale
    assert '"v":"alphaview-validation-v1"' in rationale and result["paper_proposal"]["status"] == "proposed"
    assert proposals() == before + 1
    assert any("明確覆寫" in warning or "fail" in warning for warning in result["warnings"])


def test_warn_only_annotates_without_refusing(client, losing_symbol):
    acct = account()
    before = proposals()
    payload = {**body(acct, [losing_symbol, "SYNTA"]), "config": SMA, "idempotency_key": "bridge-validation-03",
               "validation": {"mode": "warn_only"}}
    response = client.post("/api/research-desk/paper-proposal", json=payload)
    assert response.status_code == 201, response.text
    result = response.json()
    # SYNTA has 31 bars: after the SMA 20 warm-up it is below the 20-session minimum, so it is unavailable, not warn.
    assert result["validation"]["gate"] == "warn" and result["validation"]["verdicts"] == {losing_symbol: "fail", "SYNTA": "unavailable"}
    assert result["validation"]["unavailable"] == ["SYNTA"]
    assert result["would_refuse"] is False and any("僅警告模式" in warning for warning in result["warnings"])
    assert '"mode":"warn_only"' in result["paper_proposal"]["rationale"] and proposals() == before + 1


def test_warn_verdicts_pass_through_require_pass_with_a_warning(client):
    acct = account()
    result = preview(client, body(acct, ["SYNTA"]))
    assert result["validation"]["gate"] == "warn" and result["validation"]["verdicts"] == {"SYNTA": "warn"}
    assert result["would_refuse"] is False and result["validation"]["warn"] == ["SYNTA"]
    response = client.post("/api/research-desk/paper-proposal", json={**body(acct, ["SYNTA"]), "idempotency_key": "bridge-validation-04"})
    assert response.status_code == 201 and response.json()["validation"]["gate"] == "warn"


def test_off_skips_validation_entirely(client, losing_symbol):
    acct = account()
    payload = {**body(acct, [losing_symbol]), "config": SMA, "validation": {"mode": "off"}}
    result = preview(client, payload)
    assert result["validation"]["gate"] == "off" and result["validation"]["skipped"] is True and "overall" not in result["validation"]
    assert result["would_refuse"] is False and result["paper_preview"]["rationale"].endswith("validation=off")
    response = client.post("/api/research-desk/paper-proposal", json={**payload, "idempotency_key": "bridge-validation-05"})
    assert response.status_code == 201 and response.json()["paper_proposal"]["rationale"].endswith("validation=off")


def test_unavailable_overall_refuses_even_with_acknowledgement(client):
    acct = account()
    before = proposals()
    payload = {**body(acct, ["SYNTD"]), "validation": {"mode": "require_pass", "acknowledge_fail": True}}
    result = preview(client, payload)
    assert result["validation"]["overall"] == "unavailable" and result["validation"]["gate"] == "blocked"
    assert result["validation"]["overridable"] is False and result["validation"]["unavailable"] == ["SYNTD"]
    refused = client.post("/api/research-desk/paper-proposal", json={**payload, "idempotency_key": "bridge-validation-06"})
    assert refused.status_code == 422 and refused.json()["detail"]["overridable"] is False and proposals() == before


def test_ten_symbols_keep_the_rationale_within_the_paper_limit(client):
    acct = account()
    symbols = ["SYNTA", "SYNTB", "SYNTC"] + [f"SYNT{letter}" for letter in "FGHIJKL"]
    payload = {**body(acct, symbols), "idempotency_key": "bridge-validation-07", "validation": {"mode": "warn_only"}}
    response = client.post("/api/research-desk/paper-proposal", json=payload)
    assert response.status_code == 201, response.text
    rationale = response.json()["paper_proposal"]["rationale"]
    assert len(rationale) <= 2000 and '"verdicts"' in rationale and bridge.ENGINE_VERSION in rationale


@pytest.mark.parametrize("change", [{"trials": 0}, {"trials": 501}, {"validation": {"mode": "maybe"}},
                                    {"validation": {"mode": "off", "extra": 1}}, {"validation": "off"}])
def test_policy_bounds_are_strict(client, change):
    acct = account()
    assert client.post("/api/research-desk/paper-preview", json={**body(acct, ["SYNTA"]), **change}).status_code == 422
