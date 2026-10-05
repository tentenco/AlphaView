"""Offline review choices: explicit local restore, strict scope, current-page definitions."""
import copy
from html.parser import HTMLParser
import json
from pathlib import Path
import subprocess

from scripts.render_trading_agent_review import review_form

ROOT = Path(__file__).resolve().parents[1]


def state():
    return {
        "run_id": "synthetic-review-run", "title": "合成檢閱",
        "started_at": "2026-10-05T02:07:08+08:00", "deadline": "2026-10-05T07:07:08+08:00",
        "next_tasks": [
            {"id": "one", "title": "本頁第一項", "detail": "本頁說明", "start_from": "synthetic.py",
             "acceptance": ["本頁驗收一", "本頁驗收二"]},
            {"id": "two", "title": "本頁第二項", "detail": "依賴仍由使用者決定", "acceptance": []},
            {"id": "three", "title": "本頁第三項", "start_from": "later.py"},
        ],
    }


class Markup(HTMLParser):
    def __init__(self, value):
        super().__init__(convert_charrefs=True)
        self.tags, self.text = [], []
        self.script = False
        self.feed(value)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))
        if tag == "script":
            self.script = True

    def handle_endtag(self, tag):
        if tag == "script":
            self.script = False

    def handle_data(self, value):
        if not self.script:
            self.text.append(value)


PRELUDE = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
const markup = JSON.parse(readFileSync(0, 'utf8'));
const instances = [];
function create(options = {}) {
  const errors = [], blobs = [], downloads = [], requests = [], store = new Map();
  if (options.saved) store.set('alphaview-harness-review:synthetic-review-run', JSON.stringify(options.saved));
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(String(error)));
  const dom = new JSDOM('<!doctype html><form id="outer">' + markup + '</form>', {
    runScripts: 'dangerously', url: 'file:///moved/offline/review.html', virtualConsole,
    beforeParse(window) {
      const forbidden = name => () => { requests.push(name); throw new Error('Forbidden network: ' + name); };
      window.fetch = forbidden('fetch'); window.XMLHttpRequest = forbidden('XHR');
      window.WebSocket = forbidden('WebSocket'); window.navigator.sendBeacon = forbidden('beacon');
      Object.defineProperty(window, 'localStorage', {value: {
        getItem(key) {if (options.storageError) throw new Error('Storage disabled'); return store.get(key) ?? null;},
        setItem(key, value) {if (options.storageError) throw new Error('Storage disabled'); store.set(key, value);},
      }});
      window.URL.createObjectURL = blob => {blobs.push(blob); return 'blob:synthetic-' + blobs.length;};
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function() { downloads.push(this.download); };
      if (options.beforeParse) options.beforeParse(window);
    },
  });
  const {document, Event} = dom.window;
  const get = id => document.getElementById(id);
  const boxes = [...document.querySelectorAll('[data-task-id]')];
  const selected = () => boxes.filter(box => box.checked).map(box => box.dataset.taskId);
  const status = () => get('review-status').textContent;
  const snapshot = () => JSON.stringify({selected:selected(),notes:get('review-notes').value,storage:[...store]});
  function edit(ids, notes) {
    for (const box of boxes) {box.checked = ids.includes(box.dataset.taskId); box.dispatchEvent(new Event('change', {bubbles:true}));}
    get('review-notes').value = notes; get('review-notes').dispatchEvent(new Event('input', {bubbles:true}));
  }
  async function read(blob) {
    return new Promise((resolve,reject) => {const reader = new dom.window.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(blob);});
  }
  async function exportJSON() {get('download-tasks').click();return JSON.parse(await read(blobs.at(-1)));}
  function choose(file) {
    Object.defineProperty(get('review-import-file'), 'files', {value:file ? [file] : [], configurable:true});
    get('review-import-file').dispatchEvent(new Event('change', {bubbles:true}));
  }
  async function pick(text) {
    choose(new dom.window.File([text], 'synthetic.json', {type:'application/json'}));
    for (let index=0; index<100 && status().startsWith('正在本機'); index++) await new Promise(resolve=>setTimeout(resolve,2));
    assert(!status().startsWith('正在本機'), 'File read should finish');
  }
  const env = {dom,document,get,boxes,selected,status,snapshot,edit,read,exportJSON,choose,pick,errors,blobs,downloads,requests,store};
  instances.push(env); return env;
}
function finish() {
  for (const env of instances) {
    assert.deepEqual(env.errors, []); assert.deepEqual(env.requests, []);
    assert.equal(env.dom.window.location.href,'file:///moved/offline/review.html');
    env.dom.window.close();
  }
  console.log('PASS: local review form DOM behavior');
}
"""


def run_dom(program):
    result = subprocess.run(
        ["node", "--input-type=module", "-e", PRELUDE + program + "\nfinish();"],
        cwd=ROOT / "web", input=json.dumps(review_form(state())),
        capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS: local review form DOM behavior" in result.stdout


def test_static_fallback_remains_readable_labeled_and_escaped_without_javascript():
    value = state()
    attack = '</script><img src=x onerror="globalThis.pwned=1">\u2028\u2029'
    value["next_tasks"][0]["title"] = attack
    original = copy.deepcopy(value)
    rendered = review_form(value)
    markup = Markup(rendered)
    assert value == original
    assert attack in "".join(markup.text)
    assert all(tag not in {"img", "iframe", "object"} for tag, _ in markup.tags)
    assert not any(any(key.startswith("on") for key in attrs) for _, attrs in markup.tags)
    assert sum(tag == "script" for tag, _ in markup.tags) == 2
    assert "本頁第二項" in "".join(markup.text) and "本頁第三項" in "".join(markup.text)
    assert "瀏覽器未啟用指令碼" in "".join(markup.text)
    controls = {attrs["id"]: attrs for _, attrs in markup.tags if "id" in attrs}
    assert "disabled" in controls["review-import-file"] and "disabled" in controls["restore-review"]
    assert controls["review-import-file"]["type"] == "file"
    assert controls["review-import-file"]["aria-describedby"] == "review-import-help"
    assert any(tag == "label" and attrs.get("for") == "review-import-file" for tag, attrs in markup.tags)
    assert controls["review-status"]["role"] == "status" and controls["review-status"]["aria-live"] == "polite"
    assert all(attrs.get("type") == "button" for tag, attrs in markup.tags if tag == "button")
    assert "max-width:100%" in rendered and "overflow-wrap:anywhere" in rendered
    assert "innerHTML" not in rendered and "insertAdjacentHTML" not in rendered
    assert "fetch(" not in rendered and "XMLHttpRequest" not in rendered


def test_export_restore_roundtrip_is_explicit_preserves_multiline_notes_and_existing_exports():
    run_dom(r"""
