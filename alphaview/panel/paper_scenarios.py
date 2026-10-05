"""Read-only deterministic price-shock comparisons of current and proposed paper holdings."""
from decimal import Decimal, localcontext

from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator, model_validator

from . import paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-paper-scenarios-v1"
METHOD = (
    "在同一本機讀取快照內，將目前虛擬持倉與最多五組完整目標方案分別比較。"
    "每個方案先由現行 paper 方法驗算費用、滑價、股數精度、最低交易額及限制；"
    "未通過的方案保留 blocked，不計可執行情境結果。"
    "情境價格＝最新已完成交易日未調整收盤價×(1＋假設漲跌幅)，個股設定取代全體設定。"
    "現金不隨股價震盪改變；震盪損益以方案模擬後淨值為基準，總變動以目前模擬前淨值為基準、包含新增執行成本。"
    "集中度與現金限制同時檢查模擬後及震盪後權重；最差部位指美元損益最小者。"
    "缺任一必要新鮮報價時不補值、不重配；沒有保存提案、模擬成交或更動帳戶。"
)
WARNINGS = [
    "價格震盪是使用者自行設定的假設，不是未來預測、機率、VaR 或投資建議。",
    "情境為單次同時價格變動，未模擬交易路徑、流動性、稅、股息、拆併股、融資或追繳。",
    "方案使用目前帳戶的執行政策；blocked 方案必須修改後重新預覽才可建立可執行提案。",
]


class SymbolShock(paper.StrictInput):
    symbol: str = Field(min_length=1, max_length=20, pattern=r"^[A-Z0-9][A-Z0-9.\-^=]{0,19}$")
    shock_pct: float = Field(ge=-99, le=200, strict=True)

    @field_validator("symbol", mode="before")
    @classmethod
    def normalize_symbol(cls, value):
        return value.strip().upper() if isinstance(value, str) else value


class ScenarioPlan(paper.StrictInput):
    name: str = Field(min_length=1, max_length=60)
    targets: list[paper.TargetWeight] = Field(max_length=paper.MAX_HOLDINGS)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("請輸入方案名稱")
        return value

    @model_validator(mode="after")
    def valid_full_targets(self):
        paper.PreviewInput(expected_version=1, targets=self.targets)
        return self


class ScenarioInput(paper.StrictInput):
    expected_version: int = Field(ge=1, strict=True)
    global_shock_pct: float = Field(ge=-99, le=200, strict=True)
    symbol_shocks: list[SymbolShock] = Field(default_factory=list, max_length=100)
    plans: list[ScenarioPlan] = Field(default_factory=list, max_length=5)

    @model_validator(mode="after")
    def unique_names_and_shocks(self):
        if len({row.symbol for row in self.symbol_shocks}) != len(self.symbol_shocks):
            raise ValueError("個股情境代碼不可重複")
        if len({plan.name.casefold() for plan in self.plans}) != len(self.plans):
            raise ValueError("方案名稱不可重複")
        return self


def _base_case(name, kind, status, coverage, base_equity, cash, preview=None):
    return {"name": name, "kind": kind, "status": status, "coverage": coverage,
            "base_equity": base_equity, "posttrade_equity": None, "stressed_equity": None,
            "cash": cash, "cash_weight_pct": None, "stressed_cash_weight_pct": None,
            "cost_total": 0 if preview is None else preview["cost_total"],
            "fees_total": 0 if preview is None else preview["fees_total"],
            "slippage_total": 0 if preview is None else preview["slippage_total"],
            "shock_pnl": None, "shock_return_pct": None, "total_pnl": None, "total_return_pct": None,
            "largest_weight_pct": None, "stressed_largest_weight_pct": None,
            "worst_position": None, "positions": [], "policy_breaches": [], "preview": preview}


def _stress(case, quantities, quotes, cash, baseline, global_shock, overrides, limits):
    rows = []
    before, stressed = cash, cash
    for symbol, shares in sorted(quantities.items()):
        if shares <= 0:
            continue
        price = Decimal(str(quotes[symbol]["price"]))
        shock = Decimal(str(overrides.get(symbol, global_shock)))
        stressed_price = price * (1 + shock / 100)
        value, stressed_value = shares * price, shares * stressed_price
        before += value
        stressed += stressed_value
        rows.append({"symbol": symbol, "shares": float(shares), "base_price": float(price),
                     "shock_pct": float(shock), "stressed_price": float(stressed_price),
                     "base_value": float(value), "stressed_value": float(stressed_value),
                     "pnl": float(stressed_value - value), "weight_pct": None, "stressed_weight_pct": None})
    breaches = []
    for row in rows:
        weight = Decimal(str(row["base_value"])) / before * 100 if before > 0 else None
        stressed_weight = Decimal(str(row["stressed_value"])) / stressed * 100 if stressed > 0 else None
        row["weight_pct"] = float(weight) if weight is not None else None
        row["stressed_weight_pct"] = float(stressed_weight) if stressed_weight is not None else None
        if weight is not None and weight > Decimal(str(limits["max_position_weight_pct"])):
            breaches.append({"code": "base_max_position_weight", "message": "震盪前單一部位權重超過帳戶上限", "symbol": row["symbol"]})
        if stressed_weight is not None and stressed_weight > Decimal(str(limits["max_position_weight_pct"])):
            breaches.append({"code": "stressed_max_position_weight", "message": "震盪後單一部位權重超過帳戶上限", "symbol": row["symbol"]})
    cash_weight = cash / before * 100 if before > 0 else None
    stressed_cash_weight = cash / stressed * 100 if stressed > 0 else None
    minimum_cash = Decimal(str(limits["min_cash_weight_pct"]))
    if cash_weight is not None and cash_weight < minimum_cash:
        breaches.append({"code": "base_min_cash_weight", "message": "震盪前現金比例低於帳戶下限"})
    if stressed_cash_weight is not None and stressed_cash_weight < minimum_cash:
        breaches.append({"code": "stressed_min_cash_weight", "message": "震盪後現金比例低於帳戶下限"})
    worst = min(rows, key=lambda row: (row["pnl"], row["symbol"])) if rows else None
    case.update(posttrade_equity=float(before), stressed_equity=float(stressed), cash=float(cash),
                cash_weight_pct=float(cash_weight) if cash_weight is not None else None,
                stressed_cash_weight_pct=float(stressed_cash_weight) if stressed_cash_weight is not None else None,
                shock_pnl=float(stressed - before),
                shock_return_pct=float((stressed / before - 1) * 100) if before > 0 else None,
                total_pnl=float(stressed - baseline),
                total_return_pct=float((stressed / baseline - 1) * 100) if baseline > 0 else None,
                largest_weight_pct=max((row["weight_pct"] for row in rows), default=0) if before > 0 else None,
                stressed_largest_weight_pct=max((row["stressed_weight_pct"] for row in rows), default=0) if stressed > 0 else None,
                worst_position={key: worst[key] for key in ("symbol", "pnl", "shock_pct")} if worst else None,
                positions=rows, policy_breaches=breaches)
    return case


