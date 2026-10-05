"""Explicitly configured, paper-only Alpaca REST connection.

The transport only permits a fixed set of GET requests to the paper host.
Credentials and provider snapshots never enter the research database or logs.
"""
import asyncio
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
from typing import Literal
import uuid

import requests
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator

from . import store

router = APIRouter()
ENGINE_VERSION = "alphaview-alpaca-paper-connection-v1"
ORDERS_VERSION = "alphaview-alpaca-paper-orders-v1"
BASE_URL = "https://paper-api.alpaca.markets"
GET_PATHS = frozenset(("/v2/account", "/v2/positions", "/v2/orders", "/v2/clock"))
ORDER_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
ORDER_PATHS = {"POST": re.compile(r"^/v2/orders$"), "DELETE": re.compile(r"^/v2/orders/[A-Za-z0-9-]{8,64}$"),
               "GET": re.compile(r"^/v2/orders(/[A-Za-z0-9-]{8,64}|:by_client_order_id)$")}
ENABLE_CONFIRMATION = "ENABLE PAPER ORDERS"
DEFAULT_ORDER_CAPS = {"max_order_notional_usd": 5000.0, "max_orders_per_submission": 20, "max_volume_participation_pct": 5.0}
# Order style: market DAY orders by default; limit orders price each line at the proposal reference ± band.
DEFAULT_ORDER_STYLE = {"type": "market", "limit_band_bps": 50.0, "time_in_force": "day"}
MAX_RESPONSE_BYTES = 4_000_000
METHOD = (
    "直接讀取 Alpaca Paper Trading 帳戶、持倉、委託與市場時鐘；各資源有獨立擷取時間，"
    "不是跨端點原子快照。金額與股數保留供應者十進位文字，不補值、不換算本機績效。"
    "委託能力預設關閉；只有以確認字串明確啟用後，執行層才能向同一個 Paper 主機送出、查詢與取消委託，"
    "並受每筆金額與每次筆數上限約束。委託型態可選市價或限價（限價以提案參考價加減限價帶計算，缺參考價不送出）。"
    "本機模擬提案、接受與排程仍不會自動送到 Alpaca。"
)


class ConnectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    api_key: SecretStr
    secret_key: SecretStr
    expected_version: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("api_key", "secret_key")
    @classmethod
    def credential_format(cls, value, info):
        raw = value.get_secret_value()
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", raw):
            raise ValueError("Invalid credential format")
        if info.field_name == "api_key" and not re.fullmatch(r"PK[A-Z0-9]{14,126}", raw):
            raise ValueError("Paper API key required")
        return value


class DisconnectInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: str = Field(min_length=1, max_length=64)


class OrdersPolicyInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    expected_version: str = Field(min_length=1, max_length=64)
    orders_enabled: bool
    confirmation: str | None = Field(default=None, max_length=64)
    max_order_notional_usd: float = Field(default=DEFAULT_ORDER_CAPS["max_order_notional_usd"], ge=1, le=1_000_000)
    max_orders_per_submission: int = Field(default=DEFAULT_ORDER_CAPS["max_orders_per_submission"], ge=1, le=40)
    max_volume_participation_pct: float = Field(default=DEFAULT_ORDER_CAPS["max_volume_participation_pct"], ge=0.1, le=100)
    order_type: Literal["market", "limit"] = DEFAULT_ORDER_STYLE["type"]
    limit_band_bps: float = Field(default=DEFAULT_ORDER_STYLE["limit_band_bps"], ge=0, le=500)

    @field_validator("confirmation")
    @classmethod
    def strip_confirmation(cls, value):
        return value.strip() if isinstance(value, str) else value


