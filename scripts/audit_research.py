"""Read-only market backtest audit; never saves simulations or personal positions.

Run from the repository with:
  uv run --extra web python scripts/audit_research.py --max-seconds 600

The report distinguishes expected data/sample exclusions from actual invariant
failures. Passing this audit is not evidence of profitable trading strategies.
"""
import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import signal
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from alphaview.panel import market, research, store

STRATEGIES = ("turtle", "trend", "pullback")


class AuditStopped(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def validate(result):
    """Check output/accounting invariants independently of implementation steps."""
    json.dumps(result, allow_nan=False)
    curve = result["curve"]
    assert curve, "empty equity curve"
    dates = [point["date"] for point in curve]
    assert dates == sorted(set(dates)), "curve dates must be unique and increasing"
    assert dates[0] == result["start"] and dates[-1] == result["end"], "actual range differs from curve"
    assert all(result["start"] <= day <= result["end"] for day in dates), "curve outside actual range"
    options = result["parameters"]
    assert not options["start_date"] or dates[0] >= options["start_date"], "execution precedes requested period"
    assert not options["end_date"] or dates[-1] <= options["end_date"], "execution exceeds requested period"
    assert result["final"] == curve[-1]["value"], "final differs from last curve value"
    assert result["benchmark_symbol"] == result["symbol"], "benchmark basis is not the same symbol"
    assert result["trading_days"] == len(curve), "trading-day count differs from curve"
    assert all(point["value"] > 0 and point["benchmark"] > 0 for point in curve), "nonpositive equity"
    assert 0 <= options["fee_bps"] <= 100, "invalid transaction-cost input"
    assert options["initial"] == result["initial"] and result["initial"] > 0, "initial capital mismatch"
    assert math.isclose(result["return_pct"], (result["final"] / result["initial"] - 1) * 100, abs_tol=.005001), "return differs from equity"
    assert math.isclose(result["benchmark_pct"], (curve[-1]["benchmark"] / result["initial"] - 1) * 100, abs_tol=.005001), "benchmark return differs from equity"
    assert -100 <= result["max_drawdown_pct"] <= 0, "drawdown outside valid range"
    assert 0 <= result["exposure_pct"] <= 100, "exposure outside 0..100"
    assert result["win_rate_pct"] is None or 0 <= result["win_rate_pct"] <= 100, "win rate outside 0..100"
    assert result["profit_factor"] is None or result["profit_factor"] >= 0, "negative profit factor"
    assert result["annualized_volatility_pct"] is None or result["annualized_volatility_pct"] >= 0, "negative volatility"
    previous_exit = None
    for trade in result["trades"]:
        assert dates[0] <= trade["entry_date"] <= trade["exit_date"] <= dates[-1], "trade outside period or reversed"
        assert trade["entry_date"] in dates and trade["exit_date"] in dates, "trade on an unobserved day"
        assert previous_exit is None or previous_exit < trade["entry_date"], "overlapping closed trades"
        assert trade["entry_price"] > 0 and trade["exit_price"] > 0, "nonpositive fill price"
        assert trade["entry_fee"] >= 0 and trade["exit_fee"] >= 0, "negative fee"
        assert trade["holding_days"] >= 0, "negative duration"
        previous_exit = trade["exit_date"]
    if result["open_position"]:
        position = result["open_position"]
        assert dates[0] <= position["date"] <= dates[-1], "open position outside period"
        assert previous_exit is None or previous_exit < position["date"], "open position overlaps closed trade"
        assert position["fee"] >= 0 and position["units"] > 0, "invalid open-position accounting"
    if len(result["trades"]) < 30 or len(curve) < 126:
        assert result["warnings"], "small sample lacks warning"
    assert result["engine_version"] == research.BACKTEST_ENGINE_VERSION, "engine version mismatch"
    assert len(result["input_fingerprint"]) == 64, "missing input fingerprint"


def atomic_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def run(directory, output, max_seconds):
    started = time.monotonic()
    report = {"started_at": now(), "engine_version": research.BACKTEST_ENGINE_VERSION,
              "scope": "market", "read_only": True, "max_seconds": max_seconds,
              "status": "running", "stop_reason": None, "cases": []}
    stop_at = started + max_seconds
    state_path = directory / "state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text())
        deadline = datetime.fromisoformat(state["deadline"].replace("Z", "+00:00"))
        stop_at = min(stop_at, started + max(0, (deadline - datetime.now(timezone.utc)).total_seconds()))
        report["harness_deadline"] = deadline.isoformat()

    def check_stop():
        if (directory / "STOP").exists():
            raise AuditStopped("harness_stop_marker")
        if time.monotonic() >= stop_at:
            raise AuditStopped("wall_budget_or_harness_deadline")

    def alarm(signum, frame):
        raise AuditStopped("wall_budget_or_harness_deadline")

    members = []
    original_alarm = signal.signal(signal.SIGALRM, alarm)
    try:
        check_stop()
        signal.setitimer(signal.ITIMER_REAL, max(.001, stop_at - time.monotonic()))
        members = store.universe("market")
        report["market_symbol_count"] = len(members)
        report["market_metadata"] = market.universe_metadata()
        for index, member in enumerate(members):
            check_stop()
            symbol = member["symbol"]
            frame = store.history(symbol)
            assessment = market.history_quality(frame)
            for strategy in STRATEGIES:
                check_stop()
                case_started = time.monotonic()
                case = {"symbol": symbol, "strategy": strategy, "bars": len(frame)}
                required = 41 if strategy == "turtle" else 220
                if not assessment["valid"]:
                    case.update(status="excluded", category="data_quality", reason=assessment["status"], issues=assessment["issues"])
                elif len(frame) < required:
                    case.update(status="excluded", category="short_sample", reason=f"Requires {required} bars, observed {len(frame)}")
                else:
                    try:
                        result = research.backtest(symbol, strategy)
                        validate(result)
                        case.update(status="passed", start=result["start"], end=result["end"],
                                    trading_days=result["trading_days"], closed_trades=len(result["trades"]),
                                    warning_count=len(result["warnings"]), input_fingerprint=result["input_fingerprint"])
                    except AuditStopped:
                        raise
                    except Exception as exc:
                        case.update(status="failed", category=type(exc).__name__, reason=str(exc)[:1000])
                case["elapsed_seconds"] = round(time.monotonic() - case_started, 6)
                report["cases"].append(case)
            if (index + 1) % 25 == 0:
                print(json.dumps({"symbols_checked": index + 1, "total": len(members),
                                  "elapsed_seconds": round(time.monotonic() - started, 2)}), flush=True)
        report["status"] = "completed"
    except AuditStopped as exc:
        report["status"], report["stop_reason"] = "stopped", str(exc)
    except Exception as exc:
        report["status"], report["stop_reason"] = "failed", f"{type(exc).__name__}: {exc}"
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, original_alarm)
        cases = report["cases"]
        report.update(finished_at=now(), elapsed_seconds=round(time.monotonic() - started, 3),
                      counts={status: sum(case["status"] == status for case in cases) for status in ("passed", "excluded", "failed")},
                      cases_expected=len(members) * len(STRATEGIES), cases_checked=len(cases))
        report["cases_unchecked"] = report["cases_expected"] - report["cases_checked"]
        report["failures"] = [case for case in cases if case["status"] == "failed"]
        atomic_report(output, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "artifacts/harness-2026-09-05")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-seconds", type=float, default=600)
    args = parser.parse_args()
    if not math.isfinite(args.max_seconds) or not 0 < args.max_seconds <= 600:
        parser.error("--max-seconds must be in (0, 600]")
    output = args.output or args.directory / "research-audit.json"
    report = run(args.directory, output, args.max_seconds)
    print(json.dumps({"report": str(output), **{key: report[key] for key in
          ("status", "counts", "cases_checked", "cases_expected", "elapsed_seconds", "stop_reason")}}, ensure_ascii=False), flush=True)
    return 1 if report["status"] == "failed" or report["counts"]["failed"] else 2 if report["status"] == "stopped" else 0


if __name__ == "__main__":
    raise SystemExit(main())
