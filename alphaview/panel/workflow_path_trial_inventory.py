"""Account-wide saved-trial coverage, without returns, ranking or trial reconstruction."""
from fastapi import APIRouter
from fastapi.responses import Response

from . import paper_portfolio as paper, sessions, store
from . import workflow_path_receipts as receipts, workflow_path_receipt_archive as archive
from . import workflow_path_receipt_comparison as comparison, workflow_path_cscv as cscv

ENGINE_VERSION = "alphaview-workflow-path-trial-inventory-v1"
BASE = "/api/paper/accounts/{account_id}/workflow-path-trial-inventory"
MAX_BYTES, MAX_METADATA_BYTES = 3 * 1024 * 1024, 16384
IDENTITY_COLUMNS = ("id", "account_id", "run_id", "kind", "created_at", "engine_version", "content_fingerprint")
POLICY = {"read_only": True, "saved_receipts_only": True, "execution_authority": False,
          "automatic_cscv_selection": False, "reconstruction": False}
CONFIGURATION_DEFINITION = "Complete baseline.settings, saved_workflow.request, workflow_kind, candidate_symbols and rps_universe"
METHOD = (
    "Complete same-account immutable receipt inventory before pagination, at most 50 account receipts and 250 globally. "
    "Count path validation, cost and unknown-kind rows separately, preserving unverifiable identities with typed cells. "
    "Read original receipts only; no prices, path rebuild, returns, rank, winner, selection or CSCV calculation. "
    "A verified receipt is not automatically a complete comparable historical basis. Use the strict saved receipt "
    "verifier, supported versions/methods and each receipt's self-comparison basis checks. Group only identical "
    "canonical versioned facts: method versions/text, raw-history fingerprint, ordered candidate/RPS universes, "
    "exact window and valued-date fingerprint, complete-coverage validity, initial cash and baseline costs. "
    "Required metrics are checked for finite completeness but never exposed. No pairwise transitivity inference. "
    "Decision counts are retained per receipt; complete coverage is the existing CSCV comparison condition, not "
    "an invented requirement that different rebalance configurations have identical decision counts. "
    "Configuration identity uses the exact CSCV definition and hash: complete saved settings, workflow request/kind "
    "and both universes. Every original receipt ID remains present; repeated configurations retain multiplicity "
    "within each exact basis group and are never silently removed from a population. Cost receipts are not trials. "
    "Currentness is separate from historical grouping. Scope is saved_receipts_only; unrecorded/discarded trials "
    "and the full-search denominator are unknown, not zero. This is not preregistration, a full experiment registry, "
    "complete-search PBO, research approval or execution authorization. Full inventory export is limited to 3 MiB "
    "without truncation; original raw envelopes remain available through existing receipt/archive downloads."
)
router = APIRouter()


def _problem(code, status=413):
    return receipts._problem(code, code, status)


def _records(db, account_id):
    """Bound each original before decoding; retain oversized/opaque rows as unavailable summaries."""
    columns = archive.COLUMNS
    size_fields = [f"CASE WHEN typeof({key})='real' THEN 8 ELSE COALESCE(length(CAST({key} AS BLOB)),0) END AS {key}_size" for key in columns]
    listing = db.execute(f"SELECT rowid AS stored_rowid,{','.join(size_fields)} FROM workflow_path_receipts "
        "WHERE CAST(account_id AS BLOB)=? ORDER BY created_at,id,rowid", (account_id.encode("ascii"),)).fetchall()
    for listed in listing:
        if sum(listed[key + "_size"] for key in IDENTITY_COLUMNS) > MAX_METADATA_BYTES:
            raise _problem("inventory_identity_size_limit")
        large = listed["payload_json_size"] > receipts.MAX_BYTES or listed["request_json_size"] > 16384
        selected = IDENTITY_COLUMNS if large else columns
        fields = []
        for key in selected:
            fields.extend((f"typeof({key}) AS {key}_type", f"CAST({key} AS BLOB) AS {key}_raw",
                f"CASE WHEN typeof({key})='real' THEN {key} ELSE NULL END AS {key}_real"))
        row = db.execute(f"SELECT {','.join(fields)} FROM workflow_path_receipts WHERE rowid=?", (listed["stored_rowid"],)).fetchone()
        record = {key: archive._cell(row[key + "_type"], row[key + "_raw"], row[key + "_real"]) for key in selected}
        yield record, {key: listed[key + "_size"] for key in columns}, "inventory_original_size_limit" if large else None


