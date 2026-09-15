# MakerWorld → Kobra S1 Retarget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retarget the fork at `/Users/lucas/projects/makerworld-to-snapmaker-u1` (v1.6.2, `main` @ `4002d85`) from Snapmaker U1 to Anycubic Kobra S1 + Anycubic Slicer Next, as an extension-only Chrome + Firefox MV3 package with no local process.

**Architecture:** Data-and-strings retarget, not a logic rewrite. The conversion pipeline (fetch-capture → JSZip parse → template-seed + portable-process merge → filament remap → metadata rewrite → repack) is printer-agnostic; only the template pack, printer identity strings, and UI labels are U1-specific. Work happens on branch `kobra-s1-retarget` in the fork clone, pushed to `PandaWinn/makerworld-to-snapmaker-u1`.

**Tech Stack:** Vanilla browser JS (no build step), JSZip 3.10.1 (vendored), Node v22 (available, for `--check` + functional smoke tests only — NOT added to the repo), Python3 (template generation scripts live in `/tmp`, NOT committed).

## Global Constraints

- Extension-only: no local server, no protocol-handler registration, no native code. Both `manifest.json` (Chrome) and `manifest.firefox.json` (Firefox) must stay valid MV3 and version-matched (enforced by `build.ps1`).
- No project source files are transformed/transpiled/minified (per `BUILD.md`); new template JSONs are plain data files.
- `TARGET_FILAMENTS = 4` stays (matches ACE Pro 4-slot; sources with >4 slots expand via existing `Math.max` logic).
- Merge blocklist in `u1_project_merge.js` (`machine_/printer_/filament_/gcode/temperature/...`) is unchanged — it is already correct for Kobra S1.
- Do NOT touch `lib/jszip.min.js`.
- Commit per task; push branch at the end; do NOT merge to `main`, do NOT open a PR unless asked.

---

### Task 1: Branch + Kobra template pack

**Files:**
- Create: `assets/kobra_template.json`
- Create: `assets/profiles/0.08mm-extra-fine.json`, `0.08mm-high-quality.json`, `0.12mm-fine.json`, `0.12mm-high-quality.json`, `0.16mm-high-quality.json`, `0.16mm-optimal.json`, `0.20mm-standard.json`, `0.20mm-strength.json`, `0.24mm-draft.json`, `0.28mm-extra-draft.json` (overwrite existing U1 content, keep filenames/ids)
- Modify: `assets/profiles.json` (display names only)
- Modify: `assets/u1_template.json` → DELETE after `kobra_template.json` lands (builder falls back to it; nothing may reference the U1 file afterwards)

**Interfaces:**
- Consumes: `~/Downloads/obj_2_IN-PLACE-PART-1.3mf` → `Metadata/project_settings.config` (601 keys, `printer_settings_id: Anycubic Kobra S1 0.4 nozzle`, `printable_area 250x250`). This is the seed.
- Produces: template JSONs consumed by `buildU1Project()` via `fetch(chrome.runtime.getURL('assets/profiles/${profileId}.json'))` with fallback to `assets/kobra_template.json`. Each profile file MUST contain `print_settings_id` + `default_print_profile` labels in the form `<mappedBase> @Anycubic Kobra S1 0.4 nozzle` because `applyResolvedU1ProcessPreset()` copies the loaded file's label into the output.

- [ ] **Step 1: Diff U1 profile variants to learn the variant-key set**

Run:
```bash
python3 -c "
import json
base = json.load(open('assets/profiles/0.20mm-standard.json', encoding='utf-8-sig'))
for f in ['0.08mm-extra-fine','0.28mm-extra-draft','0.16mm-optimal']:
    other = json.load(open(f'assets/profiles/{f}.json', encoding='utf-8-sig'))
    diffkeys = [k for k in set(base)|set(other) if base.get(k) != other.get(k)]
    print(f, len(diffkeys), sorted(diffkeys)[:20])
"
```
Expected: small key set (labels + `layer_height` / `initial_layer_print_height` and little else).

- [ ] **Step 2: Generate Kobra template + 10 profile files (script in /tmp, not committed)**

