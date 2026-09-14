# One-Click "Open in Slicer Next" Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional one-click path where the converted Kobra S1 project opens directly in Anycubic Slicer Next via a tiny local native-messaging bridge, with the extension setting choosing per conversion between helper-open and file download.

**Architecture:** Browser extensions cannot hand bytes to desktop apps and Slicer Next's URL handler only fetches http(s) URLs (verified in `Downloader.cpp:147-161` of the source clone), so a minimal native-messaging host (`native_host/ks1_open_host.py`, Python stdlib only) receives the converted 3MF in 512 KiB base64 chunks over a `connectNative` port, writes a temp file, and runs `open -a AnycubicSlicerNext`. No new manifest permissions are needed (`connectNative` requires none). If the host is missing, the extension falls back to the existing download flow with a one-time setup hint.

**Tech Stack:** Python3 stdlib (host), vanilla browser JS, existing `chrome.runtime` message patterns in `background.js` / `content.js`.

## Global Constraints

- Extension-only default preserved: helper is opt-in via new `afterConvert` setting (`'download'` default, `'open'` alternative). No behavior change unless the user opts in.
- No new extension-manifest permissions.
- Host must be dependency-free (macOS system Python3 only); macOS is the primary target, code structured for later Windows/Linux launch commands.
- Chrome native-message size limits require chunking: 512 KiB raw per `open-chunk` message, never a single giant message.
- Commit per task on branch `kobra-s1-retarget`; push at the end; no PR unless asked.

---

### Task 1: Native host script

**Files:**
- Create: `native_host/ks1_open_host.py`
- Test: `/tmp/ks1_host_test.py` (not committed; repo has no test harness, following the established /tmp verification pattern)

**Interfaces:**
- Consumes: stdin framed messages (4-byte little-endian length + UTF-8 JSON).
- Produces: stdout framed JSON responses; temp `.3mf` file + slicer launch on `open-commit`.

Protocol (all JSON, `protocol: 1`):
- `{"protocol":1,"action":"ping"}` → `{"protocol":1,"ok":true,"host":"ks1-open","version":"1.0.0","slicer_found":bool}`
- `{"protocol":1,"action":"open-begin","transfer_id":str,"filename":str,"total_bytes":int,"total_chunks":int}` → `{"protocol":1,"ok":true}` (rejects: >500 MB, bad filename, unknown transfer state)
- `{"protocol":1,"action":"open-chunk","transfer_id":str,"index":int,"data_b64":str}` → `{"protocol":1,"ok":true,"received":int}` (rejects out-of-order/duplicate/oversize chunk)
- `{"protocol":1,"action":"open-commit","transfer_id":str}` → assembles in index order, size-checks, writes `tempfile.NamedTemporaryFile(delete=False, suffix='.3mf', prefix='ks1-')`, launches slicer, returns `{"protocol":1,"ok":true,"path":str}` or `{"protocol":1,"ok":false,"error":str}`
- `{"protocol":1,"action":"open-abort","transfer_id":str}` → discards state, `{"protocol":1,"ok":true}`

Implementation notes (exact):
- Filename sanitize: `os.path.basename`, allow `[A-Za-z0-9._\-+() ]`, collapse rest to `_`, force `.3mf` suffix, cap 120 chars. Never trust directories.
- Slicer launch macOS: verify `/Applications/AnycubicSlicerNext.app` exists via `os.path.isdir`; launch `['open', '-a', 'AnycubicSlicerNext', path]` with `subprocess.Popen`, do NOT wait. If missing → `ok:false, error:'slicer-not-found'`.
- `KS1_DRY_RUN=1` env: write file, skip launch, return `ok:true, dry_run:true, path`. (Diagnostics + automated tests.)
- Structure for testability: pure functions `sanitize_filename()`, `read_message()`, `write_message()`, `handle_begin/chunk/commit/abort(state, msg)`, `find_slicer()`, `launch_slicer(path)`; framing loop only under `if __name__ == '__main__':`.

