#!/usr/bin/env bash
# macOS/Linux equivalent of build.ps1 (requires: bash, python3).
# Usage: ./build.sh   (run from the repository root)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

VERSION_CHROME=$(python3 -c "import json; print(json.load(open('$ROOT/manifest.json'))['version'])")
VERSION_FIREFOX=$(python3 -c "import json; print(json.load(open('$ROOT/manifest.firefox.json'))['version'])")

if [ "$VERSION_CHROME" != "$VERSION_FIREFOX" ]; then
  echo "Manifest versions do not match: Chrome $VERSION_CHROME, Firefox $VERSION_FIREFOX" >&2
  exit 1
fi

VERSION="$VERSION_CHROME"
echo "Building MakerWorld to Anycubic Kobra S1 v$VERSION..."

# Mirror of the file lists in build.ps1 — keep both in sync.
SHARED_FILES="background.js content.js converter.js ks1_native_bridge.js ks1_error_report.js injected.js options.html options.js ks1_3mf_metadata.js ks1_bambu_parser.js ks1_compatibility.js ks1_custom_printer_profiles.js ks1_filament_merge.js ks1_model_parser.js ks1_profile_resolver.js ks1_project_builder.js ks1_project_merge.js ks1_project_parser.js ks1_project_report.js README.md CHANGELOG.md PRIVACY.md THIRD_PARTY_NOTICES.md LICENSE LICENSE-POLYFORM"
SHARED_DIRS="assets lib"
SOURCE_FILES="manifest.json manifest.firefox.json background.js content.js converter.js ks1_native_bridge.js ks1_error_report.js injected.js options.html options.js ks1_3mf_metadata.js ks1_bambu_parser.js ks1_compatibility.js ks1_custom_printer_profiles.js ks1_filament_merge.js ks1_model_parser.js ks1_profile_resolver.js ks1_project_builder.js ks1_project_merge.js ks1_project_parser.js ks1_project_report.js build.ps1 build.sh BUILD.md README.md CHANGELOG.md PRIVACY.md THIRD_PARTY_NOTICES.md LICENSE LICENSE-POLYFORM"
SOURCE_DIRS="assets lib"

rm -rf "$ROOT/dist"
mkdir -p "$ROOT/dist/chrome" "$ROOT/dist/firefox" "$ROOT/dist/source"

for f in $SHARED_FILES; do
  [ -f "$ROOT/$f" ] || { echo "Required runtime file is missing: $f" >&2; exit 1; }
  cp "$ROOT/$f" "$ROOT/dist/chrome/"
  cp "$ROOT/$f" "$ROOT/dist/firefox/"
done

for d in $SHARED_DIRS; do
  [ -d "$ROOT/$d" ] || { echo "Required runtime directory is missing: $d" >&2; exit 1; }
  cp -R "$ROOT/$d" "$ROOT/dist/chrome/"
  cp -R "$ROOT/$d" "$ROOT/dist/firefox/"
done

cp "$ROOT/manifest.json" "$ROOT/dist/chrome/manifest.json"
cp "$ROOT/manifest.firefox.json" "$ROOT/dist/firefox/manifest.json"

for f in $SOURCE_FILES; do
  [ -f "$ROOT/$f" ] || { echo "Required source file is missing: $f" >&2; exit 1; }
  cp "$ROOT/$f" "$ROOT/dist/source/"
done

for d in $SOURCE_DIRS; do
  cp -R "$ROOT/$d" "$ROOT/dist/source/"
done

python3 - "$ROOT" "$VERSION" << 'PYEOF'
import os, sys, zipfile
root, version = sys.argv[1], sys.argv[2]
def make_zip(src_dir, dest):
    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(src_dir):
            for fn in sorted(files):
                full = os.path.join(base, fn)
                z.write(full, os.path.relpath(full, src_dir).replace(os.sep, '/'))
for name in ('chrome', 'firefox', 'source'):
    make_zip(os.path.join(root, 'dist', name),
             os.path.join(root, 'dist', f'makerworld-to-kobra-s1-{name}-v{version}.zip'))
PYEOF

echo
echo 'Build completed successfully.'
echo "Firefox folder: $ROOT/dist/firefox"
echo "Firefox ZIP:    $ROOT/dist/makerworld-to-kobra-s1-firefox-v$VERSION.zip"