const env = create(), {get, edit, exportJSON, pick, snapshot, selected, store} = env;
assert.equal(get('review-import-file').disabled,false);
assert.equal(get('restore-review').disabled,true);
assert.equal(get('download-tasks').disabled,true);
const notes='第一行\n第二行：保留優先順序\n\n最後一行';
edit(['two','three'],notes);
const exported=await exportJSON();
assert.deepEqual(exported.tasks.map(task=>task.id),['two','three']);
assert.equal(exported.review_notes,notes);
assert.equal(exported.execution_requested,false);assert.equal(exported.external_actions_authorized,false);
assert.equal(env.downloads[0],'synthetic-review-run-selected-tasks.json');
edit(['one'],'現有草稿，不得提早取代');
const before=snapshot();
await pick(JSON.stringify(exported));
assert.equal(snapshot(),before);
assert.equal(get('restore-review').disabled,false);
assert.equal(get('review-import-preview').hidden,false);
assert.match(get('review-import-summary').textContent,/2 項候選工作/);
assert.match(get('review-import-summary').textContent,/尚未套用/);
assert.deepEqual([...get('review-import-tasks').children].map(node=>node.textContent),['本頁第二項','本頁第三項']);
assert.equal(get('review-import-notes').textContent,notes);
assert.equal(env.blobs.length,1); // Selecting a file never downloads or executes anything.
get('restore-review').click();
assert.deepEqual(selected(),['two','three']);assert.equal(get('review-notes').value,notes);
assert.equal(get('restore-review').disabled,true);assert.equal(get('review-import-preview').hidden,true);
assert.match(env.status(),/沒有啟動工作或授權外部操作/);
assert.deepEqual(JSON.parse(store.get('alphaview-harness-review:synthetic-review-run')),{selected:['two','three'],notes});
const again=await exportJSON();
assert.deepEqual(again.tasks,exported.tasks);assert.equal(again.review_notes,notes);
assert.equal(again.execution_requested,false);assert.equal(again.external_actions_authorized,false);
get('download-review').click();const markdown=await env.read(env.blobs.at(-1));
assert(markdown.includes('- [ ] 本頁第一項'));assert(markdown.includes('- [x] 本頁第二項'));
assert(markdown.includes(notes));assert(markdown.includes('這份檢閱不會自行啟動工作，也不授權外部操作。'));
const resumed=create({saved:JSON.parse(store.get('alphaview-harness-review:synthetic-review-run'))});
assert.deepEqual(resumed.selected(),['two','three']);assert.equal(resumed.get('review-notes').value,notes);
assert.match(resumed.status(),/已載入此瀏覽器的檢閱草稿/);
""")


def test_imported_task_text_is_ignored_and_notes_remain_literal_text_not_markup():
    run_dom(r"""
