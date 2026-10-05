"""Bounded CSCV rank stability within an explicitly selected set of immutable trials."""
from itertools import combinations
import math
import statistics

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import Field, model_validator

from . import paper_portfolio as paper, sessions, store
from . import workflow_path_receipts as receipts, workflow_path_receipt_comparison as comparison

ENGINE_VERSION = "alphaview-workflow-path-cscv-v1"
MAX_BYTES, REQUIRED_SESSIONS, BLOCKS, BLOCK_SIZE = 16 * 1024 * 1024, 252, 6, 42
SPLITS = tuple(combinations(range(BLOCKS), BLOCKS // 2))
SOURCE = "https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf"
METHOD = (
    "Selected-set CSCV rank-stability diagnostic of 3–8 distinct verified same-account path-validation receipts. "
    "Reuse the strict immutable-receipt comparison basis; no path recomputation, date intersection, return filling "
    "or trial removal. Daily simple net returns are saved NAV_t / saved NAV_(t-1) - 1, with original initial cash "
    "as the first denominator. Keep all 252 synchronous observations in six chronological blocks of 42. "
    "Use all 20 combinations of three blocks against their complements, 126 observations each in original order. "
    "The fixed rank metric is arithmetic mean divided by sample standard deviation (ddof=1), daily risk-free "
    "rate zero, unannualized. Zero or nonfinite standard deviation or arithmetic makes that split unavailable. "
    "All exact IS maxima share each split's weight equally; no tolerance defines a tie. OOS scores receive "
    "ascending average ranks. omega = rank/(N+1), logit = ln(omega/(1-omega)). This symmetric tie treatment is "
    "an explicit extension of Bailey et al. Algorithm 2.3, not an undocumented tie break. Each split has weight "
    "1/20. Report weighted fractions at or below the median (logit<=0), strictly below (<0), and exactly at (=0) "
    "separately. Aggregate only when every trial and all 20 splits are valid. Identical complete trial "
    "configurations are disclosed and invalidate the aggregate, without removing receipts. Distinct settings "
    "with equal return series remain legitimate tied trials. Full original receipt payloads are retained. "
    "This describes only the selected saved trials; missing or discarded discovery trials are unknown. It is "
    "not complete-search PBO, independent folds, CPCV, purging/embargo, out-of-sample proof, a recommended "
    "configuration, a statistical pass threshold or an execution gate. No account or receipt writes."
)
WARNINGS = [
    "結果只描述選取的保存試驗；未保存、已捨棄或未選取的探索試驗未知，不能當成完整搜尋的 PBO。",
    "六個時間區塊重組成二十組互補切分，彼此重用資料，不是獨立樣本、CPCV、purging／embargo 或樣本外證明。",
    "同分採明示的對稱延伸：IS 並列最高者均分權重，OOS 用平均名次；包含中位數的比例必須連同嚴格低於及恰等於中位數一起閱讀。",
    "全部試驗都相同分數時，低於或等於中位數為 100%、嚴格低於為 0%、恰等於為 100%；不能單看第一個比例宣稱過度擬合。",
    "固定候選、保存設定、修訂資料與原始模擬成交假設仍有事後偏差；此診斷不重訓模型、不選出建議配置，也不提供交易或執行授權。",
]
router = APIRouter(route_class=receipts._FiniteRoute)


class TrialInput(paper.StrictInput):
    receipt_id: str = Field(pattern=receipts.HASH)
    expected_fingerprint: str = Field(pattern=receipts.HASH)


class CSCVInput(paper.StrictInput):
    expected_account_version: int = Field(ge=1, strict=True)
    trials: list[TrialInput] = Field(min_length=3, max_length=8)

    @model_validator(mode="after")
    def distinct(self):
        if len({trial.receipt_id for trial in self.trials}) != len(self.trials):
            raise ValueError("Select 3–8 distinct immutable trial receipts")
        return self


def _problem(code, status=409):
    return receipts._problem(code, code, status)


def _configuration(payload):
    baseline, workflow = payload["evidence"], payload["saved_workflow"]
    return {"settings": baseline["settings"], "workflow_request": workflow["request"],
            "workflow_kind": workflow["workflow_kind"], "candidate_symbols": baseline["candidate_symbols"],
            "rps_universe": baseline["rps_universe"]}


def _returns(evidence):
    dates = comparison._dates(evidence)
    if dates is None or len(dates) != REQUIRED_SESSIONS:
        return None
    previous = evidence.get("metrics", {}).get("initial_cash")
    if not comparison._finite(previous) or previous <= 0:
        return None
    result = []
    try:
        for point in evidence["curve"]:
            value = point["value"] / previous - 1
            if not comparison._finite(value):
                return None
            result.append(value)
            previous = point["value"]
    except (ValueError, OverflowError, ZeroDivisionError):
        return None
    return result


def _metric(values):
    try:
        if len(values) != 126 or not all(comparison._finite(value) for value in values):
            return None
        mean, deviation = statistics.mean(values), statistics.stdev(values)
        if not comparison._finite(mean) or not comparison._finite(deviation) or deviation <= 0:
            return None
        ratio = mean / deviation
        if not comparison._finite(ratio):
            return None
        return {"count": len(values), "mean": mean, "sample_sd": deviation, "ratio": ratio}
    except (ValueError, OverflowError, ZeroDivisionError):
        return None


def _average_ranks(values):
    return [1 + sum(other < value for other in values) + (sum(other == value for other in values) - 1) / 2
            for value in values]


def analyze(matrix, identifiers, preconditions=()):
    """Pure 252×N return-matrix diagnostic; every split and every trial is retained."""
    splits = []
    complete = (isinstance(matrix, list) and len(matrix) == REQUIRED_SESSIONS
        and 3 <= len(identifiers) <= 8 and all(isinstance(row, list) and len(row) == len(identifiers)
            and all(comparison._finite(value) for value in row) for row in matrix))
    blocking = list(preconditions)
    if not complete and "return_matrix_unavailable" not in blocking:
        blocking.append("return_matrix_unavailable")
    for number, inside in enumerate(SPLITS, 1):
        outside = tuple(index for index in range(BLOCKS) if index not in inside)
        indices = [[day for block in selected for day in range(block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE)]
                   for selected in (inside, outside)]
        scores, issues, selected, fractions = [], list(blocking), [], None
        for offset, identifier in enumerate(identifiers):
            metrics = [_metric([matrix[day][offset] for day in index]) for index in indices] if not blocking else [None, None]
            score_issues = []
            for name, metric in zip(("is", "oos"), metrics):
                if metric is None:
                    score_issues.append(f"{name}_metric_unavailable")
            scores.append({"receipt_id": identifier, "is": metrics[0], "oos": metrics[1], "reasons": score_issues})
            if score_issues:
                issues.append("trial_metric_unavailable")
        if not issues:
            best = max(item["is"]["ratio"] for item in scores)
            maxima = [index for index, item in enumerate(scores) if item["is"]["ratio"] == best]
            oos = [item["oos"]["ratio"] for item in scores]
            ranks = _average_ranks(oos)
            for index in maxima:
                omega = ranks[index] / (len(identifiers) + 1)
                selected.append({"receipt_id": identifiers[index], "weight": 1 / len(maxima),
                    "is_ratio": best, "oos_ratio": oos[index], "oos_average_rank": ranks[index],
                    "omega": omega, "logit": math.log(omega / (1 - omega))})
            fractions = {"at_or_below_median": math.fsum(item["weight"] for item in selected if item["logit"] <= 0),
                "strictly_below_median": math.fsum(item["weight"] for item in selected if item["logit"] < 0),
                "exactly_at_median": math.fsum(item["weight"] for item in selected if item["logit"] == 0)}
        splits.append({"split": number, "is_blocks": [index + 1 for index in inside], "oos_blocks": [index + 1 for index in outside],
            "is_row_indices": indices[0], "oos_row_indices": indices[1], "status": "unavailable" if issues else "evaluated",
            "reasons": sorted(set(issues)), "scores": scores, "is_maxima": selected, "fractions": fractions,
            "is_tie_count": len(selected) if not issues else None,
            "oos_has_ties": len(set(item["oos"]["ratio"] for item in scores)) < len(scores) if not issues else None})
    aggregate = None
    if all(item["status"] == "evaluated" for item in splits):
        aggregate = {key: math.fsum(item["fractions"][key] for item in splits) / len(splits)
            for key in ("at_or_below_median", "strictly_below_median", "exactly_at_median")}
        aggregate.update(split_weight=1 / len(splits), is_tied_splits=sum(item["is_tie_count"] > 1 for item in splits),
            oos_tied_splits=sum(item["oos_has_ties"] for item in splits))
    return splits, aggregate


@router.post(comparison.BASE + "/cscv")
@store.snapshot_read
def inspect_cscv(account_id: comparison.AccountId, body: CSCVInput):
    with store.connect() as db:
        account = paper._account(db, account_id)
        if account["version"] != body.expected_account_version:
            raise _problem("cscv_account_changed")
        checked_as_of = sessions.latest_completed_session()
        loaded = [comparison._read(db, account_id, trial.receipt_id, trial.expected_fingerprint) for trial in body.trials]
        if any(payload["kind"] != "path_validation" for _, payload in loaded):
            raise _problem("cscv_path_receipts_only", 422)
        payloads = [payload for _, payload in loaded]
        anchor = payloads[0]
        checks = [{"receipt_id": trial.receipt_id, "checks": comparison._basis(anchor, payload)}
            for trial, payload in zip(body.trials, payloads)]
        reasons = [{"code": check["code"], "receipt_id": group["receipt_id"]}
            for group in checks for check in group["checks"] if not check["matches"]]
        definitions, hashes, unavailable = [], [], []
        for trial, payload in zip(body.trials, payloads):
            try:
                definition = _configuration(payload)
                fingerprint = receipts._hash(definition)
            except (KeyError, TypeError, ValueError, OverflowError, RecursionError):
                unavailable.append(trial.receipt_id)
            else:
                definitions.append(definition)
                hashes.append(fingerprint)
        if unavailable:
            raise HTTPException(409, {"code": "cscv_trial_configuration_unavailable", "receipt_ids": unavailable,
                "coverage": {"required_trials": len(body.trials), "verified_trials": len(loaded),
                    "available_configurations": len(definitions), "unavailable_configurations": len(unavailable)}})
        groups = [{"configuration_fingerprint": fingerprint,
            "receipt_ids": [trial.receipt_id for trial, value in zip(body.trials, hashes) if value == fingerprint]}
            for fingerprint in dict.fromkeys(hashes) if hashes.count(fingerprint) > 1]
        if groups:
            reasons.append({"code": "duplicate_trial_configuration"})
        dates = comparison._dates(anchor["evidence"])
        if dates is None or len(dates) != REQUIRED_SESSIONS:
            reasons.append({"code": "required_252_sessions"})
        vectors = [_returns(payload["evidence"]) for payload in payloads] if not reasons else []
        if vectors and any(value is None for value in vectors):
            reasons.append({"code": "daily_return_unavailable"})
        matrix = [[vector[index] for vector in vectors] for index in range(REQUIRED_SESSIONS)] if not reasons else None
        identifiers = [trial.receipt_id for trial in body.trials]
        splits, aggregate = analyze(matrix, identifiers, [reason["code"] for reason in reasons])
        if aggregate is None and not reasons:
            reasons.append({"code": "split_metric_unavailable"})
        result = {"engine_version": ENGINE_VERSION, "comparison_engine_version": comparison.ENGINE_VERSION,
            "account_id": account_id, "account_version": account["version"], "request": body.model_dump(),
            "status": "evaluated" if aggregate is not None else "unavailable", "reasons": reasons,
            "coverage": {"required_trials": len(identifiers), "verified_trials": len(loaded), "required_sessions": REQUIRED_SESSIONS,
                "available_sessions": len(matrix) if matrix is not None else 0, "required_splits": len(SPLITS),
                "available_splits": sum(item["status"] == "evaluated" for item in splits)},
            "trials": [{"receipt_id": trial.receipt_id, "content_fingerprint": trial.expected_fingerprint,
                "configuration_fingerprint": fingerprint, "summary": receipts._view(db, row, detail=False), "original_receipt": payload}
                for trial, (row, payload), fingerprint in zip(body.trials, loaded, hashes)],
            "comparability": {"basis_checks": checks, "duplicate_configuration_groups": groups,
                "configuration_definition": "Complete baseline.settings, saved_workflow.request, workflow_kind, candidate_symbols and rps_universe",
                "settings_differences": [{"receipt_id": trial.receipt_id, "differences": comparison._differences(definitions[0], definition)}
                    for trial, definition in zip(body.trials, definitions)],
                "source_currentness_is_separate": True},
            "blocks": [{"block": index + 1, "first_row": index * BLOCK_SIZE, "last_row": (index + 1) * BLOCK_SIZE - 1,
                "start": dates[index * BLOCK_SIZE] if dates and len(dates) == REQUIRED_SESSIONS else None,
                "end": dates[(index + 1) * BLOCK_SIZE - 1] if dates and len(dates) == REQUIRED_SESSIONS else None}
                for index in range(BLOCKS)],
            "return_matrix": {"dates": dates, "columns": identifiers, "values": matrix} if matrix is not None else None,
            "splits": splits, "aggregate": aggregate, "rank_metric": {"name": "daily_mean_over_sample_sd", "sample_ddof": 1,
                "risk_free_daily": 0, "annualized": False, "higher_is_better": True},
            "tie_method": "exact_is_maxima_equal_weight__oos_ascending_average_rank",
            "diagnostic_scope": "selected_saved_trials_only", "execution_authority": False, "recommended_configuration": None,
            "checked_as_of": checked_as_of, "checked_input_revision": store.input_revision(db), "max_export_bytes": MAX_BYTES,
            "method": METHOD, "warnings": list(WARNINGS), "source": {"url": SOURCE, "section": "Algorithm 2.3 and section 3.1", "tie_extension": True}}
        if sessions.latest_completed_session() != checked_as_of:
            raise _problem("cscv_observation_session_changed")
        result["evidence_fingerprint"] = receipts._hash(result)
        encoded = receipts._json(result)
        if len(encoded.encode()) > MAX_BYTES:
            raise _problem("cscv_export_size_limit", 422)
        return Response(content=encoded, media_type="application/json", headers={"Cache-Control": "no-store"})
