#!/usr/bin/env bash
# Installer for the MakerWorld-to-KobraS1 one-click open bridge (macOS).
#
# Writes the Chrome + Firefox native-messaging manifests pointing at
# native_host/ks1_open_host.py, then smoke-tests the host with a ping.
#
# Usage:
#   ./native_host/install.sh --chrome-id <CHROME_WEBSTORE_ID>
#   ./native_host/install.sh --chrome-id <ID> --firefox-id <UUID>   (rarely needed)
#   ./native_host/install.sh --uninstall
#
# Chrome requires the Web Store extension ID in allowed_origins, so
# --chrome-id is mandatory for Chrome. Firefox uses the stable gecko id
# (allowed_extensions) and needs no per-install identifier.
set -euo pipefail

HOST_NAME="com.pandawinn.makerworld_kobra_s1"
GECKO_ID="makerworld-to-kobra-s1@pandawinn"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/ks1_open_host.py"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
FIREFOX_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
CHROME_ID=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --chrome-id) CHROME_ID="${2:-}"; shift 2 ;;
    --firefox-id) shift 2 ;; # accepted for compatibility; Firefox uses allowed_extensions
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown argument: $1" >&2; echo "Usage: $0 --chrome-id <ID> | --uninstall" >&2; exit 1 ;;
  esac
done

if [ "$UNINSTALL" = "1" ]; then
  rm -f "$CHROME_DIR/$HOST_NAME.json" "$FIREFOX_DIR/$HOST_NAME.json"
  echo "Bridge manifests removed."
  exit 0
fi

command -v python3 >/dev/null || { echo "python3 is required but not installed." >&2; exit 1; }
[ -f "$HOST_PATH" ] || { echo "Host script missing: $HOST_PATH" >&2; exit 1; }
chmod +x "$HOST_PATH"

if [ -z "$CHROME_ID" ]; then
  echo "Missing --chrome-id <CHROME_WEBSTORE_ID>." >&2
  echo "Chrome requires the extension ID in allowed_origins." >&2
  echo "Firefox-only install: $0 --chrome-id SKIP" >&2
  exit 1
fi

mkdir -p "$CHROME_DIR" "$FIREFOX_DIR"

if [ "$CHROME_ID" = "SKIP" ]; then
  echo "Skipping Chrome manifest (--chrome-id SKIP)."
else
  cat > "$CHROME_DIR/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "MakerWorld to Kobra S1 one-click open bridge",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$CHROME_ID/"]
}
EOF
  echo "Wrote $CHROME_DIR/$HOST_NAME.json"
fi

cat > "$FIREFOX_DIR/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "MakerWorld to Kobra S1 one-click open bridge",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_extensions": ["$GECKO_ID"]
}
EOF
echo "Wrote $FIREFOX_DIR/$HOST_NAME.json"

# Smoke test: framed ping round-trip (payload is exactly 30 bytes).
REPLY=$(printf '\x1e\x00\x00\x00{"protocol":1,"action":"ping"}' | python3 "$HOST_PATH" | python3 -c "
import sys, json, struct
d = sys.stdin.buffer.read()
n = struct.unpack('<I', d[:4])[0]
print(json.dumps(json.loads(d[4:4+n])))" 2>/dev/null || true)
echo "Host ping reply: ${REPLY:-(no reply)}"
case "$REPLY" in
  *'"ok": true'*) echo "Bridge installed and responding." ;;
  *) echo "WARNING: host did not answer ping — check python3 and script permissions." >&2; exit 1 ;;
esac
