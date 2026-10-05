"""Descriptive stored-row capacity across receipt families; never save authority."""
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import JSONResponse

from . import allocation_research_receipts as allocation
from . import execution_study_receipts as execution
from . import research_integrity_receipts as integrity
from . import workflow_path_receipts as workflow
from . import sessions, store

ENGINE_VERSION = "alphaview-research-evidence-capacity-v1"
BASE = "/api/paper/accounts/{account_id}/research-evidence-capacity"
POLICY = {"read_only": True, "save_authorized": False, "delete_authorized": False,
          "export_frees_capacity": False}
METHOD = (
    "Stored-row counts in one query-only snapshot, including corrupt or unverifiable rows. "
    "Limits are the existing receipt modules' constants; account and workspace scopes are separate. "
    "Research-integrity receipts have no account association or account limit. Remaining capacity "
    "is max(0, limit minus stored count); over_limit means strictly above the limit. Counts do not "
    "assess payload integrity, byte size, source currentness or permission to save. Existing save "
    "routes remain authoritative and may reject for other reasons. Export does not free capacity. "
    "No payload decoding, validation scan, provider call, write, deletion or automatic cleanup."
)
router = APIRouter()


def _scope(scope, count, limit, reason=None):
    return {"scope": scope, "count": count, "limit": limit,
            "remaining": max(0, limit - count) if count is not None and limit is not None else None,
            "over_limit": count > limit if count is not None and limit is not None else None,
            "reason": reason or ("limit_unavailable" if limit is None else None)}


def _family(db, family, account_id, account_limit, workspace_limit):
    # Identifiers are internal fixed table names, never values from the request.
    total = db.execute(f"SELECT COUNT(*) FROM {family}").fetchone()[0]
    account = (_scope("account", None, None, "workspace_scoped_family") if account_limit is None
               else _scope("account", db.execute(
                   f"SELECT COUNT(*) FROM {family} WHERE account_id=?", (account_id,)).fetchone()[0],
                   account_limit))
    return {"family": family, "account": account,
            "workspace": _scope("workspace", total, workspace_limit)}


@router.get(BASE)
@store.snapshot_read
def read_capacity(account_id: Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]):
    with store.connect() as db:
        account = db.execute("SELECT id,version FROM paper_accounts WHERE id=?", (account_id,)).fetchone()
        if account is None:
            raise HTTPException(404, {"code": "capacity_account_missing"})
        value = {"engine_version": ENGINE_VERSION, "account_id": account["id"],
                 "account_version": account["version"], "as_of": sessions.latest_completed_session(),
                 "input_revision": store.input_revision(db),
                 "families": [
                     _family(db, "allocation_research_receipts", account_id, allocation.MAX_ACCOUNT, allocation.MAX_TOTAL),
                     _family(db, "research_integrity_receipts", account_id, None, integrity.MAX_TOTAL),
                     _family(db, "workflow_path_receipts", account_id, workflow.MAX_ACCOUNT, workflow.MAX_TOTAL),
                     _family(db, "execution_study_receipts", account_id, execution.MAX_ACCOUNT, execution.MAX_TOTAL),
                 ],
                 "integrity": {"assessed": False, "available": None, "reason": "not_assessed"},
                 "policy": POLICY, "method": METHOD}
    return JSONResponse(value, headers={"Cache-Control": "no-store"})