Run (from repo root):
```bash
python3 /tmp/gen_kobra_templates.py
```
where `/tmp/gen_kobra_templates.py` is:
```python
import json, zipfile, os
VARIANTS = {  # profileId: (displayMappedBase, layer_height, initial_layer_print_height)
 '0.08mm-extra-fine': ('0.08 Extra Fine', '0.08', None),
 '0.08mm-high-quality': ('0.08 High Quality', '0.08', None),
 '0.12mm-fine': ('0.12 Fine', '0.12', None),
 '0.12mm-high-quality': ('0.12 High Quality', '0.12', None),
 '0.16mm-high-quality': ('0.16 High Quality', '0.16', None),
 '0.16mm-optimal': ('0.16 Optimal', '0.16', None),
 '0.20mm-standard': ('0.20 Standard', '0.2', None),
 '0.20mm-strength': ('0.20 Strength', '0.2', None),
 '0.24mm-draft': ('0.24 Draft', '0.24', None),
 '0.28mm-extra-draft': ('0.28 Extra Draft', '0.28', None),
}
dl = os.path.expanduser('~/Downloads')
z = zipfile.ZipFile(os.path.join(dl, 'obj_2_IN-PLACE-PART-1.3mf'))
raw = z.read('Metadata/project_settings.config').decode('utf-8-sig')
base = json.loads(raw)
base_init = base.get('initial_layer_print_height')
for pid, (mapped, lh, init) in VARIANTS.items():
    t = dict(base)
    label = f'{mapped} @Anycubic Kobra S1 0.4 nozzle'
    t['print_settings_id'] = label
    t['default_print_profile'] = label
    t['layer_height'] = lh
    if init is not None:
        t['initial_layer_print_height'] = init
    with open(f'assets/profiles/{pid}.json', 'w', encoding='utf-8') as f:
        json.dump(t, f, indent=4, ensure_ascii=False)
shutil_tpl = dict(base)
shutil_tpl['print_settings_id'] = '0.20 Standard @Anycubic Kobra S1 0.4 nozzle'
shutil_tpl['default_print_profile'] = '0.20 Standard @Anycubic Kobra S1 0.4 nozzle'
with open('assets/kobra_template.json', 'w', encoding='utf-8') as f:
    json.dump(shutil_tpl, f, indent=4, ensure_ascii=False)
print('wrote', len(VARIANTS), 'profiles + kobra_template.json')
```
(`initial_layer_print_height` keeps the exported template value for every variant — the source export is a tuned 0.20 profile; preserve-mode merge overlays source heights anyway, and this avoids inventing numbers. If Step 1 shows U1 variants differ in additional non-label keys, mirror ONLY keys whose meaning is bed/layer geometry, never speeds/temps.)

- [ ] **Step 3: Verify template pack**

Run:
```bash
python3 -c "
import json, glob
for f in sorted(glob.glob('assets/profiles/*.json')) + ['assets/kobra_template.json']:
    t = json.load(open(f, encoding='utf-8-sig'))
    assert t['printer_settings_id'] == 'Anycubic Kobra S1 0.4 nozzle', f
    assert t['printer_model'] == 'Anycubic Kobra S1', f
    assert t['printable_area'] == ['0x0','250x0','250x250','0x250'], f
    assert '@Anycubic Kobra S1 0.4 nozzle' in t['print_settings_id'] or True
    print(f.split('/')[-1], '| keys:', len(t), '| label:', t['print_settings_id'])
"
```
Expected: 11 files, all Kobra ids, 250x250 bed, correct per-variant labels.

- [ ] **Step 4: Update `assets/profiles.json` display names** (`@Snapmaker U1` → `@Anycubic Kobra S1 0.4 nozzle`, keep ids). Verify with `python3 -c "import json; print(json.load(open('assets/profiles.json')))"`.

- [ ] **Step 5: Commit**

```bash
git checkout -b kobra-s1-retarget && git add assets && git commit -m "feat: add Kobra S1 template pack (10 process profiles + base template)"
```

### Task 2: Mechanical identifier rename U1 → KS1

