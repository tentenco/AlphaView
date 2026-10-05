"""Read-only fee/slippage repricing of one trusted paper allocation's fixed orders."""
import math
from datetime import date
from decimal import Decimal, localcontext
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field, model_validator

from . import paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-paper-cost-sensitivity-v1"
Rate = Annotated[float, Field(ge=0, le=1000, strict=True, allow_inf_nan=False)]
METHOD = (
    "Read-only fixed-order sensitivity for one complete target allocation. Rebuild one trusted paper preview "
    "using the current account policy and latest completed-session unadjusted USD closes. Verify account, "
    "market revision, session, paper method and supplied order identity. Freeze its quantities, precision and "
    "minimum-trade skips. For each explicit fee/slippage pair, reprice adverse fills, notionals and fees using "
    "the paper engine's 8-decimal half-even money rounding. Recheck cash, equity and concentration after costs; "
    "retain every baseline violation. No alternate sizing or policy change. Up to 5 unique finite values per "
    "axis (0–1000 bps), 25 cells. Participation = fixed order shares / exact completed-session local volume * "
    "100. Missing, zero or non-finite volume stays unavailable; no prior volume or market-impact estimate. "
    "No proposal, fill, order, provider call or configuration write."
)
WARNINGS = [
    "成本格點是使用者指定的假設，不是券商報價、成交預測、流動性模型或交易建議。",
    "只替相同股數重新計價；不自動縮單、不分配缺失權重、不修改帳戶執行政策。",
    "日成交量參與率不等於可成交容量，也不能推算真實滑價；缺量時仍只顯示明確假設的成本。",
    "基準限制未通過時，低成本假設不會解除原本阻擋；需重新預覽才能檢查可執行提案。",
]


class OrderIdentity(paper.StrictInput):
    symbol: str = Field(min_length=1, max_length=20)
    side: Literal["buy", "sell"]
    shares: float = Field(gt=0, strict=True, allow_inf_nan=False)
    reference_price: float = Field(gt=0, strict=True, allow_inf_nan=False)


class SensitivityInput(paper.StrictInput):
    expected_version: int = Field(ge=1, strict=True)
    expected_input_revision: str = Field(min_length=1, max_length=100)
    expected_as_of: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_engine_version: str = Field(min_length=1, max_length=100)
    targets: list[paper.TargetWeight] = Field(max_length=paper.MAX_HOLDINGS)
    expected_orders: list[OrderIdentity] = Field(max_length=paper.MAX_HOLDINGS * 2)
    fee_bps: list[Rate] = Field(min_length=1, max_length=5)
    slippage_bps: list[Rate] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def validate_request(self):
        date.fromisoformat(self.expected_as_of)
        paper.PreviewInput(expected_version=self.expected_version, targets=self.targets)
        if len(set(self.fee_bps)) != len(self.fee_bps) or len(set(self.slippage_bps)) != len(self.slippage_bps):
            raise ValueError("每組成本假設不可重複")
        if len({row.symbol for row in self.expected_orders}) != len(self.expected_orders):
            raise ValueError("來源委託代碼不可重複")
        return self


def _identities(orders):
    return sorted([{key: row[key] for key in ("symbol", "side", "shares", "reference_price")} for row in orders],
                  key=lambda row: (row["side"] != "sell", row["symbol"]))


def _liquidity(db, preview, as_of):
    rows = []
    for order in preview["orders"]:
        row = db.execute("SELECT volume FROM bars WHERE symbol=? AND date=?", (order["symbol"], as_of)).fetchone()
        volume, participation, reason = None, None, None
        if row is None or row["volume"] is None:
            reason = "missing_session_volume"
        else:
            try:
                observed = Decimal(str(row["volume"]))
            except ArithmeticError:
                observed = Decimal("NaN")
            if not observed.is_finite() or observed <= 0:
                reason = "nonpositive_or_nonfinite_volume"
            else:
                volume = float(observed)
                calculated = float(Decimal(order["shares_exact"]) / observed * 100)
                if math.isfinite(calculated):
                    participation = calculated
                else:
                    reason = "nonfinite_participation"
        rows.append({"symbol": order["symbol"], "side": order["side"], "shares": order["shares"],
                     "session": as_of, "session_volume": volume, "participation_pct": participation,
                     "status": "available" if reason is None else "unavailable", "reason": reason})
    available = sum(row["status"] == "available" for row in rows)
    return {"status": "unavailable" if not rows else "complete" if available == len(rows) else "incomplete",
            "coverage": {"required": len(rows), "available": available, "unavailable": len(rows) - available},
            "reason": "no_planned_orders" if not rows else None, "orders": rows}