- [ ] **Step 1: Write the host script** (full content per above; ~150 lines).

- [ ] **Step 2: Write `/tmp/ks1_host_test.py`** covering: ping shape; sanitize (`'../../x.3mf'` → `'x.3mf'`, 200-char name truncated, suffix forced); begin→2 chunks→commit round-trip with `KS1_DRY_RUN=1` asserting reassembled bytes equal input and response `ok:true`; oversize begin rejected; out-of-order chunk rejected; commit with missing chunk rejected. Run: `python3 /tmp/ks1_host_test.py`. Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add native_host/ks1_open_host.py && git commit -m "feat: add native-messaging host for one-click open in Slicer Next"
```

### Task 2: Host installer (macOS)

**Files:**
- Create: `native_host/install.sh`
- Test: `/tmp` shell run with overridden `HOME` (no repo changes)

**Interfaces:**
- Consumes: `native_host/ks1_open_host.py` absolute path.
- Produces: `$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.pandawinn.makerworld_kobra_s1.json` and `$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/com.pandawinn.makerworld_kobra_s1.json`, each:
```json
{
  "name": "com.pandawinn.makerworld_kobra_s1",
  "description": "MakerWorld to Kobra S1 one-click open bridge",
  "path": "<ABSOLUTE PATH TO ks1_open_host.py>",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<CHROME ID>/", "moz-extension://<GECKO-UUID>/"]
}
```
Problem: extension IDs are unknown pre-store (Chrome ID assigned on publish; Firefox UUID per install). Solution used by other bridges: `allowed_origins` with Chrome ID filled at publish time is brittle — instead `install.sh` accepts `--chrome-id ID` (default: allow Chrome Web Store ID once known; until then document that Chrome needs its ID) — NO. Simpler correct approach: Chrome REQUIRES listed origins; there is no wildcard. So `install.sh --chrome-id <id> [--firefox-id <uuid>]`, defaulting Firefox to empty (Firefox ignores `allowed_origins`? No — Firefox USES `allowed_extensions` instead and ignores `allowed_origins`). Correct per-browser split:
- Chrome manifest: `allowed_origins: ["chrome-extension://<id>/"]` (required; script requires `--chrome-id`, aborts with usage otherwise).
- Firefox manifest: `allowed_extensions: ["makerworld-to-kobra-s1@pandawinn"]` (uses the stable gecko id from `manifest.firefox.json`; no per-install UUID needed).
`install.sh` validates python3 exists, `chmod +x` the host, writes both files, then smoke-tests: pipes a framed `ping` to the host and asserts `ok:true`. Flags: `--uninstall` removes both JSONs.

- [ ] **Step 1: Write `native_host/install.sh`** (bash, `set -euo pipefail`, ~60 lines) + `chmod +x`.

- [ ] **Step 2: Test with fake HOME**

Run:
```bash
FAKEHOME=$(mktemp -d) && HOME=$FAKEHOME ./native_host/install.sh --chrome-id abcdefghijklmnopqrstuvwxyzaabbcc
cat $FAKEHOME/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/*.json
cat $FAKEHOME/Library/Application\ Support/Mozilla/NativeMessagingHosts/*.json
python3 -c "import json,glob; [json.load(open(f)) for f in glob.glob('$FAKEHOME/Library/Application Support/*/NativeMessagingHosts/*.json')]; print('manifests valid')"
printf '\x1c\x00\x00\x00{"protocol":1,"action":"ping"}' | KS1_DRY_RUN=1 ./native_host/ks1_open_host.py | python3 -c "import sys,json,struct; d=sys.stdin.buffer.read(); n=struct.unpack('<I',d[:4])[0]; print(json.loads(d[4:4+n]))"
```
Expected: both JSONs valid (Chrome has the given id, Firefox has the gecko id), ping responds `ok:true, host:ks1-open`.

- [ ] **Step 3: Commit**

```bash
git add native_host/install.sh && git commit -m "feat: add macOS installer for one-click open bridge"
```

### Task 3: Extension bridge (setting + background + content + options UI)

**Files:**
- Create: `ks1_native_bridge.js` (pure protocol helpers, no chrome.* calls except none — must stay node-testable)
- Modify: `background.js` (append `ks1_open_in_slicer` + `ks1_bridge_ping` message handlers; append-only, do not touch download handlers)
- Modify: `manifest.json`, `manifest.firefox.json` (add `ks1_native_bridge.js` to NO manifest list — it is loaded only by background: Chrome service_worker single file cannot import extra files unless listed... service_worker supports `importScripts`. Add at top of `background.js`: `try { importScripts('ks1_native_bridge.js'); } catch {}` — works in Chrome SW and Firefox background page. So NO manifest change needed. Verify file is copied by build scripts: add to `SHARED_FILES` in `build.sh` AND `$sharedFiles`/`$sourceFiles` in `build.ps1`.)
- Modify: `content.js` (settings default `afterConvert:'download'` at line ~49 area; after conversion bytes ready, branch before the download stage: if `currentSettings.afterConvert==='open'`, send `{type:'ks1_open_in_slicer', filename: outName, data: <ArrayBuffer copy>}` to background; on `{ok:true}` set button state success (`KS1 profile opened`); on `{ok:false, hostMissing:true}` fall through to existing download path and append a report warning with setup hint)
- Modify: `options.html` + `options.js` (new "After conversion" radio: `afterConvert` download/open + hint `Requires the native_host bridge: run native_host/install.sh --chrome-id <your-id>` + "Check helper" button sending `ks1_bridge_ping` via background, showing `Helper found (slicer present)` / `Helper not installed` / `Slicer Next not found`)
- Modify: `build.sh`, `build.ps1` (add `ks1_native_bridge.js` to shared + source lists)
- Test: `/tmp/ks1_bridge_test.js` (node, loads `ks1_native_bridge.js` via `fs`+`vm`)

**Interfaces:**
- `ks1_native_bridge.js` produces (exact names):
  - `const KS1_BRIDGE_HOST = 'com.pandawinn.makerworld_kobra_s1'`
  - `const KS1_BRIDGE_CHUNK_SIZE = 524288`
  - `function buildKS1OpenPlan(filename, totalBytes)` → `{transferId (random hex 16), filename (sanitized same rules as host), totalBytes, totalChunks}`
  - `function encodeKS1Chunk(bytesUint8, index)` → base64 string slice for that chunk (uses global `btoa`; chunking is byte-exact: `bytes.subarray(index*SIZE, (index+1)*SIZE)`)
  - `function decodeKS1ChunkB64(b64)` → Uint8Array (test round-trip helper; uses global `atob`)
- `background.js` handler `ks1_open_in_slicer`: validates `msg.data instanceof ArrayBuffer` + nonempty + filename; `chrome.runtime.connectNative(KS1_BRIDGE_HOST)` in try/catch → on throw with `/not found|No such native/i` reply `{ok:false, hostMissing:true, error}`; else post begin/chunks/commit sequentially with 60 s overall timeout; on port disconnect/error → `{ok:false, hostMissing:true}` if never connected else `{ok:false, error}`; ALWAYS `port.disconnect()`.
- `background.js` handler `ks1_bridge_ping`: connect, post `{protocol:1,action:'ping'}`, reply first response or timeout error, disconnect.
- content.js fallback: helper failure must NEVER lose the file — any non-ok (except user-explicit?) falls back to the existing `attemptOutputDownload` path with the computed filename.

- [ ] **Step 1: Write `ks1_native_bridge.js`** (~60 lines, zero browser APIs).

- [ ] **Step 2: Node protocol test** `/tmp/ks1_bridge_test.js`: loads the file in `vm`, builds plan for a 1_300_000-byte fixture, asserts `totalChunks===3`, round-trips every chunk through encode→decode→compare, asserts sanitize (`'../../a b.3mf'`→ safe). Run `node /tmp/ks1_bridge_test.js`. Expected: PASS.

- [ ] **Step 3: Wire background.js handlers** (append before final `return false;`, keep download code untouched).

- [ ] **Step 4: Wire content.js branch + settings default** (default object line ~49; branch right after `converted` bytes + `outName` are ready, before stage 7 download block; reuse the Firefox `downloadData` ArrayBuffer copy for the message payload in BOTH browsers).

- [ ] **Step 5: Options UI** (radio + hint + check button; options.js load/save via existing `getSyncStorage`/`setSyncStorage` with new `afterConvert` DEFAULTS key).

- [ ] **Step 6: `node --check` all js + manifests parse**; then commit:

```bash
git add ks1_native_bridge.js background.js content.js options.js options.html manifest.json manifest.firefox.json build.sh build.ps1 && git commit -m "feat: optional one-click open in Slicer Next (falls back to download)"
```

### Task 4: End-to-end verification + rebuild + push

**Files:** none in repo (scripts in `/tmp`).

- [ ] **Step 1: Host round-trip with a REAL converted 3MF**

Run:
```bash
python3 << 'PYEOF'
import struct, json, subprocess, os
host = ['python3', 'native_host/ks1_open_host.py']
env = dict(os.environ, KS1_DRY_RUN='1')
p = subprocess.Popen(host, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
def rpc(msg):
    b = json.dumps(msg).encode()
    p.stdin.write(struct.pack('<I', len(b)) + b); p.stdin.flush()
    n = struct.unpack('<I', p.stdout.read(4))[0]
    return json.loads(p.stdout.read(n))
data = open('/tmp/out_organizer.3mf','rb').read()
import math
chunks = math.ceil(len(data)/524288)
print('ping:', rpc({"protocol":1,"action":"ping"}))
print('begin:', rpc({"protocol":1,"action":"open-begin","transfer_id":"test1","filename":"Module-Desk-Organizer-KobraS1.3mf","total_bytes":len(data),"total_chunks":chunks}))
import base64
for i in range(chunks):
    r = rpc({"protocol":1,"action":"open-chunk","transfer_id":"test1","index":i,"data_b64":base64.b64encode(data[i*524288:(i+1)*524288]).decode()})
    assert r['ok'], r
fin = rpc({"protocol":1,"action":"open-commit","transfer_id":"test1"})
print('commit:', {k: fin[k] for k in ('ok','dry_run')}, 'path:', fin.get('path'))
disk = open(fin['path'],'rb').read()
assert disk == data and len(disk) == len(data), 'byte mismatch'
print('E2E BYTE-IDENTICAL:', len(disk))
p.stdin.close(); p.wait()
PYEOF
```
Expected: `E2E BYTE-IDENTICAL: 2088403` (organizer output size may vary; assert equality, not the number).

- [ ] **Step 2: Rebuild packages** `./build.sh`; verify firefox zip contains `ks1_native_bridge.js` + `native_host` is NOT inside the extension (host ships separately — confirm absent).

- [ ] **Step 3: Push**

```bash
git push origin kobra-s1-retarget && git log --oneline -5
```

## Self-Review

- Spec coverage: local helper created ✓ (Tasks 1–2); extension option helper-vs-download ✓ (Task 3: `afterConvert` default download, opt-in open, fallback never loses file, options UI + helper check); Makeronline-parity UX (one button → slicer opens) ✓ via bridge since their cloud pipe is not reusable (documented in plan Architecture).
- Placeholder scan: exact protocol JSON, exact function/file names, exact commands with expected outputs; `/tmp` scripts fully specified inline.
- Type consistency: `transfer_id`/`total_bytes`/`total_chunks`/`data_b64` identical in Tasks 1/3/4; `KS1_BRIDGE_HOST`/`KS1_BRIDGE_CHUNK_SIZE` shared; `ks1_open_in_slicer`/`ks1_bridge_ping` message types identical in content/background/options paths; `afterConvert: 'download'|'open'` everywhere.