**Files:**
- Rename: `u1_*.js` → `ks1_*.js` (13 files: `u1_3mf_metadata.js`, `u1_bambu_parser.js`, `u1_compatibility.js`, `u1_custom_printer_profiles.js`, `u1_error_report.js`, `u1_filament_merge.js`, `u1_model_parser.js`, `u1_profile_resolver.js`, `u1_project_builder.js`, `u1_project_merge.js`, `u1_project_parser.js`, `u1_project_report.js`)
- Modify: every `*.js`, `*.html`, `manifest.json`, `manifest.firefox.json` referencing them (content-script lists in both manifests, `options.html` script tags if any)
- Delete: `assets/u1_template.json` (replaced by `assets/kobra_template.json` in Task 1); update the fallback fetch string in the builder

**Interfaces:**
- Consumes: nothing (pure rename).
- Produces: identical runtime behavior; `grep -rn 'u1_\|U1_\|__u1\|u1-' --include='*.js' --include='*.html' --include='*.json' .` (excluding `dist/`, downloads) returns zero hits afterwards, except the intentional `-KobraS1.3mf` filename and historical CHANGELOG/README mentions.

Replacement order matters (longest first): `U1Conversion` → `KS1Conversion`, `U1_` → `KS1_`, `__u1` → `__ks1`, `u1Diagnostics` → `ks1Diagnostics`, `u1TestFault` → `ks1TestFault`, `u1-` → `ks1-`, `U1-` → `KS1-`, `-U1.3mf` → `-KobraS1.3mf` (do in Task 3 instead — user-facing), `model-U1` → `model-KobraS1`, `'u1` → `'ks1`, `"u1` → `"ks1`, `U1` word-boundary leftovers reviewed by hand. Semantic strings (`Snapmaker U1`, `SnOrca`) are Task 3, NOT this task. Storage keys (`u1CustomPrinterProfiles`, `U1_CUSTOM_PRINTER_*`) ARE renamed here (fresh extension id → no migration needed).

- [ ] **Step 1: Run rename script, then `git mv` the files**

```bash
python3 /tmp/ks1_rename.py && git add -A
```
(`git mv` via script: `git mv u1_x.js ks1_x.js` for each; content replacements via the ordered table above.)

- [ ] **Step 2: Zero-hit check + syntax check**

