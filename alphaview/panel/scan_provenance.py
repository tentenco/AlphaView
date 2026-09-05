"""Schema-neutral identity for scanner semantics and captured database inputs.

Bump SCAN_ENGINE_VERSION whenever indicators, signal rules, ranking population,
required-data/eligibility handling, or dated evaluation semantics can change results.
Presentation-only wording/layout changes do not require a bump. Never reuse a version.
"""
import re

from . import store

SCAN_ENGINE_VERSION = "alphaview-scan-v1"
_PATTERN = re.compile(r"^(alphaview-scan-v[1-9][0-9]*)\|([0-9a-f]{32}:[0-9]+)$")


def token(input_revision, engine_version=None):
    return f"{engine_version or SCAN_ENGINE_VERSION}|{input_revision}"


def current_token(db=None):
    return token(store.input_revision() if db is None else store.input_revision(db))


def parse(value):
    matched = _PATTERN.fullmatch(value) if isinstance(value, str) else None
    return {"engine_version": matched[1], "inputs_revision": matched[2]} if matched else None