def _order_caps(value):
    caps = dict(DEFAULT_ORDER_CAPS)
    if value is None:
        return caps
    if not isinstance(value, dict) or set(value) - set(caps):
        raise ValueError()
    notional = value.get("max_order_notional_usd", caps["max_order_notional_usd"])
    count = value.get("max_orders_per_submission", caps["max_orders_per_submission"])
    participation = value.get("max_volume_participation_pct", caps["max_volume_participation_pct"])
    if isinstance(notional, bool) or not isinstance(notional, (int, float)) or not 1 <= notional <= 1_000_000:
        raise ValueError()
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 40:
        raise ValueError()
    if isinstance(participation, bool) or not isinstance(participation, (int, float)) or not 0.1 <= participation <= 100:
        raise ValueError()
    return {"max_order_notional_usd": float(notional), "max_orders_per_submission": count,
            "max_volume_participation_pct": float(participation)}


def _order_style(value):
    """Order style block; configs written before this field existed load as market DAY."""
    style = dict(DEFAULT_ORDER_STYLE)
    if value is None:
        return style
    if not isinstance(value, dict) or set(value) - set(style):
        raise ValueError()
    kind = value.get("type", style["type"])
    band = value.get("limit_band_bps", style["limit_band_bps"])
    if kind not in ("market", "limit") or value.get("time_in_force", "day") != "day":
        raise ValueError()
    if isinstance(band, bool) or not isinstance(band, (int, float)) or not 0 <= band <= 500:
        raise ValueError()
    return {"type": kind, "limit_band_bps": float(band), "time_in_force": "day"}


def credential_path():
    # Override is server configuration, never a browser-provided path.
    configured = os.getenv("ALPHAVIEW_ALPACA_CREDENTIALS_PATH")
    return Path(configured).expanduser() if configured else store.db_path().with_suffix(".alpaca-paper.json")


def _problem(code, message, status=502):
    return HTTPException(status, {"code": code, "message": message})


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
        raise _problem("credential_file", "無法安全讀取本機 Alpaca 金鑰設定", 503) from None
    try:
        with os.fdopen(fd) as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid() or info.st_size > 4096:
                raise ValueError()
            value = json.load(handle)
        parsed = ConnectionInput(api_key=value["api_key"], secret_key=value["secret_key"])
        if value["endpoint"] != BASE_URL or value["schema_version"] != 1:
            raise ValueError()
        if not re.fullmatch(r"[a-f0-9]{32}", value["version"]):
            raise ValueError()
        if not isinstance(value["account_id"], str) or not value["account_id"]:
            raise ValueError()
        if not isinstance(value["connected_at"], str) or not value["connected_at"]:
            raise ValueError()
        enabled = value.get("orders_enabled", False)
        if not isinstance(enabled, bool):
            raise ValueError()
        return {**value, "api_key": parsed.api_key.get_secret_value(), "secret_key": parsed.secret_key.get_secret_value(),
                "orders_enabled": enabled, "order_caps": _order_caps(value.get("order_caps")),
                "order_style": _order_style(value.get("order_style"))}
    except (ValueError, KeyError, TypeError, OSError):
        raise _problem("credential_file", "Alpaca 設定無效；請檢查本機設定檔內容、擁有者與 0600 權限", 503) from None


def _write_config(config):
    path = credential_path()
    fd, temporary = tempfile.mkstemp(prefix=".alpaca-", dir=path.parent)
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


def _public(config):
    enabled = bool(config and config.get("orders_enabled"))
    return {"engine_version": ENGINE_VERSION, "orders_version": ORDERS_VERSION, "provider": "Alpaca", "environment": "paper",
            "endpoint": BASE_URL, "configured": config is not None,
            "version": config["version"] if config else None,
            "connected_at": config["connected_at"] if config else None,
            "capabilities": ["account.read", "positions.read", "orders.read", "clock.read",
                             *(["orders.submit", "orders.cancel"] if enabled else [])],
            "orders_enabled": enabled, "order_caps": config["order_caps"] if config else None,
            "order_style": config["order_style"] if config else None,
            "enable_confirmation": ENABLE_CONFIRMATION, "method": METHOD}


