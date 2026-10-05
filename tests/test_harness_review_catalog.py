"""Synthetic offline completion catalog: preserve records, filter only display, print all."""
import copy
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("harness_review_catalog", ROOT / "scripts/harness_review_catalog.py")
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)


class Markup(HTMLParser):
    def __init__(self, value):
        super().__init__(convert_charrefs=True)
        self.tags, self.text, self.scripts, self.ids = [], [], [], []
        self.in_script = False
        self.feed(value)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.tags.append((tag, attrs))
        if "id" in attrs:
            self.ids.append(attrs["id"])
        if tag == "script":
            self.in_script = True

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_script = False

    def handle_data(self, data):
        (self.scripts if self.in_script else self.text).append(data)


def test_all_original_records_are_readable_without_javascript_and_input_is_unchanged():
    records = [{"title": f"合成單位 {i}", "detail": "未完成的驗收保持原文", "evidence": ["first", "second"],
                "status": "browser pending", "category": "研究" if i % 2 else ""} for i in range(31)]
    original = copy.deepcopy(records)
    markup = Markup(catalog.render_delivery_catalog(records))
    rows = [attrs for tag, attrs in markup.tags if "data-delivery-item" in attrs]
    assert len(rows) == 31 and all("hidden" not in row for row in rows)
    assert [row["data-delivery-index"] for row in rows] == [str(i) for i in range(31)]
    text = "".join(markup.text)
    for i in range(31):
        assert f"合成單位 {i}" in text
    assert "browser pending" in text and "first；second" in text
    assert "已驗證" not in text and records == original
    assert sum(tag == "details" for tag, _ in markup.tags) == 31
    assert all(attrs.get("type") == "button" for tag, attrs in markup.tags if tag == "button")
    assert all("hidden" in attrs for _, attrs in markup.tags if "data-delivery-controls" in attrs)


def test_untrusted_text_cannot_escape_html_or_script_and_instances_have_distinct_ids():
    attack = '</script><script>globalThis.pwned=1</script><img src=x onerror="pwned=2">&\"\'\u2028\u2029'
    record = {key: attack for key in ("title", "detail", "evidence", "category", "status")}
    first = catalog.render_delivery_catalog([record, {"unit": "fallback"}, "plain record"])
    second = catalog.render_delivery_catalog([record])
    markup = Markup(first + second)
    assert len(markup.ids) == len(set(markup.ids))
    assert sum(tag == "script" for tag, _ in markup.tags) == 2
    assert all(tag not in {"img", "iframe", "object"} for tag, _ in markup.tags)
    assert not any(any(key.startswith("on") for key in attrs) for _, attrs in markup.tags)
    assert attack in "".join(markup.text)
    script = "".join(markup.scripts)
    assert attack not in script and "globalThis.pwned" not in script
    for forbidden in ("innerHTML", "insertAdjacentHTML", "fetch(", "XMLHttpRequest", "localStorage", "sessionStorage"):
        assert forbidden not in script
    assert "fallback" in "".join(markup.text) and "plain record" in "".join(markup.text)


def test_print_rules_ignore_filters_and_expand_all_original_evidence_without_script():
    rendered = catalog.render_delivery_catalog([{"title": "synthetic", "evidence": "pending verification"}])
    assert "@media print" in rendered
    print_rules = rendered.split("@media print", 1)[1].split("</style>", 1)[0]
    assert ".delivery-item[hidden] { display:list-item !important; }" in print_rules
    assert ".delivery-print-evidence" in print_rules and "display:block !important" in print_rules
    assert ".delivery-pagination" in print_rules and ".delivery-controls" in print_rules
    assert "details { display:none !important; }" in print_rules
    assert rendered.count("pending verification") == 2  # Native details plus print-only original.


def test_offline_real_dom_filter_pagination_reset_keyboard_print_and_isolation():
    records = [{"title": f"合成單位 {i:02d}", "detail": f"內容 {i}",
                "evidence": f"原始證據{' Needle.One' if i == 25 else ''}",
                "category": "研究" if i % 2 else "執行"} for i in range(31)]
    # Explicit labels that resemble a fallback or sentinel remain separate.
    records += [{"title": "unclassified"}, {"title": "explicit category", "category": "未分類（原紀錄未提供）"},
                {"title": "literal punctuation", "detail": "a[.]b", "category": "all"}]
    markup = catalog.render_delivery_catalog(records)
    other = catalog.render_delivery_catalog([{"title": "other catalog", "category": "研究"}])
    empty = catalog.render_delivery_catalog([])
    program = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
const parts = JSON.parse(readFileSync(0, 'utf8'));
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(String(error)));
const dom = new JSDOM('<!doctype html><form id="outer">' + parts.main + parts.other + parts.empty +
  '<input id="review-notes" value="keep draft"><input type="checkbox" data-task-id="keep" checked>' +
  '</form>', {runScripts:'dangerously', url:'file:///synthetic-review.html', virtualConsole,
  beforeParse(window) {
    window.fetch = () => { throw new Error('No external calls'); };
    window.XMLHttpRequest = function() { throw new Error('No requests'); };
    Object.defineProperty(window, 'localStorage', {get() {throw new Error('No storage');}});
    Object.defineProperty(window, 'sessionStorage', {get() {throw new Error('No storage');}});
  }});