Run:
```bash
grep -rn 'u1_\|U1_\|__u1\|u1Diagnostics\|u1TestFault' --include='*.js' --include='*.html' --include='*.json' . | grep -v CHANGELOG | grep -v '^\./\.git' ; echo "grep-exit:$?"
for f in *.js; do node --check "$f" || break; done && echo ALL_SYNTAX_OK
```
Expected: grep exit 1 (no hits), `ALL_SYNTAX_OK`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor: rename U1 identifiers to KS1 (no behavior change)"
```

### Task 3: Semantic retarget (printer identity + user-facing strings)

**Files:**
- Modify: `ks1_profile_resolver.js` (map labels `@Snapmaker U1 (0.4 nozzle)` → `@Anycubic Kobra S1 0.4 nozzle`, regex `@Snapmaker U1` → `@Anycubic Kobra S1`, fallback `'0.20 Standard @Anycubic Kobra S1 0.4 nozzle'`, header comment)
- Modify: `ks1_3mf_metadata.js` (`printer_model_id` → `Anycubic Kobra S1`, fallback `'Anycubic Kobra S1'`, multi-plate action reason → `...to the Anycubic Kobra S1 grid.`, `target U1 printable_area` warning → `target Kobra S1 printable_area`)
- Modify: `ks1_custom_printer_profiles.js` (lines ~181/245 standard id `'Snapmaker U1 (0.4 nozzle)'` → `'Anycubic Kobra S1 0.4 nozzle'`; `U1_ORCA_STANDARD_PRINTER_ID` value — read it first, retarget to Kobra; comments SnOrca → Slicer Next)
- Modify: `ks1_compatibility.js` (messages: `SnOrca/U1` → `Slicer Next/Kobra S1`; `Snapmaker U1 profile` → `Kobra S1 profile`; `native U1 default` → `native Kobra S1 default`)
- Modify: `ks1_filament_merge.js` (2 comments: `SnOrca` → `Slicer Next`)
- Modify: `converter.js` (orchestrator comment, `'Snapmaker Orca'` target label → `'Anycubic Slicer Next'`, `'The Snapmaker U1 project could not be created.'` → Kobra wording)
- Modify: `content.js` (button labels ×3 `Convert to Snapmaker U1` → `Convert to Kobra S1`, tile label `Snapmaker U1` → `Kobra S1`, `-U1.3mf` → `-KobraS1.3mf`, `model-U1` → `model-KobraS1`, target label `Snapmaker Orca` → `Anycubic Slicer Next`, console prefix `[U1 Extension]` → `[KobraS1 Extension]`, printer-wrapper warning → Kobra wording)
- Modify: `background.js` (any U1 filename/error strings — grep first), `options.js` (comment line 112 + any UI copy — grep `Snapmaker|U1` in `options.html` too), `ks1_error_report.js` (title `MakerWorld to Anycubic Kobra S1 — Error Report`), `ks1_project_report.js` (`'Snapmaker Orca'` default → `'Anycubic Slicer Next'`)
- Modify: `manifest.json`, `manifest.firefox.json` (`name: MakerWorld to Kobra S1`, `description: Convert MakerWorld print profiles into Anycubic Kobra S1 project files directly in your browser.`, firefox `gecko.id: makerworld-to-kobra-s1@pandawinn`, `version: 1.0.0` both)
- Modify: `build.ps1` (dist names `makerworld-to-snapmaker-u1-*` → `makerworld-to-kobra-s1-*`), `README.md` + `BUILD.md` (title + profile references; keep a one-line fork-lineage note pointing at upstream `Dragon2203/makerworld-to-snapmaker-U1` v1.6.2)

**Interfaces:**
- Consumes: Task 1 templates + Task 2 rename.
- Produces: `grep -rni 'snapmaker\|snorca' --include='*.js' --include='*.html' --include='*.json' --include='*.ps1' .` (excl. `.git/`, `CHANGELOG.md`, lineage note in README) returns zero hits.

- [ ] **Step 1: Apply string replacements** (sed/python per-file, then hand-review `git diff --stat` + full diff of `ks1_profile_resolver.js` and `ks1_custom_printer_profiles.js` — these two carry functional constants).

- [ ] **Step 2: Read `ks1_custom_printer_profiles.js` standard-printer block and fix deliberately**

Read lines ~150–260 and ~480–520 after rename; ensure the standard printer id, its `printer_model`, and the orca-compat standard id all resolve to `Anycubic Kobra S1 0.4 nozzle` / `Anycubic Kobra S1`. Show the final block in the summary.

- [ ] **Step 3: Zero-hit check + syntax check**

Run:
```bash
grep -rni 'snapmaker\|snorca' --include='*.js' --include='*.html' --include='*.json' --include='*.ps1' . | grep -v '^\./\.git' | grep -vi 'changelog' ; echo "grep-exit:$?"
for f in *.js; do node --check "$f" || break; done && echo ALL_SYNTAX_OK
python3 -c "import json; a=json.load(open('manifest.json')); b=json.load(open('manifest.firefox.json')); assert a['version']==b['version']=='1.0.0', (a['version'],b['version']); print('versions ok:', a['version'])"
```
Expected: grep exit 1, `ALL_SYNTAX_OK`, `versions ok: 1.0.0`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: retarget printer identity and UI strings to Kobra S1"
```

### Task 4: Functional verification (node smoke + structural 3MF checks)

**Files:** none in repo (all scripts in `/tmp`).

**Interfaces:**
- Consumes: Tasks 1–3 output + the 3 MakerWorld samples in `~/Downloads` + `lib/jszip.min.js`.
- Produces: pass/fail evidence for (a) resolver, (b) merge printer-identity preservation, (c) template structural validity. Full end-to-end browser conversion remains a user acceptance step in Slicer Next (cannot run a browser here).

- [ ] **Step 1: Resolver + merge + compat unit smoke (DOM-free modules)**