def _json(response, started):
    chunks, size = [], 0
    for chunk in response.iter_content(chunk_size=16_384):
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES or time.monotonic() - started > 15:
            raise _problem("response_limit", "Alpaca 回應超過大小或時間上限；資料未採用")
        chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks), parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError):
        raise _problem("invalid_response", "Alpaca 回應不是有效的有限 JSON", 502) from None


def _get(config, path, params=None):
    if path not in GET_PATHS or config.get("endpoint", BASE_URL) != BASE_URL:
        raise _problem("paper_only", "僅允許指定的 Alpaca Paper 唯讀端點", 422)
    started = time.monotonic()
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.get(BASE_URL + path, params=params, headers={
                "APCA-API-KEY-ID": config["api_key"], "APCA-API-SECRET-KEY": config["secret_key"],
                "Accept": "application/json",
            }, timeout=(4, 10), allow_redirects=False, stream=True) as response:
                if response.status_code in (401, 403):
                    raise _problem("authentication_failed", "Paper 金鑰未通過驗證；請確認帳戶、Key 與 Secret", 401)
                if response.status_code == 429:
                    raise _problem("rate_limited", "Alpaca 要求降低請求頻率；請稍後再更新", 503)
                if response.status_code != 200:
                    raise _problem("provider_unavailable", "Alpaca 未成功回應；本次資料不可用")
                return _json(response, started)
    except requests.RequestException:
        # Do not return exception text, response bodies or credential-bearing requests.
        raise _problem("network_unavailable", "無法連線至 Alpaca Paper，請檢查網路後重試", 503) from None


def _request(config, method, path, params=None, payload=None):
    """Order transport: paper host only, explicit opt-in, fixed paths, no redirects.

    Returns (status_code, decoded JSON or None). 4xx order rejections are returned
    to the caller as data; authentication, rate limits, provider failures and
    transport errors raise so the caller can record an unknown outcome.
    """
    pattern = ORDER_PATHS.get(method)
    if pattern is None or not pattern.fullmatch(path) or config.get("endpoint", BASE_URL) != BASE_URL:
        raise _problem("paper_only", "僅允許指定的 Alpaca Paper 委託端點", 422)
    if not config.get("orders_enabled"):
        raise _problem("orders_disabled", "Alpaca Paper 委託能力尚未啟用", 409)
    started = time.monotonic()
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.request(method, BASE_URL + path, params=params, json=payload, headers={
                "APCA-API-KEY-ID": config["api_key"], "APCA-API-SECRET-KEY": config["secret_key"],
                "Accept": "application/json",
            }, timeout=(4, 15), allow_redirects=False, stream=True) as response:
                if response.status_code == 401:
                    raise _problem("authentication_failed", "Paper 金鑰未通過驗證；請確認帳戶、Key 與 Secret", 401)
                if response.status_code == 429:
                    raise _problem("rate_limited", "Alpaca 要求降低請求頻率；請稍後再核對", 503)
                if response.status_code >= 500 or 300 <= response.status_code < 400:
                    raise _problem("provider_unavailable", "Alpaca 未成功回應；委託結果待核對")
                if response.status_code == 204:
                    return 204, None
                return response.status_code, _json(response, started)
    except requests.RequestException:
        raise _problem("network_unavailable", "無法連線至 Alpaca Paper；委託結果待核對", 503) from None


def _decimal(value):
    if value is None or isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    raw = str(value)
    if len(raw) > 100:
        return None
    try:
        number = Decimal(raw)
        if not number.is_finite() or abs(number) > Decimal("1e24"):
            return None
        return raw
    except InvalidOperation:
        return None


def _text(value, maximum=160):
    return value if isinstance(value, str) and len(value) <= maximum else None