def _metadata(record, key):
    cell = record[key]
    return cell["content"] if cell["storage_type"] == "text" and cell["encoding"] == "utf-8" else None


def _entry(db, record, sizes, size_issue, ordinal):
    row, payload, issue = (None, None, size_issue) if size_issue else archive._verify(record)
    kind = _metadata(record, "kind")
    category = "unavailable_path" if kind == "path_validation" else "cost_receipt" if kind == "path_costs" else "unknown_receipt"
    reasons = [issue] if issue else []
    entry = {"ordinal": ordinal, **{key: _metadata(record, key) for key in IDENTITY_COLUMNS},
        "identity_cells": {key: record[key] for key in IDENTITY_COLUMNS}, "original_byte_lengths": sizes,
        "integrity": {"available": payload is not None, "reason": issue}, "category": category,
        "diagnostic_status": payload["evidence"]["status"] if payload else None,
        "currentness": archive._currentness(db, payload), "reasons": reasons,
        "basis_fingerprint": None, "basis_summary": None, "configuration_fingerprint": None,
        "configuration": None, "coverage": None}
    if payload is None:
        return entry
    entry["coverage"] = payload["evidence"]["coverage"]
    if kind != "path_validation":
        entry["reasons"] = ["cost_receipt_not_trial"] if kind == "path_costs" else ["unknown_receipt_kind"]
        return entry
    try:
        definition = cscv._configuration(payload)
        if (set(definition) != {"settings", "workflow_request", "workflow_kind", "candidate_symbols", "rps_universe"}
                or definition["workflow_kind"] != "deterministic_rules"
                or not isinstance(definition["workflow_request"], dict)):
            raise ValueError("Unsupported saved configuration")
        receipts._json(definition)
    except (KeyError, TypeError, ValueError, OverflowError, RecursionError):
        entry["reasons"] = ["inventory_configuration_unavailable"]
        return entry
    entry.update(configuration=definition, configuration_fingerprint=receipts._hash(definition))
    checks = comparison._basis(payload, payload)
    problems = archive._version_reasons(payload) + [check["code"] for check in checks if not check["matches"]]
    entry["reasons"] = sorted(set(problems))
    if problems:
        return entry
    facts = {check["code"]: check["baseline"] for check in checks}
    basis = {"inventory_engine_version": ENGINE_VERSION, "comparison_engine_version": comparison.ENGINE_VERSION,
             "facts": facts}
    entry.update(category="comparable_path", basis_summary=basis, basis_fingerprint=receipts._hash(basis))
    return entry