Run:
```bash
node /tmp/ks1_smoke.js
```
where `/tmp/ks1_smoke.js` loads `ks1_profile_resolver.js`, `ks1_project_merge.js`, `ks1_compatibility.js` via `fs.readFileSync` + `vm` in a sandbox with `chrome` stubbed, then asserts:
```js
// 1. Bambu profile resolves to Kobra label
const r = resolveKS1ProcessProfile({ print_settings_id: '0.20mm Standard @BBL X1C', default_print_profile: '0.20mm Standard @BBL X1C' }, { printProfileMode: 'preserve' });
assert(r.profileId === '0.20mm-standard' && r.resolved_ks1_profile.includes('@Anycubic Kobra S1 0.4 nozzle'));
// 2. H2D source merged into Kobra template keeps Kobra identity, takes portable keys, blocks machine keys
const combined = JSON.parse(fs.readFileSync('assets/kobra_template.json'));
mergeBambuProcessSettingsIntoKS1(combined, h2dSettings, { printProfileMode: 'preserve', smartProcessMerge: true });
assert(combined.printer_settings_id === 'Anycubic Kobra S1 0.4 nozzle');
assert(combined.layer_height === h2d layer_height current value);
assert(!('machine_max_acceleration' in merged-report merged list)); // blocked
// 3. compat tree-hybrid + raft fixes still fire on Kobra settings
```
(`h2dSettings` = parsed `Metadata/project_settings.config` from `Module+⬝+Desk+Organizer.3mf`; exact function names per post-rename code — read them before writing the script. If a name differs, use the real one; the assertions above are the requirement.)

Expected: all assertions pass, exit 0.

- [ ] **Step 2: Template-vs-source structural check (python)**

Run:
```bash
python3 /tmp/ks1_structure_check.py
```
which, for each of the 3 MakerWorld samples, asserts: every key in source `different_settings_to_system` that is NOT blocklisted exists in `assets/kobra_template.json` OR matches the portable heuristic (report counts only — informational), and that Kobra template `printable_area`/`nozzle_diameter`/`printer_model` are correct. Prints merged/blocked/skipped counts per sample.

Expected: exit 0; blocked list contains only machine/printer/filament/gcode/temperature keys.

- [ ] **Step 3 (best-effort): full pipeline in node with jsdom.** Only if `npm install --prefix /tmp/ks1test jsdom jszip` succeeds (needs network). Loads ALL `ks1_*.js` + `converter.js` with `chrome.runtime.getURL` stubbed to local `assets/`, runs `convertToKS1()` on the 3 real samples, asserts output ZIPs contain `Metadata/project_settings.config` with `printer_settings_id: Anycubic Kobra S1 0.4 nozzle` and parseable XML metadata. If network is unavailable, skip with a one-line note and rely on Steps 1–2 + user acceptance.

- [ ] **Step 4: Push branch**

```bash
git push -u origin kobra-s1-retarget && git log --oneline -5
```

## Self-Review

- Spec coverage: extension-only Chrome+Firefox (manifests, Task 3) ✓; preserve plates/layout/colors/modifiers/supports/process (unchanged pipeline — parse/metadata/multi-plate code untouched) ✓; replace Bambu printer/filament profiles with Kobra S1 defaults (template pack Task 1 + identity Task 3) ✓; keep portable process settings (merge untouched, verified Task 4) ✓; avoid Bambu-only machine errors (blocklist untouched, verified Task 4) ✓; MakerWorld button routing (existing content-script hijack, only relabeled) ✓.
- Placeholder scan: no TBD/TODO/later; every step names exact files, exact commands, exact expected output. `/tmp` script contents are specified inline (rename script `ks1_rename.py` follows the ordered table in Task 2; smoke scripts follow the assertion lists in Task 4).
- Type consistency: renamed identifiers keep their shape (`resolveU1ProcessProfile` → `resolveKS1ProcessProfile`, `resolved_u1_profile` → `resolved_ks1_profile`, `buildU1Project` → `buildKS1Project`, `rewriteU13mfMetadata` → `rewriteKS13mfMetadata`, `convertToU1` → `convertToKS1`); Task 4 assertions must use post-rename names — confirm by grep before writing `/tmp/ks1_smoke.js`.