def _account(value):
    if not isinstance(value, dict) or not _text(value.get("id")):
        raise _problem("invalid_account", "Alpaca 沒有回傳可驗證的帳戶身份")
    result = {key: _text(value.get(key)) for key in ("id", "account_number", "status", "currency", "created_at")}
    numeric = ("cash", "equity", "buying_power", "portfolio_value", "long_market_value", "short_market_value", "last_equity")
    result.update({key: _decimal(value.get(key)) for key in numeric})
    result.update({key: value.get(key) if isinstance(value.get(key), bool) else None
                   for key in ("trading_blocked", "transfers_blocked", "account_blocked", "trade_suspended_by_user", "shorting_enabled")})
    result["unavailable_fields"] = [key for key in numeric if result[key] is None]
    return result


def _positions(value):
    if not isinstance(value, list) or len(value) > 10_000 or any(not isinstance(row, dict) for row in value):
        raise _problem("invalid_positions", "Alpaca 持倉回應不完整或超過本版上限")
    rows = []
    numeric = ("qty", "qty_available", "avg_entry_price", "market_value", "cost_basis", "unrealized_pl", "unrealized_plpc", "current_price")
    for row in value:
        item = {key: _text(row.get(key)) for key in ("asset_id", "symbol", "asset_class", "exchange", "side")}
        item.update({key: _decimal(row.get(key)) for key in numeric})
        item["unavailable_fields"] = [key for key in numeric if item[key] is None]
        rows.append(item)
    return {"items": rows, "count": len(rows), "complete": True}


def _orders(value, limit):
    if not isinstance(value, list) or len(value) > limit or any(not isinstance(row, dict) for row in value):
        raise _problem("invalid_orders", "Alpaca 委託回應格式無法驗證")
    rows = []
    for row in value:
        item = {key: _text(row.get(key)) for key in (
            "id", "client_order_id", "symbol", "asset_class", "side", "type", "time_in_force", "status",
            "submitted_at", "filled_at", "canceled_at", "expired_at", "updated_at")}
        numeric = ("qty", "notional", "filled_qty", "filled_avg_price", "limit_price", "stop_price")
        item.update({key: _decimal(row.get(key)) for key in numeric})
        rows.append(item)
    return {"items": rows, "returned": len(rows), "limit": limit, "total": None,
            "possibly_truncated": len(rows) == limit,
            "scope": "latest_orders_by_submitted_at"}


def _clock(value):
    if not isinstance(value, dict) or not isinstance(value.get("is_open"), bool):
        raise _problem("invalid_clock", "Alpaca 市場時鐘不可用")
    return {key: value.get(key) if key == "is_open" else _text(value.get(key))
            for key in ("timestamp", "is_open", "next_open", "next_close")}


def save_connection(body: ConnectionInput):
    with _config_lock():
        existing = _read_config()
        if (existing["version"] if existing else None) != body.expected_version:
            raise _problem("connection_changed", "連線已被另一個操作更新；請重新載入後再設定", 409)
        # A new or rotated key always starts with orders disabled; enabling is a separate explicit step.
        config = {"schema_version": 1, "endpoint": BASE_URL, "api_key": body.api_key.get_secret_value(),
                  "secret_key": body.secret_key.get_secret_value(), "version": uuid.uuid4().hex,
                  "connected_at": store.now(), "orders_enabled": False, "order_caps": dict(DEFAULT_ORDER_CAPS),
                  "order_style": dict(DEFAULT_ORDER_STYLE)}
        account = _account(_get(config, "/v2/account"))
        config["account_id"] = account["id"]
        _write_config(config)
        return {**_public(config), "account": account, "verified_at": store.now()}