const { document, Event, KeyboardEvent } = dom.window;
const [root, second, zero] = document.querySelectorAll('.harness-delivery-catalog');
const get = name => root.querySelector('[data-delivery-' + name + ']');
const rows = [...root.querySelectorAll('[data-delivery-item]')];
const visible = () => rows.filter(row => !row.hidden);
const indices = () => visible().map(row => Number(row.dataset.deliveryIndex));
const setQuery = query => { get('search').value = query; get('search').dispatchEvent(new Event('input', {bubbles:true})); };
const select = value => { get('category-filter').value = value; get('category-filter').dispatchEvent(new Event('change', {bubbles:true})); };
const category = label => [...get('category-filter').options].find(option => option.textContent === label).value;
assert.equal(rows.length, 34);
assert.deepEqual(indices(), [...Array(12).keys()]);
assert.equal(get('controls').hidden, false);
assert.equal(get('previous').disabled, true);
assert.match(get('count').textContent, /符合 34 \/ 34 筆 · 顯示 1–12/);
get('next').click(); get('next').click();
assert.deepEqual(indices(), [...Array(10).keys()].map(i => i + 24));
assert.equal(get('next').disabled, true);
assert.equal(get('page').textContent, '第 3 / 3 頁');
get('previous').click();
assert.equal(indices()[0], 12);
select(category('分類：研究'));
assert.deepEqual(indices(), [...Array(12).keys()].map(i => i * 2 + 1));
assert.equal(get('page').textContent, '第 1 / 2 頁');
assert.match(get('count').textContent, /符合 15 \/ 34 筆/);
get('next').click();
assert.deepEqual(indices(), [25,27,29]);
setQuery('nEeDlE.oNe');
assert.deepEqual(indices(), [25]);
assert.equal(get('page').textContent, '第 1 / 1 頁');
assert.equal(visible()[0].querySelector('details').open, false);
visible()[0].querySelector('details').open = true;
setQuery('no matching synthetic value');
assert.equal(visible().length, 0);
assert.equal(get('empty').hidden, false);
assert.equal(get('page').textContent, '第 0 / 0 頁');
assert.equal(get('previous').disabled, true);
assert.equal(get('next').disabled, true);
assert.match(get('count').textContent, /顯示 0–0/);
get('reset').click();
assert.deepEqual(indices(), [...Array(12).keys()]);
assert.equal(get('reset').disabled, true);
assert.equal(rows[25].querySelector('details').open, true);
setQuery('a[.]b');
assert.deepEqual(indices(), [33]);
setQuery('a.b');
assert.equal(visible().length, 0);
get('reset').click();
select(category('未分類（原紀錄未提供）')); assert.deepEqual(indices(), [31]);
select(category('分類：未分類（原紀錄未提供）')); assert.deepEqual(indices(), [32]);
select(category('分類：all')); assert.deepEqual(indices(), [33]);
get('reset').click();
setQuery('分類'); assert.deepEqual(indices(), [32]);
get('reset').click();
setQuery('執行'); assert.equal(visible().length, 12);
assert.match(get('count').textContent, /符合 16 \/ 34 筆/);
get('search').focus();
assert.equal(document.activeElement, get('search'));
const enter = new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true});
assert.equal(get('search').dispatchEvent(enter), false);
assert.equal(enter.defaultPrevented, true);
assert([...root.querySelectorAll('button')].every(button => button.type === 'button'));
assert.equal(document.getElementById('review-notes').value, 'keep draft');
assert.equal(document.querySelector('[data-task-id]').checked, true);
assert.equal(second.querySelectorAll('[data-delivery-item]:not([hidden])').length, 1);
assert.equal(second.querySelector('[data-delivery-search]').value, '');
assert.equal(dom.window.location.href, 'file:///synthetic-review.html');
assert.equal(zero.querySelector('[data-delivery-empty]').hidden, false);
assert.match(zero.querySelector('[data-delivery-count]').textContent, /符合 0 \/ 0 筆 · 顯示 0–0/);
assert.equal(zero.querySelector('[data-delivery-page]').textContent, '第 0 / 0 頁');
const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
assert.equal(ids.length, new Set(ids).size);
// Every hidden item still has its print evidence in the DOM; print CSS overrides visibility.
assert.equal(rows.length, 34);
assert.equal(root.querySelectorAll('.delivery-print-evidence').length, 31);
assert.deepEqual(errors, []);
const offline = new JSDOM(parts.main, {url:'file:///synthetic-no-script.html'});
assert.equal(offline.window.document.querySelectorAll('[data-delivery-item]:not([hidden])').length, 34);
assert.equal(offline.window.document.querySelector('[data-delivery-controls]').hidden, true);
console.log('PASS: offline DOM interactions and no-script fallback');
dom.window.close(); offline.window.close();
"""
    result = subprocess.run(["node", "--input-type=module", "-e", program], cwd=ROOT / "web",
                            input=json.dumps({"main": markup, "other": other, "empty": empty}),
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS: offline DOM interactions" in result.stdout
