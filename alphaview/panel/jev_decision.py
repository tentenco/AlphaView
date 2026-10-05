"""Jev (TypeSafe System One) decision gate over saved rule workflows.

Program-owned market facts go in; calibrated fixed-outcome probabilities come
out; code applies versioned thresholds. The only external call is one bounded
POST to the TypeSafe evaluation endpoint per run. No trading, no keys in the
database, no generated text is ever accepted as market data.
"""
import fcntl
import hashlib
import json
import math
import os
import re
import stat
import tempfile
import time
import uuid
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path

import requests
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field, SecretStr, ValidationError, field_validator

from . import paper_portfolio as paper
from . import portfolio_agent as agent
from . import sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-jev-decision-v1"
QUESTION_SET_VERSION = "alphaview-jev-questions-v1"
BASE_URL = "https://api.typesafe.ai"
EVALUATE_PATH, MODELS_PATH = "/v1/systemone", "/v1/models"
MODEL = "jev-1.13.0"
PRICE_USD_PER_MILLION_INPUT_TOKENS = Decimal("0.042")
PRICE_BASIS = ("TypeSafe published list price on 2026-09-30: $0.042 per million input tokens, "
               "output tokens free. Estimated from returned usage; not a bill.")
MAX_SELECTED = 10
MAX_RESPONSE_BYTES = 1_000_000
RETRY_DELAY_SECONDS = 1.0
API_KEY = re.compile(r"^apikey_[A-Za-z0-9_-]{16,256}$")
SYMBOL_KEY = re.compile(r"[^A-Z0-9]")
REQUIRED_INDICATORS = ("close", "ma50", "ma200", "high20", "high120", "volume_ratio", "rsi", "return120")
STRATEGY_NAMES = {"turtle": "turtle_breakout", "trend": "trend_following", "pullback": "rsi_pullback", "rps": "relative_strength"}
METHOD = (
    "One bounded TypeSafe System One request per run evaluates fixed-outcome questions "
    "against program-bucketed technical facts for every selected symbol of a current, "
    "proposed rules workflow. Facts come only from the saved scan snapshot: adjusted close "
    "versus moving averages, prior 20-day high, 120-day high distance, 20-day volume ratio, "
    "14-day RSI, 120-session return, universe RPS and strategy match statuses. No holdings, "
    "cost basis, notes, names or external text enter the state. The model returns a "
    "probability per question; code passes a symbol only when every gated probability "
    "clears its threshold and the risk probability stays under its ceiling. Passing symbols "
    "keep their original rule slot; failing or unavailable symbols go to zero with the freed "
    "weight held as cash, never redistributed. A missing, non-finite or extra answer, or a "
    "different model version than the pinned one, blocks the run. Probabilities are "
    "calibrated judgments about the described setup, not return forecasts; gate reliability "
    "must be measured against later sessions before it is trusted. Paper preview/proposal "
    "requires independent source/account/risk validation and never auto-accepts."
)
WARNINGS = [
    "Jev 只讀取程式整理過的技術事實；機率是對該設定的校準判斷，不是報酬預測。",
    "門檻由本機版本化政策決定；未通過或不可用的標的歸零並保留現金，不重新分配權重。",
    "每次執行都是一次付費外部呼叫，費用依回傳 token 估算；金鑰只存本機忽略檔案。",
    "此決策閘不會自動接受紙上提案，也沒有實盤交易介面。",
]
QUESTIONS = (
    {"id": "uptrend_intact", "type": "noul", "gate": "high", "label": "趨勢完整", "english": "Uptrend intact",
     "instructions": "Is `{path}` in an intact medium-to-long-term uptrend?",
     "criteria": {"true": "Close is above the 50-day and 200-day averages and the 50-day average is above the 200-day average",
                  "false": "Close is at or below the 200-day average, or the averages are inverted"}},
    {"id": "buying_pressure", "type": "noul", "gate": "high", "label": "買盤增強", "english": "Buying pressure",
     "instructions": "Is buying pressure building in `{path}`, meaning the recent advance is confirmed by above-average volume?",
     "criteria": {"true": "Price is advancing or breaking out and volume is at or above its 20-day average",
                  "false": "Volume is below its 20-day average or price is not advancing"}},
    {"id": "overextended", "type": "noul", "gate": "low", "label": "過度延伸", "english": "Overextended",
     "instructions": "Is `{path}` overextended to the upside, meaning overbought momentum after a sharp advance with elevated pullback risk?",
     "criteria": {"true": "RSI is overbought and the recent gain leaves price far above its moving averages",
                  "false": "Momentum is moderate and price is not far above its averages"}},
    {"id": "setup_quality", "type": "score", "gate": None, "label": "設定品質", "english": "Setup quality",
     "instructions": "How constructive is the technical long setup described in `{path}`?",
     "criteria": ["Weak: conflicting or bearish structure", "Mixed: some supportive factors, others missing",
                  "Constructive: trend and volume mostly confirm",
                  "Strong: trend, breakout, relative strength and volume all confirm"]},
)


