"""Fixed-period comparisons using only immutable captured paper-account NAV."""
import json
from datetime import date
from decimal import Decimal, localcontext
from typing import Annotated

from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator, model_validator

from . import paper_analytics as analytics, paper_portfolio as paper, sessions, store

router = APIRouter()
ENGINE_VERSION = "alphaview-paper-nav-comparison-v1"
MAX_SESSIONS = 1260
METHOD = (
    "只比較所選帳戶在同一指定 XNYS 起訖交易日的已擷取淨值；不從目前持倉、行情或較近日期重建歷史。"
    "每帳戶每日採最後一次不可覆寫觀測，所有來源方法與擷取版本逐點保留。"
    "只有全部帳戶在指定起日都有完整觀測，才以該日各自淨值設為 100 正規化；缺口仍留空。"
    "各帳戶的區間報酬、淨值變化與最大回落要求指定全區間每日皆完整，不能挪動起訖日。"
    "全部帳戶都完整時才計算兩兩報酬百分點及美元淨值變化差，依輸入帳戶順序排列、不做排名。"
    "最大回落為已觀測每日淨值相對此前最高值的最大跌幅，以非負百分比表示。"
    "帳戶無初始現金以外的外部資金流；不同初始現金下，美元變化差不能當作策略優劣。"
)
WARNINGS = [
    "這是同期間已擷取的虛擬帳戶觀測，不是實際投資績效、策略回測或未來報酬預測。",
    "任何未擷取、缺價或不支援方法版本保留空值；不以較早截止日或各帳戶不同起日替代。",
    "不同帳戶可有不同交易決策及費用假設；來源 paper 方法逐點保留，未控制相同風險與曝險。",
]


class ComparisonInput(paper.StrictInput):
    account_ids: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(min_length=2, max_length=5)
    start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")

    @field_validator("start", "end")
    @classmethod
    def valid_date(cls, value):
        date.fromisoformat(value)
        return value

    @model_validator(mode="after")
    def fixed_interval(self):
        if self.start >= self.end:
            raise ValueError("起日必須早於截止日，至少比較兩個交易日")
        if len(set(self.account_ids)) != len(self.account_ids):
            raise ValueError("比較帳戶不可重複")
        return self


def _dates(body, as_of):
    if body.end > as_of:
        raise HTTPException(422, "截止日不得晚於最新已完成交易日")
    calendar = sessions.calendar(date.fromisoformat(body.end).year)
    if body.start < calendar.first_session.date().isoformat():
        raise HTTPException(422, "指定起日超出本機交易日曆可用範圍，未自動移動起日")
    days = sessions.expected_sessions(body.start, body.end)
    if not days or days[0] != body.start or days[-1] != body.end:
        raise HTTPException(422, "起日與截止日都必須是 XNYS 交易日，未自動移動日期")
    if len(days) > MAX_SESSIONS:
        raise HTTPException(422, f"單次最多比較 {MAX_SESSIONS} 個交易日")
    return days


def _account_series(db, account, days):
    rows = db.execute("""SELECT * FROM paper_nav_snapshots
        WHERE account_id=? AND as_of>=? AND as_of<=? ORDER BY as_of,id""",
                      (account["id"], days[0], days[-1])).fetchall()
    captured = {}
    for row in rows:
        captured[row["as_of"]] = {"id": row["id"], **json.loads(row["snapshot_json"])}
    points = []
    for day in days:
        record = captured.get(day)
        supported = record is not None and record["engine_version"] == analytics.ENGINE_VERSION
        complete = supported and record["valuation_complete"] and record["equity"] is not None
        status = "complete" if complete else "unsupported_method" if record and not supported else "incomplete" if record else "not_captured"
        points.append({"as_of": day, "equity": record["equity"] if complete else None,
                       "normalized100": None, "status": status,
                       "snapshot_id": record["id"] if record else None,
                       "observed_at": record["observed_at"] if record else None,
                       "account_version": record["account_version"] if record else None,
                       "input_revision": record["input_revision"] if record else None,
                       "paper_engine_version": record["paper_engine_version"] if record else None,
                       "analytics_engine_version": record["engine_version"] if record else None,
                       "quote_coverage": record["coverage"] if record else None})
    complete_count = sum(point["equity"] is not None for point in points)
    available = complete_count == len(days) and points[0]["equity"] > 0
    change = returned = drawdown = None
    if available:
        first, last = Decimal(str(points[0]["equity"])), Decimal(str(points[-1]["equity"]))
        change = float(last - first)
        returned = float((last / first - 1) * 100)
        peak, largest = first, Decimal(0)
        for point in points:
            value = Decimal(str(point["equity"]))
            peak = max(peak, value)
            if peak > 0:
                largest = max(largest, (1 - value / peak) * 100)
        drawdown = float(largest)
    missing = [point["as_of"] for point in points if point["equity"] is None]
    return {"account_id": account["id"], "name": account["name"],
            "current_account_version": account["version"], "initial_cash": float(account["initial_cash"]),
            "coverage": {"expected_sessions": len(days), "captured_sessions": len(captured),
                         "complete_sessions": complete_count, "missing_sessions": missing},
            "series": points, "start_equity": points[0]["equity"], "end_equity": points[-1]["equity"],
            "equity_change": change, "return_pct": returned, "max_drawdown_pct": drawdown,
            "performance_available": available,
            "reason": None if available else "指定區間有未擷取、缺價或不支援方法的觀測；不調整起訖日期"}


@router.post("/api/paper/nav/compare")
@store.snapshot_read
def compare_nav(body: ComparisonInput):
    with store.connect() as db, localcontext() as context:
        context.prec = 50
        as_of = sessions.latest_completed_session()
        days = _dates(body, as_of)
        results = [_account_series(db, paper._account(db, account_id), days) for account_id in body.account_ids]
        common_start = all(item["start_equity"] is not None and item["start_equity"] > 0 for item in results)
        if common_start:
            for account in results:
                base = Decimal(str(account["start_equity"]))
                for point in account["series"]:
                    if point["equity"] is not None:
                        point["normalized100"] = float(Decimal(str(point["equity"])) / base * 100)
        comparable = all(item["performance_available"] for item in results)
        pairs = []
        if comparable:
            for index, left in enumerate(results):
                for right in results[index + 1:]:
                    pairs.append({"left_id": left["account_id"], "right_id": right["account_id"],
                                  "return_difference_pp": float(Decimal(str(left["return_pct"])) - Decimal(str(right["return_pct"]))),
                                  "equity_change_difference": float(Decimal(str(left["equity_change"])) - Decimal(str(right["equity_change"]))),
                                  "left_initial_cash": left["initial_cash"], "right_initial_cash": right["initial_cash"]})
        return {"engine_version": ENGINE_VERSION, "as_of": as_of, "input_revision": store.input_revision(db),
                "period": {"start": body.start, "end": body.end, "session_count": len(days)},
                "common_start_complete": common_start, "comparable": comparable,
                "reason": None if comparable else "至少一個帳戶在指定共同區間觀測不完整，未計算跨帳戶差異或排名",
                "accounts": results, "comparisons": pairs, "method": METHOD, "warnings": WARNINGS}