const env=create();env.edit(['one'],'original');const value=await env.exportJSON();
const attack='</pre><img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=2</script>\n& literal';
value.tasks[0].title=attack;value.tasks[0].detail=attack;value.tasks[0].start_from=attack;value.tasks[0].acceptance=[attack];
value.source_title=attack;value.notice=attack;value.review_notes=attack;
await env.pick(JSON.stringify(value));
assert.equal(env.get('review-import-tasks').textContent,'本頁第一項');
assert.equal(env.get('review-import-notes').textContent,attack);
assert.equal(env.get('review-import-notes').childElementCount,0);
assert.equal(env.document.querySelectorAll('img,iframe,object').length,0);
assert.equal(env.dom.window.pwned,undefined);
env.get('restore-review').click();
assert.deepEqual(env.selected(),['one']); // No inferred dependencies added.
assert.equal(env.get('review-notes').value,attack);
const exported=await env.exportJSON();
assert.deepEqual(exported.tasks,[{id:'one',title:'本頁第一項',detail:'本頁說明',start_from:'synthetic.py',acceptance:['本頁驗收一','本頁驗收二']}]);
assert.equal(exported.source_title,'合成檢閱');assert.equal(exported.review_notes,attack);
""")


def test_invalid_foreign_authorizing_or_oversize_files_reject_atomically_and_clear_old_preview():
    run_dom(r"""
const env=create();env.edit(['two'],'匯出備註');const valid=await env.exportJSON();
env.edit(['one','three'],'必須保留\n多行現有草稿');const before=env.snapshot();
const mutate=fn=>{const value=JSON.parse(JSON.stringify(valid));fn(value);return JSON.stringify(value);};
const bad=[
 ['malformed','{broken'],['array','[]'],['empty',''],
 ['foreign run',mutate(v=>v.source_run='other-run')],
 ['unknown schema',mutate(v=>v.format_version=2)],
 ['wrong kind',mutate(v=>v.kind='execution-request')],
 ['unknown field',mutate(v=>v.extra=true)],
 ['missing field',mutate(v=>delete v.notice)],
 ['unknown task',mutate(v=>v.tasks[0].id='unknown')],
 ['duplicate task',mutate(v=>v.tasks.push({...v.tasks[0]}))],
 ['empty tasks',mutate(v=>v.tasks=[])],
 ['wrong task shape',mutate(v=>delete v.tasks[0].detail)],
 ['extra task field',mutate(v=>v.tasks[0].html='<h1>untrusted</h1>')],
 ['bad task definition',mutate(v=>v.tasks[0].acceptance=[false])],
 ['execution authorization',mutate(v=>v.execution_requested=true)],
 ['external authorization',mutate(v=>v.external_actions_authorized=true)],
 ['string authorization',mutate(v=>v.execution_requested='false')],
 ['non-string notes',mutate(v=>v.review_notes={html:'x'})],
 ['notes too long',mutate(v=>v.review_notes='x'.repeat(20001))],
 ['nonfinite',JSON.stringify(valid).replace('"format_version":1','"format_version":1e999')],
 ['invalid date',mutate(v=>v.exported_at='2026-02-30T00:00:00.000Z')],
 ['oversize',' '.repeat(1024*1024+1)],
];
for (const [name,text] of bad) {
 await env.pick(JSON.stringify(valid));assert.equal(env.get('restore-review').disabled,false,name);
 await env.pick(text);
 assert.match(env.status(),/草稿未載入/,name);assert.equal(env.snapshot(),before,name);
 assert.equal(env.get('restore-review').disabled,true,name);assert.equal(env.get('review-import-preview').hidden,true,name);
 env.get('restore-review').click();assert.equal(env.snapshot(),before,name);
}
await env.pick(JSON.stringify(valid));env.choose(null);
assert.equal(env.snapshot(),before);assert.equal(env.get('restore-review').disabled,true);
assert.match(env.status(),/尚未選擇草稿/);
assert.equal(env.blobs.length,1);
""")


def test_late_reads_cannot_replace_new_preview_and_storage_failure_does_not_block_local_restore():
    run_dom(r"""
const exporter=create();exporter.edit(['two'],'saved\nnotes');const value=await exporter.exportJSON();
const readers=[];
const env=create({beforeParse(window){window.FileReader=class {
 constructor(){readers.push(this);} abort(){this.aborted=true;} readAsText(){};
};}});
env.edit(['one'],'keep current');const before=env.snapshot();
const file=text=>new env.dom.window.File([text],'synthetic.json',{type:'application/json'});
env.choose(file(JSON.stringify(value)));const first=readers.at(-1);
env.choose(file('{broken'));const second=readers.at(-1);
assert.equal(first.aborted,true);
second.result='{broken';second.onload();assert.match(env.status(),/草稿未載入/);
first.result=JSON.stringify(value);first.onload();
assert.equal(env.snapshot(),before);assert.equal(env.get('restore-review').disabled,true);
env.choose(file(JSON.stringify(value)));readers.at(-1).onerror();
assert.match(env.status(),/無法讀取本機檔案/);assert.equal(env.snapshot(),before);
assert.equal(env.get('restore-review').disabled,true);
const noStorage=create({storageError:true});noStorage.edit(['one'],'old');
await noStorage.pick(JSON.stringify(value));noStorage.get('restore-review').click();
assert.deepEqual(noStorage.selected(),['two']);assert.equal(noStorage.get('review-notes').value,'saved\nnotes');
assert.match(noStorage.status(),/瀏覽器無法保存/);assert.match(noStorage.status(),/沒有啟動工作/);
assert.equal(noStorage.get('download-tasks').disabled,false);
""")
