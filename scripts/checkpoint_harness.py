"""Capture changed source files at a Harness breakpoint; excludes workspace data."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ALLOWED_ROOTS = {'alphaview', 'web', 'tests', 'docs', 'scripts'}
ALLOWED_SUFFIXES = {'.py', '.ts', '.tsx', '.js', '.json', '.css', '.html', '.md', '.toml', '.lock', '.yaml', '.yml', '.txt', '.svg', '.png', '.jpg', '.webp', '.sh'}

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def source_path(name):
    path = Path(name)
    return (not path.is_absolute() and '..' not in path.parts
            and (len(path.parts) == 1 or path.parts[0] in ALLOWED_ROOTS)
            and not any(part in {'node_modules', 'dist', '__pycache__', '.venv', '.cache'} for part in path.parts)
            and (path.suffix in ALLOWED_SUFFIXES or path.name in {'.gitignore', 'LICENSE', 'uv.lock'})
            and not path.name.startswith('.env'))

def checkpoint(directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    names = sorted(set((git('diff', '--no-renames', '--name-only', '-z', 'HEAD') + git('ls-files', '--others', '--exclude-standard', '-z')).decode().split('\0')) - {''})
    entries, payloads = [], []
    for name in names:
        if not source_path(name):
            continue
        target = ROOT / name
        if target.is_symlink():
            continue
        if not target.exists():
            entries.append({'path': name, 'status': 'deleted'})
            continue
        if not target.is_file() or target.stat().st_size > 20_000_000:
            continue
        content = target.read_bytes()
        entries.append({'path': name, 'status': 'captured', 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
        payloads.append((name, content))
    manifest = {
        'format_version': 1, 'project': 'AlphaView',
        'captured_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'base_commit': git('rev-parse', 'HEAD').decode().strip(),
        'branch': git('branch', '--show-current').decode().strip(),
        'scope': 'Changed source files in the current local workspace, including earlier theme and language edits. Not a standalone checkout or database backup. No automatic restore.',
        'files': entries,
    }
    encoded = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    (directory / 'source-manifest.json').write_text(encoded, encoding='utf-8')
    with zipfile.ZipFile(directory / 'source-checkpoint.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('source-manifest.json', encoded)
        for name, content in payloads:
            archive.writestr('source/' + name, content)
    return {'file': 'source-checkpoint.zip', 'manifest': 'source-manifest.json', 'captured_at': manifest['captured_at'], 'files': len(entries), 'base_commit': manifest['base_commit']}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(checkpoint(args.directory), ensure_ascii=False))