class GatePolicy(agent.StrictInput):
    pass_threshold: float = Field(default=0.7, ge=0.5, le=0.99)
    max_risk_probability: float = Field(default=0.5, ge=0.01, le=0.5)


class RunInput(agent.StrictInput):
    source_run_id: str = Field(min_length=1, max_length=100)
    policy: GatePolicy = Field(default_factory=GatePolicy)
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")


class ConnectionInput(paper.StrictInput):
    api_key: SecretStr
    expected_version: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("api_key")
    @classmethod
    def credential_format(cls, value):
        if not API_KEY.fullmatch(value.get_secret_value()):
            raise ValueError("Invalid credential format")
        return value


class DisconnectInput(paper.StrictInput):
    expected_version: str = Field(min_length=1, max_length=64)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _problem(code, message, status=502):
    return HTTPException(status, {"code": code, "message": message})


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# --- Local credential file (owner-only, gitignored, never in SQLite or backups) ---

def credential_path():
    configured = os.getenv("ALPHAVIEW_JEV_CREDENTIALS_PATH")
    return Path(configured).expanduser() if configured else store.db_path().with_suffix(".jev.json")


@contextmanager
def _config_lock():
    path = credential_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _read_config():
    path = credential_path()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    except OSError:
        raise _problem("credential_file", "無法安全讀取本機 Jev 金鑰設定", 503) from None
    try:
        with os.fdopen(fd) as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid() or info.st_size > 4096:
                raise ValueError()
            value = json.load(handle)
        parsed = ConnectionInput(api_key=value["api_key"])
        if value["endpoint"] != BASE_URL or value["schema_version"] != 1:
            raise ValueError()
        if not re.fullmatch(r"[a-f0-9]{32}", value["version"]) or not isinstance(value["connected_at"], str):
            raise ValueError()
        return {**value, "api_key": parsed.api_key.get_secret_value()}
    except (ValueError, KeyError, TypeError, OSError):
        raise _problem("credential_file", "Jev 設定無效；請檢查本機設定檔內容、擁有者與 0600 權限", 503) from None


def _public(config):
    return {"engine_version": ENGINE_VERSION, "question_set_version": QUESTION_SET_VERSION,
            "provider": "TypeSafe", "product": "Jev", "endpoint": BASE_URL, "model": MODEL,
            "configured": config is not None, "version": config["version"] if config else None,
            "connected_at": config["connected_at"] if config else None,
            "available_models": config.get("available_models", []) if config else [],
            "capabilities": ["models.read", "systemone.evaluate"], "trading_enabled": False,
            "price_basis": PRICE_BASIS, "method": METHOD}


# --- Fixed transport: one host, two paths, no proxies, no redirects, bounded ---