def _case(preview, projected_values, cash_before, fee_bps, slippage_bps):
    row = {"fee_bps": fee_bps, "slippage_bps": slippage_bps, "status": "unavailable",
           "fees_total": None, "slippage_total": None, "cost_total": None, "cost_change_vs_baseline": None,
           "cash_after": None, "equity_after": None, "cash_weight_after_pct": None,
           "largest_weight_after_pct": None, "violations": list(preview["violations"]), "reason": None}
    if not preview["valuation_complete"] or preview["equity_before"] is None:
        row["reason"] = "valuation_unavailable"
        return row
    if not preview["orders"]:
        row["reason"] = "no_planned_orders"
        return row
    fee_rate, slip_rate = Decimal(str(fee_bps)) / 10000, Decimal(str(slippage_bps)) / 10000
    fees, slippage, cash = Decimal(0), Decimal(0), cash_before
    for order in preview["orders"]:
        quantity, price = Decimal(order["shares_exact"]), Decimal(str(order["reference_price"]))
        buying = order["side"] == "buy"
        reference = paper._money(quantity * price)
        fill = paper._money(price * (1 + slip_rate if buying else 1 - slip_rate))
        notional = paper._money(quantity * fill)
        fee = paper._money(notional * fee_rate)
        fees += fee
        slippage += notional - reference if buying else reference - notional
        cash += -(notional + fee) if buying else notional - fee
    equity = cash + sum(projected_values.values(), Decimal(0))
    weight = cash / equity * 100 if equity > 0 else None
    limits = preview["limits"]

    def violation(code, message, symbol=None):
        if not any(item["code"] == code and item.get("symbol") == symbol for item in row["violations"]):
            row["violations"].append({"code": code, "message": message, **({"symbol": symbol} if symbol else {})})

    if cash < 0:
        violation("insufficient_cash", "成本假設後現金不足；未縮減股數")
    if equity <= 0:
        violation("nonpositive_equity", "成本假設後淨值不是正數")
    if weight is not None and weight < Decimal(str(limits["min_cash_weight_pct"])):
        violation("min_cash_weight", "成本假設後現金比例低於帳戶下限")
    largest = None
    for symbol, market_value in projected_values.items():
        actual = market_value / equity * 100 if equity > 0 else None
        if actual is not None:
            largest = max(largest, actual) if largest is not None else actual
            if actual > Decimal(str(limits["max_position_weight_pct"])):
                violation("post_policy_max_position_weight", "成本假設後持倉權重超過帳戶上限", symbol)
    row.update(status="blocked" if row["violations"] else "calculated", fees_total=float(fees),
               slippage_total=float(slippage), cost_total=float(fees + slippage),
               cost_change_vs_baseline=float(fees + slippage - Decimal(str(preview["cost_total"]))),
               cash_after=float(cash), equity_after=float(equity),
               cash_weight_after_pct=float(weight) if weight is not None else None,
               largest_weight_after_pct=float(largest) if largest is not None else 0.0 if equity > 0 else None)
    return row


@router.post("/api/paper/accounts/{account_id}/cost-sensitivity")
@store.snapshot_read
def compare_costs(account_id: str, body: SensitivityInput):
    with store.connect() as db, localcontext() as context:
        context.prec = 50
        as_of = sessions.latest_completed_session()
        if body.expected_engine_version != paper.ENGINE_VERSION:
            raise HTTPException(409, "模擬方法已變更；請重新預覽後比較成本")
        preview = paper._build_preview(db, account_id, paper.PreviewInput(
            expected_version=body.expected_version, expected_input_revision=body.expected_input_revision,
            expected_as_of=body.expected_as_of, targets=body.targets), as_of)
        if _identities(preview["orders"]) != _identities([row.model_dump() for row in body.expected_orders]):
            raise HTTPException(409, "來源委託與目前預覽不一致；請重新預覽後比較成本")
        account = paper._account(db, account_id)
        quantities = {row["symbol"]: Decimal(row["shares"]) for row in paper._holdings(db, account_id)}
        for order in preview["orders"]:
            delta = Decimal(order["shares_exact"]) * (1 if order["side"] == "buy" else -1)
            quantities[order["symbol"]] = quantities.get(order["symbol"], Decimal(0)) + delta
        prices = {row["symbol"]: row["price"] for row in preview["quote_details"]}
        projected = {symbol: quantity * Decimal(str(prices[symbol])) for symbol, quantity in quantities.items()
                     if quantity > 0 and prices.get(symbol) is not None}
        liquidity = _liquidity(db, preview, as_of)
        cases = [_case(preview, projected, Decimal(account["cash"]), fee, slip)
                 for fee in body.fee_bps for slip in body.slippage_bps]
        return {"engine_version": ENGINE_VERSION, "paper_engine_version": paper.ENGINE_VERSION,
                "account_id": account_id, "account_version": account["version"], "as_of": as_of,
                "input_revision": preview["input_revision"], "targets": preview["targets"],
                "baseline_fingerprint": paper._fingerprint(preview), "request": body.model_dump(),
                "baseline": {key: preview[key] for key in ("execution_policy", "executable", "violations", "coverage",
                    "equity_before", "cash_before", "fees_total", "slippage_total", "cost_total", "cash_after",
                    "equity_after", "orders", "skipped_orders")},
                "liquidity": liquidity, "scenarios": cases, "method": METHOD, "warnings": list(WARNINGS)}