@router.post("/api/paper/accounts/{account_id}/scenarios/compare")
@store.snapshot_read
def compare_scenarios(account_id: str, body: ScenarioInput):
    with store.connect() as db, localcontext() as context:
        context.prec = 50
        as_of = sessions.latest_completed_session()
        revision = store.input_revision(db)
        account = paper._account(db, account_id)
        paper._version(account, body.expected_version)
        held = {row["symbol"]: Decimal(row["shares"]) for row in paper._holdings(db, account_id)}
        relevant = set(held) | {target.symbol for plan in body.plans for target in plan.targets if target.weight_pct > 0}
        unused = sorted({item.symbol for item in body.symbol_shocks} - relevant)
        if unused:
            raise HTTPException(422, "個股情境未用於目前持倉或任一正權重方案：" + ", ".join(unused))
        overrides = {item.symbol: item.shock_pct for item in body.symbol_shocks}
        quotes = {symbol: paper._quote(db, symbol, as_of) for symbol in held}
        missing = [symbol for symbol in held if quotes[symbol]["price"] is None]
        coverage = {"required": len(held), "priced": len(held) - len(missing), "missing": missing}
        cash = Decimal(account["cash"])
        baseline = cash + sum((quantity * Decimal(str(quotes[symbol]["price"]))
                               for symbol, quantity in held.items()), Decimal(0)) if not missing else None
        limits = paper._public_account(account)["limits"]
        current = _base_case("目前持倉", "current", "unavailable" if missing else "available",
                             coverage, float(baseline) if baseline is not None else None, float(cash))
        if missing:
            current["policy_breaches"] = [{"code": "quote_unavailable", "symbol": symbol, "message": quotes[symbol]["reason"]} for symbol in missing]
            current["positions"] = [{"symbol": symbol, "shares": float(quantity), "base_price": quotes[symbol]["price"],
                                     "shock_pct": overrides.get(symbol, body.global_shock_pct), "stressed_price": None,
                                     "base_value": None, "stressed_value": None, "pnl": None, "weight_pct": None,
                                     "stressed_weight_pct": None} for symbol, quantity in held.items()]
        else:
            current = _stress(current, held, quotes, cash, baseline, body.global_shock_pct, overrides, limits)
        plans = []
        for plan in body.plans:
            preview = paper._build_preview(db, account_id,
                paper.PreviewInput(expected_version=body.expected_version, targets=plan.targets,
                                   expected_input_revision=revision, expected_as_of=as_of), as_of)
            case = _base_case(plan.name, "plan", "available" if preview["executable"] else "blocked",
                              preview["coverage"], float(baseline) if baseline is not None else None,
                              preview["cash_after"], preview)
            if not preview["executable"]:
                case.update(posttrade_equity=preview["equity_after"], cash_weight_pct=preview["cash_weight_after_pct"],
                            policy_breaches=preview["violations"])
                plans.append(case)
                continue
            projected = dict(held)
            for order in preview["orders"]:
                quantity = Decimal(order["shares_exact"])
                projected[order["symbol"]] = projected.get(order["symbol"], Decimal(0)) + (quantity if order["side"] == "buy" else -quantity)
            plan_quotes = {row["symbol"]: row for row in preview["quote_details"]}
            plans.append(_stress(case, projected, plan_quotes, Decimal(preview["cash_after_exact"]),
                                 baseline, body.global_shock_pct, overrides, limits))
        return {"engine_version": ENGINE_VERSION, "paper_engine_version": paper.ENGINE_VERSION,
                "as_of": as_of, "input_revision": revision, "account_version": account["version"],
                "shock": {"global_shock_pct": body.global_shock_pct,
                          "symbol_shocks": [item.model_dump() for item in body.symbol_shocks]},
                "limits": limits, "current": current, "plans": plans, "method": METHOD, "warnings": WARNINGS}