def _groups(records):
    groups = {}
    for entry in records:
        fingerprint = entry["basis_fingerprint"]
        if fingerprint is None: continue
        group = groups.setdefault(fingerprint, {"basis_fingerprint": fingerprint, "basis": entry["basis_summary"], "receipt_ids": [], "configurations": {}})
        # Equality of the canonical facts is the grouping rule, not a chain of pairwise matches.
        if receipts._json(group["basis"]) != receipts._json(entry["basis_summary"]):
            raise _problem("inventory_basis_identity_conflict", 409)
        group["receipt_ids"].append(entry["id"])
        config = group["configurations"].setdefault(entry["configuration_fingerprint"], {
            "configuration_fingerprint": entry["configuration_fingerprint"], "configuration": entry["configuration"], "receipt_ids": []})
        if receipts._json(config["configuration"]) != receipts._json(entry["configuration"]):
            raise _problem("inventory_configuration_identity_conflict", 409)
        config["receipt_ids"].append(entry["id"])
    result = []
    for group in groups.values():
        definitions = [{**value, "multiplicity": len(value["receipt_ids"])} for value in group["configurations"].values()]
        result.append({**group, "configurations": definitions, "receipt_count": len(group["receipt_ids"]),
            "distinct_configurations": len(definitions), "duplicate_configuration_groups": sum(item["multiplicity"] > 1 for item in definitions),
            "duplicate_receipts_extra": sum(item["multiplicity"] - 1 for item in definitions)})
    return result


@router.get(BASE)
@store.snapshot_read
def inventory(account_id: comparison.AccountId):
    as_of = sessions.latest_completed_session()
    with store.connect() as db:
        account = paper._account(db, account_id)
        total = db.execute("SELECT count(*) FROM workflow_path_receipts").fetchone()[0]
        count = db.execute("SELECT count(*) FROM workflow_path_receipts WHERE CAST(account_id AS BLOB)=?", (account_id.encode("ascii"),)).fetchone()[0]
        if count > receipts.MAX_ACCOUNT or total > receipts.MAX_TOTAL:
            raise _problem("inventory_receipt_count_limit")
        records = [_entry(db, raw, sizes, issue, index + 1) for index, (raw, sizes, issue) in enumerate(_records(db, account_id))]
        groups = _groups(records)
        paths = sum(row["kind"] == "path_validation" for row in records)
        costs = sum(row["kind"] == "path_costs" for row in records)
        available = sum(row["category"] == "comparable_path" for row in records)
        valid = sum(row["integrity"]["available"] for row in records)
        coverage = {"complete_set": True, "account_receipts": count, "returned_receipts": len(records), "path_receipts": paths,
            "cost_receipts": costs, "unknown_kind_receipts": len(records) - paths - costs,
            "verified_receipts": valid, "unverifiable_receipts": len(records) - valid,
            "basis_available_path_receipts": available, "basis_unavailable_path_receipts": paths - available,
            "basis_groups": len(groups), "configurations_within_groups": sum(group["distinct_configurations"] for group in groups),
            "duplicate_configuration_groups": sum(group["duplicate_configuration_groups"] for group in groups),
            "duplicate_receipts_extra": sum(group["duplicate_receipts_extra"] for group in groups)}
        value = {"engine_version": ENGINE_VERSION, "comparison_engine_version": comparison.ENGINE_VERSION,
            "configuration_engine_version": cscv.ENGINE_VERSION, "account_id": account_id, "account_version": account["version"],
            "scope": "saved_receipts_only", "unrecorded_trials": None, "full_search_denominator": None,
            "full_search_coverage": "unknown", "policy": POLICY, "coverage": coverage, "records": records, "groups": groups,
            "configuration_definition": CONFIGURATION_DEFINITION, "checked_as_of": as_of,
            "checked_input_revision": store.input_revision(db), "checked_at": store.now(), "max_export_bytes": MAX_BYTES,
            "limits": {"account_receipts": receipts.MAX_ACCOUNT, "global_receipts": receipts.MAX_TOTAL,
                "original_payload_bytes": receipts.MAX_BYTES, "original_request_bytes": 16384, "identity_metadata_bytes": MAX_METADATA_BYTES},
            "method": METHOD}
        value["inventory_fingerprint"] = receipts._hash(value)
        encoded = receipts._json(value)
        if len(encoded.encode()) > MAX_BYTES:
            raise _problem("inventory_export_size_limit")
        if sessions.latest_completed_session() != as_of:
            raise _problem("inventory_observation_session_changed", 409)
        return Response(encoded, media_type="application/json", headers={"Cache-Control": "no-store"})