def _call(config, method, path, payload=None):
    if (method, path) not in (("GET", MODELS_PATH), ("POST", EVALUATE_PATH)) or config.get("endpoint", BASE_URL) != BASE_URL:
        raise _problem("endpoint_not_allowed", "僅允許指定的 TypeSafe 端點", 422)
    headers = {"Authorization": "Bearer " + config["api_key"], "Accept": "application/json"}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = _json(payload).encode()
    for attempt in (1, 2):
        started = time.monotonic()
        try:
            with requests.Session() as session:
                session.trust_env = False
                with session.request(method, BASE_URL + path, data=body, headers=headers, timeout=(4, 20),
                                     allow_redirects=False, stream=True) as response:
                    if response.status_code in (429, 529) and attempt == 1:
                        time.sleep(RETRY_DELAY_SECONDS)
                        continue
                    if response.status_code in (401, 403):
                        raise _problem("authentication_failed", "Jev API 金鑰未通過驗證；請重新設定連線", 401)
                    if response.status_code in (429, 529):
                        raise _problem("rate_limited", "TypeSafe 要求降低請求頻率或暫時超載；請稍後再試", 503)
                    if response.status_code == 422:
                        raise _problem("request_rejected", "TypeSafe 拒絕本次請求格式；未採用任何結果")
                    if response.status_code != 200:
                        raise _problem("provider_unavailable", "TypeSafe 未成功回應；本次結果不可用")
                    chunks, size = [], 0
                    for chunk in response.iter_content(chunk_size=16_384):
                        size += len(chunk)
                        if size > MAX_RESPONSE_BYTES or time.monotonic() - started > 25:
                            raise _problem("response_limit", "TypeSafe 回應超過大小或時間上限；資料未採用")
                        chunks.append(chunk)
            try:
                value = json.loads(b"".join(chunks), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            except (ValueError, UnicodeError):
                raise _problem("invalid_response", "TypeSafe 回應不是有效的有限 JSON") from None
            if not isinstance(value, dict):
                raise _problem("invalid_response", "TypeSafe 回應格式不符")
            return value, int((time.monotonic() - started) * 1000)
        except requests.RequestException:
            # Never surface exception text: it may carry the request headers.
            raise _problem("network_unavailable", "無法連線至 TypeSafe API，請檢查網路後重試", 503) from None
    raise _problem("provider_unavailable", "TypeSafe 未成功回應；本次結果不可用")


def _models(config):
    value, _ = _call(config, "GET", MODELS_PATH)
    models = value.get("models")
    if not isinstance(models, list) or len(models) > 50:
        raise _problem("invalid_response", "TypeSafe 模型清單格式不符")
    names = [item.get("name") for item in models if isinstance(item, dict)]
    if any(not isinstance(name, str) or len(name) > 100 for name in names):
        raise _problem("invalid_response", "TypeSafe 模型清單格式不符")
    return names


def save_connection(body: ConnectionInput):
    with _config_lock():
        existing = _read_config()
        if (existing["version"] if existing else None) != body.expected_version:
            raise _problem("connection_changed", "連線已被另一個操作更新；請重新載入後再設定", 409)
        config = {"schema_version": 1, "endpoint": BASE_URL, "api_key": body.api_key.get_secret_value(),
                  "version": uuid.uuid4().hex, "connected_at": store.now()}
        config["available_models"] = _models(config)
        path = credential_path()
        fd, temporary = tempfile.mkstemp(prefix=".jev-", dir=path.parent)
        try:
            with os.fdopen(fd, "w") as handle:
                os.fchmod(handle.fileno(), 0o600)
                json.dump(config, handle, allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {**_public(config), "verified_at": store.now()}


@router.get("/api/jev/connection")
def connection():
    return JSONResponse(_public(_read_config()), headers={"Cache-Control": "no-store"})


@router.post("/api/jev/connection")
async def configure(request: Request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 4096:
            raise _problem("invalid_credentials", "金鑰設定請求過大", 422)
    try:
        body = ConnectionInput.model_validate(json.loads(raw))
    except (ValueError, ValidationError, TypeError):
        raise _problem("invalid_credentials", "請提供 TypeSafe API Key（apikey_ 開頭）與目前連線版本；不接受其他設定", 422) from None
    import asyncio
    value = await asyncio.to_thread(save_connection, body)
    return JSONResponse(value, headers={"Cache-Control": "no-store"})


@router.delete("/api/jev/connection")
def disconnect(body: DisconnectInput):
    with _config_lock():
        config = _read_config()
        if config is None or config["version"] != body.expected_version:
            raise _problem("connection_changed", "連線已改變；請重新載入", 409)
        credential_path().unlink()
    return JSONResponse(_public(None), headers={"Cache-Control": "no-store"})


# --- Question set (the "strategy.md" of this gate): fixed, versioned, reviewable ---

def question_set():
    return {"engine_version": ENGINE_VERSION, "question_set_version": QUESTION_SET_VERSION, "model": MODEL,
            "language": "en", "default_policy": GatePolicy().model_dump(), "max_selected": MAX_SELECTED,
            "questions": [{**question, "instructions": question["instructions"].format(path="candidates.<symbol>")}
                          for question in QUESTIONS],
            "state_fields": ["trend_structure", "close_vs_ma50", "close_vs_ma200", "breakout_20d",
                             "distance_from_120d_high", "volume", "rsi_14", "momentum_120d",
                             "relative_strength", "strategy_signals"],
            "price_basis": PRICE_BASIS, "method": METHOD, "warnings": list(WARNINGS)}


@router.get("/api/jev/questions")
def questions_endpoint():
    return question_set()


# --- State builder: numbers to named buckets in code; nothing private, nothing free-form ---

def _key(symbol):
    return SYMBOL_KEY.sub("_", symbol)


def _pct(value, base):
    return (value / base - 1) * 100


def _describe(indicators, signals):
    values = {name: indicators.get(name) for name in REQUIRED_INDICATORS}
    missing = [name for name, value in values.items() if not _finite(value)]
    missing += [name for name in ("close", "ma50", "ma200", "high20", "high120") if name not in missing and values[name] <= 0]
    if missing:
        return None, sorted(set(missing))
    close, ma50, ma200 = values["close"], values["ma50"], values["ma200"]
    if close > ma50 > ma200:
        trend = "close above the 50-day average and the 50-day above the 200-day average (bullish alignment)"
    elif close > ma200 and close <= ma50:
        trend = "close above the 200-day average but at or below the 50-day average"
    elif close > ma200:
        trend = "close above both averages, but the 50-day average is at or below the 200-day average"
    else:
        trend = "close at or below the 200-day average"

    def versus(name, base):
        gap = _pct(close, base)
        return f"close is {abs(gap):.1f}% {'above' if gap > 0 else 'below'} the {name}" if gap else f"close equals the {name}"

    below_high = max(0.0, (1 - close / values["high120"]) * 100)
    distance = ("at or within 2% of the 120-day high" if below_high <= 2
                else f"{below_high:.1f}% below the 120-day high (within 10%)" if below_high <= 10
                else f"{below_high:.1f}% below the 120-day high (more than 10% below)")
    ratio = values["volume_ratio"]
    volume = (("very heavy" if ratio >= 2 else "heavy" if ratio >= 1.2 else "normal" if ratio >= 0.8 else "light")
              + f": {ratio:.1f}x the 20-day average volume")
    rsi = values["rsi"]
    rsi_zone = ("overbought (RSI above 70)" if rsi > 70 else "strong momentum (RSI 55-70)" if rsi >= 55
                else "neutral (RSI 45-55)" if rsi >= 45 else "pullback zone (RSI 30-45)" if rsi >= 30
                else "oversold (RSI below 30)")
    change = values["return120"] * 100
    momentum = (f"strong gain of {change:.1f}% over the last 120 sessions" if change >= 30
                else f"gain of {change:.1f}% over the last 120 sessions" if change >= 10
                else f"roughly flat ({change:+.1f}%) over the last 120 sessions" if change >= -10
                else f"decline of {abs(change):.1f}% over the last 120 sessions")
    rps = indicators.get("rps")
    strength = ("not ranked (fewer than 3 comparable symbols)" if not _finite(rps)
                else f"top quintile of the scanned universe (RPS {rps:.0f})" if rps >= 80
                else f"upper half of the scanned universe (RPS {rps:.0f})" if rps >= 50
                else f"lower half of the scanned universe (RPS {rps:.0f})")
    statuses = {}
    for strategy, name in STRATEGY_NAMES.items():
        rows = [row for row in signals if isinstance(row, dict) and row.get("strategy") == strategy]
        row = rows[0] if len(rows) == 1 else {}
        status = row.get("status")
        statuses[name] = ("matched" if status == "match" and row.get("matched") is True
                          else "not matched" if status in ("match", "watch") else f"unavailable ({status or 'missing'})")
    state = {"trend_structure": trend, "close_vs_ma50": versus("50-day average", ma50),
             "close_vs_ma200": versus("200-day average", ma200),
             "breakout_20d": ("close is above the prior 20-day high (breakout)" if close > values["high20"]
                              else "close is at or below the prior 20-day high (no breakout)"),
             "distance_from_120d_high": distance, "volume": volume, "rsi_14": f"{rsi_zone}, RSI {rsi:.0f}",
             "momentum_120d": momentum, "relative_strength": strength, "strategy_signals": statuses}
    return state, []


def _source(db, identifier):
    source = agent._run(db, identifier)
    if source["status"] != "proposed" or not agent._currentness(source)["current"]:
        raise _problem("source_stale", "來源規則工作流未通過、已過期或版本不符；請先重算規則工作流", 409)
    if not 1 <= len(source["target_weights"]) <= MAX_SELECTED:
        raise _problem("source_size", f"Jev 決策閘需要 1–{MAX_SELECTED} 個已選定規則目標", 422)
    return source


def _source_summary(source):
    return {"id": source["id"], "engine_version": source["engine_version"], "as_of": source["as_of"],
            **({"account_context": source["account_context"], "symbol_policy_method": paper.SYMBOL_POLICY_METHOD} if source.get("account_context") else {}),
            "input_revision": source["input_revision"], "proposal_fingerprint": source["proposal_fingerprint"],
            "scan": source["scan"], "target_weights": source["target_weights"], "cash_weight_pct": source["cash_weight_pct"],
            "constraints": source["request"]["constraints"], "strategy_weights": source["request"]["strategy_weights"]}


def build_evaluation(db, source):
    """Program-owned state and questions for every selected symbol; no model involvement."""
    scan = db.execute("SELECT result FROM scans WHERE id=?", (source["scan"]["id"],)).fetchone()
    if scan is None:
        raise _problem("scan_missing", "來源選股快照已不存在", 409)
    indexed = {}
    for row in json.loads(scan["result"]):
        if isinstance(row, dict):
            indexed.setdefault(row.get("symbol"), []).append(row)
    candidates, questions, symbols, keys = {}, {}, [], set()
    for target in source["target_weights"]:
        symbol, key = target["symbol"], _key(target["symbol"])
        if key in keys:
            raise _problem("symbol_key_conflict", "候選代碼在狀態鍵中衝突，無法建立問題", 422)
        keys.add(key)
        rows = indexed.get(symbol, [])
        row = rows[0] if len(rows) == 1 and rows[0].get("date") == source["as_of"] else {}
        state, missing = _describe(row.get("indicators") or {}, row.get("signals") or [])
        item = {"symbol": symbol, "key": key, "original_weight_pct": target["weight_pct"],
                "evidence_complete": state is not None, "missing": missing if state is None else []}
        symbols.append(item)
        if state is None:
            continue
        candidates[key] = {"symbol": symbol, **state}
        for question in QUESTIONS:
            entry = {"type": question["type"], "instructions": question["instructions"].format(path=f"candidates.{key}"),
                     "criteria": question["criteria"]}
            questions[f"{key}:{question['id']}"] = entry
    state = {"as_of": source["as_of"], "price_basis": "adjusted daily closes from the saved local scan",
             "candidates": candidates}
    return {"state": state, "questions": questions, "symbols": symbols}


def _validate_answers(response, questions):
    """Accept only a complete, typed answer set from the pinned model version."""
    issues = []
    if response.get("model") != MODEL:
        issues.append({"code": "model_mismatch", "message": f"回應模型與釘選版本 {MODEL} 不同；門檻不適用"})
    answers = response.get("answers")
    if not isinstance(answers, dict) or set(answers) != set(questions):
        issues.append({"code": "answers_incomplete", "message": "回應缺少、多出或重複了問題答案"})
        answers = {} if not isinstance(answers, dict) else {key: value for key, value in answers.items() if key in questions}
    clean = {}
    for identifier, answer in answers.items():
        expected = questions[identifier]["type"]
        valid = isinstance(answer, dict) and answer.get("type") == expected
        if valid and expected == "noul":
            valid = _finite(answer.get("noul")) and 0 <= answer["noul"] <= 1
            clean[identifier] = {"type": "noul", "noul": float(answer["noul"])} if valid else None
        elif valid:
            probabilities = answer.get("probabilities")
            valid = (_finite(answer.get("score")) and _finite(answer.get("confidence")) and 0 <= answer["confidence"] <= 1
                     and isinstance(probabilities, dict) and all(_finite(value) for value in probabilities.values())
                     and isinstance(answer.get("legend"), dict))
            clean[identifier] = ({"type": "score", "score": float(answer["score"]), "confidence": float(answer["confidence"]),
                                  "probabilities": {str(key): float(value) for key, value in probabilities.items()},
                                  "legend": {str(key): str(value)[:160] for key, value in answer["legend"].items()}} if valid else None)
        else:
            clean[identifier] = None
        if not valid:
            issues.append({"code": "answer_invalid", "message": "答案型別或數值不符", "question_id": identifier})
    usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
    tokens = {name: usage.get(name) if type(usage.get(name)) is int and usage[name] >= 0 else None
              for name in ("input_tokens", "output_tokens")}
    return clean, tokens, issues


def evaluate_gate(symbols, answers, policy):
    """Threshold every gated probability in code; freed weight becomes cash."""
    decisions, targets, counts = [], [], {"pass": 0, "fail": 0, "unavailable": 0}
    for item in symbols:
        checks, quality = [], None
        status = "unavailable" if not item["evidence_complete"] else "pass"
        for question in QUESTIONS:
            identifier = f"{item['key']}:{question['id']}"
            answer = answers.get(identifier) if item["evidence_complete"] else None
            if question["gate"] is None:
                if answer is not None:
                    level = str(int(round(answer["score"])))
                    quality = {"question_id": identifier, "score": answer["score"], "confidence": answer["confidence"],
                               "probabilities": answer["probabilities"], "level_label": answer["legend"].get(level)}
                continue
            value = answer["noul"] if answer is not None else None
            threshold = policy["pass_threshold"] if question["gate"] == "high" else policy["max_risk_probability"]
            passed = None if value is None else (value >= threshold if question["gate"] == "high" else value <= threshold)
            checks.append({"question_id": identifier, "question": question["id"], "label": question["label"],
                           "english": question["english"], "direction": question["gate"], "value": value,
                           "threshold": threshold, "passed": passed,
                           "reason": ("state_incomplete" if not item["evidence_complete"] else "answer_unavailable") if value is None else None})
            if passed is None:
                status = "unavailable"
            elif not passed and status != "unavailable":
                status = "fail"
        counts[status] += 1
        target = item["original_weight_pct"] if status == "pass" else 0.0
        targets.append({"symbol": item["symbol"], "weight_pct": target})
        decisions.append({**item, "status": status, "checks": checks, "setup_quality": quality, "target_weight_pct": target})
    blocking = []
    if not counts["pass"]:
        blocking.append({"code": "no_passing_candidates", "message": "沒有標的通過全部門檻；不產生清空持倉提案"})
    invested = math.fsum(target["weight_pct"] for target in targets)
    return {"policy": dict(policy), "decisions": decisions, "counts": counts, "blocking_reasons": blocking,
            "target_weights": targets if not blocking else [], "cash_weight_pct": round(100 - invested, 8) if not blocking else None,
            "proposal_ready": not blocking}


def _row(db, identifier):
    row = db.execute("SELECT * FROM jev_decision_runs WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise _problem("run_not_found", "找不到 Jev 決策紀錄", 404)
    return dict(row)


def _currentness(db, row):
    reasons = []
    if row["engine_version"] != ENGINE_VERSION:
        reasons.append("jev_engine_changed")
    if row["question_set_version"] != QUESTION_SET_VERSION:
        reasons.append("question_set_changed")
    try:
        source = _source(db, row["source_run_id"])
        if source["proposal_fingerprint"] != json.loads(row["source_json"])["proposal_fingerprint"]:
            reasons.append("source_fingerprint_changed")
    except HTTPException:
        reasons.append("source_run_stale_or_unavailable")
    return {"current": not reasons, "stale_reasons": reasons}


def _cost(tokens):
    if tokens.get("input_tokens") is None:
        return None
    return float(Decimal(tokens["input_tokens"]) * PRICE_USD_PER_MILLION_INPUT_TOKENS / Decimal(1_000_000))


def _public_run(db, row, *, detail=True):
    freshness = _currentness(db, row)
    effective = "stale" if not freshness["current"] and row["status"] == "completed" else row["status"]
    result = json.loads(row["result_json"])
    usage = json.loads(row["usage_json"]) if row["usage_json"] else {"input_tokens": None, "output_tokens": None}
    ready = effective == "completed" and result["proposal_ready"]
    response = {"id": row["id"], "engine_version": row["engine_version"], "question_set_version": row["question_set_version"],
                "source_run_id": row["source_run_id"], "status": effective, "stored_status": row["status"],
                "created_at": row["created_at"], "as_of": row["as_of"], "input_revision": row["input_revision"],
                "request": json.loads(row["request_json"]), "policy": result["policy"],
                "model": {"requested": row["model_requested"], "answered": row["model_answered"]},
                "latency_ms": row["latency_ms"], "usage": usage, "estimated_cost_usd": _cost(usage),
                "error": json.loads(row["error_json"]) if row["error_json"] else None,
                "counts": result["counts"], "proposal_ready": ready,
                "target_weights": result["target_weights"] if ready else [],
                "cash_weight_pct": result["cash_weight_pct"] if ready else None, **freshness}
    if detail:
        response.update(source=json.loads(row["source_json"]), state=json.loads(row["state_json"]),
                        questions=json.loads(row["questions_json"]), request_digest=row["request_digest"],
                        answers=json.loads(row["answers_json"]) if row["answers_json"] else None,
                        result=result, price_basis=PRICE_BASIS, method=METHOD, warnings=list(WARNINGS))
    return response


def _usage_summary(rows):
    evaluated = [row for row in rows if row["usage_json"]]
    tokens = [json.loads(row["usage_json"]).get("input_tokens") for row in evaluated]
    tokens = [value for value in tokens if value is not None]
    latencies = [row["latency_ms"] for row in evaluated if row["latency_ms"] is not None]
    costs = [_cost({"input_tokens": value}) for value in tokens]
    return {"listed_runs": len(rows), "evaluated_runs": len(evaluated),
            "average_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else None,
            "average_input_tokens": round(sum(tokens) / len(tokens), 1) if tokens else None,
            "average_estimated_cost_usd": sum(costs) / len(costs) if costs else None,
            "total_estimated_cost_usd": sum(costs) if costs else None, "price_basis": PRICE_BASIS}


@router.get("/api/jev/runs")
@store.snapshot_read
def list_runs(limit: int = Query(default=20, ge=1, le=100)):
    with store.connect() as db:
        rows = [dict(row) for row in db.execute("SELECT * FROM jev_decision_runs ORDER BY created_at DESC,id DESC LIMIT ?", (limit,))]
        return {"engine_version": ENGINE_VERSION, "question_set_version": QUESTION_SET_VERSION, "model": MODEL,
                "as_of": sessions.latest_completed_session(), "input_revision": store.input_revision(db),
                "runs": [_public_run(db, row, detail=False) for row in rows], "usage_summary": _usage_summary(rows),
                "method": METHOD}


@router.get("/api/jev/runs/{identifier}")
@store.snapshot_read
def get_run(identifier: str):
    with store.connect() as db:
        return _public_run(db, _row(db, identifier))


def _existing(db, body):
    row = db.execute("SELECT * FROM jev_decision_runs WHERE idempotency_key=?", (body.idempotency_key,)).fetchone()
    if row is None:
        return None
    if row["request_hash"] != _hash(body.model_dump(exclude={"idempotency_key"})):
        raise _problem("idempotency_conflict", "決策請求識別碼已被不同內容使用", 409)
    return _public_run(db, dict(row))


@router.post("/api/jev/runs", status_code=201)
def create_run(body: RunInput):
    with store.read_snapshot():
        with store.connect() as db:
            existing = _existing(db, body)
            if existing is not None:
                return existing
            config = _read_config()
            if config is None:
                raise _problem("not_configured", "尚未設定 Jev API 連線", 409)
            source = _source(db, body.source_run_id)
            summary = _source_summary(source)
            evaluation = build_evaluation(db, source)
    payload = {"state": evaluation["state"], "model": MODEL, "questions": evaluation["questions"]}
    digest = _hash(payload)
    answers, tokens, latency, issues, raw_model = {}, {"input_tokens": None, "output_tokens": None}, None, [], None
    if evaluation["questions"]:
        # The provider call happens outside any database transaction.
        response, latency = _call(config, "POST", EVALUATE_PATH, payload)
        raw_model = response.get("model") if isinstance(response.get("model"), str) else None
        answers, tokens, issues = _validate_answers(response, evaluation["questions"])
    policy = body.policy.model_dump()
    result = evaluate_gate(evaluation["symbols"], {key: value for key, value in answers.items() if value is not None}, policy)
    error = None
    if issues:
        error = {"code": "answers_invalid", "message": "回應未通過驗證；本次不提供可接續配置", "issues": issues}
        result.update(proposal_ready=False, target_weights=[], cash_weight_pct=None,
                      blocking_reasons=[*result["blocking_reasons"], {"code": "answers_invalid", "message": "回應未通過驗證"}])
    status = "completed" if result["proposal_ready"] else "blocked"
    identifier, created = uuid.uuid4().hex, store.now()
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = _existing(db, body)
        if existing is not None:
            return existing
        try:
            current = _source(db, body.source_run_id)
        except HTTPException:
            current = None
        if current is None or _source_summary(current) != summary:
            status, error = "stale", {"code": "source_changed", "message": "評估期間來源行情、交易日或引擎已變更；結果保留但不可接續"}
            result.update(proposal_ready=False, target_weights=[], cash_weight_pct=None)
        db.execute("""INSERT INTO jev_decision_runs
            (id,idempotency_key,request_hash,source_run_id,engine_version,question_set_version,status,created_at,as_of,input_revision,
             model_requested,model_answered,request_json,source_json,state_json,questions_json,request_digest,answers_json,usage_json,
             latency_ms,result_json,error_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (identifier, body.idempotency_key, _hash(body.model_dump(exclude={"idempotency_key"})), body.source_run_id,
                    ENGINE_VERSION, QUESTION_SET_VERSION, status, created, source["as_of"], source["input_revision"], MODEL,
                    raw_model[:100] if raw_model else None, _json(body.model_dump()), _json(summary), _json(evaluation["state"]),
                    _json(evaluation["questions"]), digest, _json(answers) if evaluation["questions"] else None,
                    _json(tokens) if evaluation["questions"] else None, latency, _json(result), _json(error) if error else None))
    return get_run(identifier)


@router.get("/api/jev/runs/{identifier}/outcomes")
@store.snapshot_read
def outcomes(identifier: str):
    """Forward adjusted-close change since the decision session; a measurement, not a backtest."""
    latest = sessions.latest_completed_session()
    with store.connect() as db:
        row = _row(db, identifier)
        result = json.loads(row["result_json"])
        items = []
        for decision in result["decisions"]:
            base = db.execute("SELECT adj_close FROM bars WHERE symbol=? AND date=?", (decision["symbol"], row["as_of"])).fetchone()
            later = [dict(bar) for bar in db.execute("SELECT date,adj_close FROM bars WHERE symbol=? AND date>? AND date<=? ORDER BY date",
                                                     (decision["symbol"], row["as_of"], latest))]
            item = {"symbol": decision["symbol"], "gate_status": decision["status"], "target_weight_pct": decision["target_weight_pct"],
                    "decision_session": row["as_of"], "latest_session": later[-1]["date"] if later else None,
                    "sessions_elapsed": len(later), "forward_return_pct": None, "available": False, "reason": None}
            if base is None or not _finite(base["adj_close"]) or base["adj_close"] <= 0:
                item["reason"] = "decision_close_unavailable"
            elif not later:
                item["reason"] = "no_later_session"
            elif not _finite(later[-1]["adj_close"]) or later[-1]["adj_close"] <= 0:
                item["reason"] = "latest_close_invalid"
            else:
                item.update(available=True, forward_return_pct=round(_pct(later[-1]["adj_close"], base["adj_close"]), 4))
            items.append(item)
        return {"engine_version": ENGINE_VERSION, "run_id": identifier, "as_of": row["as_of"], "latest_completed_session": latest,
                "input_revision": store.input_revision(db), "items": items,
                "method": ("Adjusted close on the latest locally available completed session divided by the adjusted close on "
                           "the decision session, minus one. Uses whatever later bars exist locally; no benchmark, costs, "
                           "position sizing or paper ledger. Not a backtest and not evidence of gate reliability on its own.")}


# --- Paper bridge: bound source, program targets, explicit acceptance elsewhere ---

def validate_source(db, source):
    row = _row(db, source["run_id"])
    if source["engine_version"] != ENGINE_VERSION or row["engine_version"] != ENGINE_VERSION:
        raise HTTPException(409, "Jev 決策方法版本已變更")
    if row["status"] != "completed" or not _currentness(db, row)["current"]:
        raise HTTPException(409, "Jev 決策未通過、已受阻或來源已過期")
    result = json.loads(row["result_json"])
    if not result["proposal_ready"] or not result["target_weights"] or not any(target["weight_pct"] > 0 for target in result["target_weights"]):
        raise HTTPException(409, "Jev 決策沒有通過門檻的紙上目標")
    saved = json.loads(row["source_json"])
    return {"run_id": row["id"], "source_run_id": row["source_run_id"], "target_weights": result["target_weights"],
            **({"account_context": saved["account_context"]} if saved.get("account_context") else {}),
            "as_of": row["as_of"], "input_revision": row["input_revision"]}


def _paper_input(identifier, body, *, save=False):
    with store.read_snapshot():
        with store.connect() as db:
            source = validate_source(db, {"run_id": identifier, "engine_version": ENGINE_VERSION})
            paper._validate_policy_binding(db, source.get("account_context"), body.account_id)
    payload = {"expected_version": body.expected_account_version, "targets": source["target_weights"],
               "expected_input_revision": source["input_revision"], "expected_as_of": source["as_of"],
               "jev_source": {"run_id": identifier, "engine_version": ENGINE_VERSION},
               "rationale": f"Jev 決策閘 {identifier}；來源規則 run {source['source_run_id']}；{ENGINE_VERSION}／{QUESTION_SET_VERSION}。未通過門檻的標的歸零保留現金。"}
    if save:
        payload["idempotency_key"] = body.idempotency_key
    return payload


@router.post("/api/jev/runs/{identifier}/paper-preview")
def paper_preview(identifier: str, body: agent.PaperBridgeInput):
    result = paper.preview(body.account_id, paper.PreviewInput(**_paper_input(identifier, body)))
    return {"run_id": identifier, "engine_version": ENGINE_VERSION, "paper_preview": result, "method": METHOD}


@router.post("/api/jev/runs/{identifier}/paper-proposal", status_code=201)
def paper_proposal(identifier: str, body: agent.PaperProposalBridgeInput):
    result = paper.create_proposal(body.account_id, paper.ProposalInput(**_paper_input(identifier, body, save=True)))
    return {"run_id": identifier, "engine_version": ENGINE_VERSION, "paper_proposal": result, "method": METHOD}


def init_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS jev_decision_runs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        source_run_id TEXT NOT NULL, engine_version TEXT NOT NULL, question_set_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('completed','blocked','stale','failed')),
        created_at TEXT NOT NULL, as_of TEXT NOT NULL, input_revision TEXT NOT NULL,
        model_requested TEXT NOT NULL, model_answered TEXT,
        request_json TEXT NOT NULL, source_json TEXT NOT NULL, state_json TEXT NOT NULL,
        questions_json TEXT NOT NULL, request_digest TEXT NOT NULL, answers_json TEXT, usage_json TEXT,
        latency_ms INTEGER, result_json TEXT NOT NULL, error_json TEXT
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_jev_decision_runs_created ON jev_decision_runs(created_at,id)")