def set_orders_policy(body: OrdersPolicyInput):
    with _config_lock():
        config = _read_config()
        if config is None or config["version"] != body.expected_version:
            raise _problem("connection_changed", "連線已改變或尚未設定；請重新載入", 409)
        if body.orders_enabled and body.confirmation != ENABLE_CONFIRMATION:
            raise _problem("confirmation_required", f"啟用 Paper 委託必須輸入確認字串 {ENABLE_CONFIRMATION}", 422)
        updated = {**config, "version": uuid.uuid4().hex, "orders_enabled": body.orders_enabled,
                   "order_caps": {"max_order_notional_usd": float(body.max_order_notional_usd),
                                  "max_orders_per_submission": int(body.max_orders_per_submission),
                                  "max_volume_participation_pct": float(body.max_volume_participation_pct)},
                   "order_style": {"type": body.order_type, "limit_band_bps": float(body.limit_band_bps), "time_in_force": "day"}}
        _write_config(updated)
        return _public(updated)


@router.post("/api/alpaca-paper/orders-policy")
def orders_policy(body: OrdersPolicyInput):
    return JSONResponse(set_orders_policy(body), headers={"Cache-Control": "no-store"})


@router.get("/api/alpaca-paper/connection")
def connection():
    return JSONResponse(_public(_read_config()), headers={"Cache-Control": "no-store"})


@router.post("/api/alpaca-paper/connection")
async def configure(request: Request):
    # Manual validation deliberately strips secret values from error responses.
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 4096:
            raise _problem("invalid_credentials", "金鑰設定請求過大", 422)
    try:
        body = ConnectionInput.model_validate(json.loads(raw))
    except (ValueError, ValidationError, TypeError):
        raise _problem("invalid_credentials", "請提供 Paper API Key、Secret 與目前連線版本；不接受其他設定", 422) from None
    value = await asyncio.to_thread(save_connection, body)
    return JSONResponse(value, headers={"Cache-Control": "no-store"})


@router.delete("/api/alpaca-paper/connection")
def disconnect(body: DisconnectInput):
    with _config_lock():
        config = _read_config()
        if config is None or config["version"] != body.expected_version:
            raise _problem("connection_changed", "連線已改變；請重新載入", 409)
        credential_path().unlink()
    return JSONResponse(_public(None), headers={"Cache-Control": "no-store"})


@router.get("/api/alpaca-paper/snapshot")
def snapshot(status: Literal["open", "closed", "all"] = "all", limit: int = Query(default=50, ge=1, le=100)):
    config = _read_config()
    if config is None:
        raise _problem("not_configured", "尚未設定 Alpaca Paper API 連線", 409)
    started = store.now()
    resources = {}
    specs = (("account", "/v2/account", None, _account), ("positions", "/v2/positions", None, _positions),
             ("orders", "/v2/orders", {"status": status, "limit": limit, "direction": "desc", "nested": "false"}, lambda value: _orders(value, limit)),
             ("clock", "/v2/clock", None, _clock))
    for name, path, params, normalize in specs:
        try:
            value = normalize(_get(config, path, params))
            if name == "account" and value["id"] != config["account_id"]:
                raise _problem("account_changed", "Alpaca 回傳帳戶身份與連線時不同；請重新設定", 409)
            resources[name] = {"status": "available", "fetched_at": store.now(), "data": value, "error": None}
        except HTTPException as error:
            resources[name] = {"status": "unavailable", "fetched_at": store.now(), "data": None, "error": error.detail}
            if name == "account":
                # Never attach unverified portfolio data to a different/unknown account.
                break
    for name, *_ in specs:
        resources.setdefault(name, {"status": "unavailable", "fetched_at": None, "data": None,
                                    "error": {"code": "account_unverified", "message": "帳戶未驗證，未讀取此資源"}})
    current = _read_config()
    if not current or current["version"] != config["version"]:
        raise _problem("connection_changed", "讀取期間連線已變更；本次資料未採用", 409)
    available = sum(row["status"] == "available" for row in resources.values())
    return JSONResponse({**_public(config), "started_at": started, "fetched_at": store.now(),
                         "status": "available" if available == 4 else "partial" if resources["account"]["status"] == "available" else "unavailable",
                         "coverage": {"available": available, "required": 4}, "order_filter": status,
                         "resources": resources}, headers={"Cache-Control": "no-store"})
