# One-Click "Open in Slicer Next" Bridge — Parked

Status: **removed from `kobra-s1-retarget`, preserved on branch `archive/slicer-bridge`**.
Decision (2026-09-14): ship download-only for now; revisit one-click open later.

## What was built (all on `archive/slicer-bridge`)

- `native_host/ks1_open_host.py` — Python stdlib native-messaging host. Chunked
  protocol (`open-begin` / `open-chunk` 512 KiB b64 / `open-commit` / `open-abort`
  / `ping`), filename sanitizing, temp `.3mf`, `open -a AnycubicSlicerNext`,
  `KS1_DRY_RUN=1` diagnostic mode. Unit-tested (`/tmp` scripts, not committed).
- `native_host/install.sh` — macOS installer writing Chrome
  (`allowed_origins`, needs `--chrome-id`) and Firefox (`allowed_extensions`
  with the stable gecko id) manifests + ping smoke test.
- Extension side: `ks1_native_bridge.js` (pure protocol helpers),
  `ks1_open_in_slicer` + `ks1_bridge_ping` background handlers, `afterConvert`
  download/open setting with download fallback, options UI + helper check.
- Full spec: `docs/superpowers/plans/2026-09-14-slicer-bridge.md` (kept on
  both branches).

## Verification evidence (before removal)

- Host round-trip of the real 2 MB converted organizer 3MF: **byte-identical**.
- Bridge JS chunk encode/decode round-trip 1.3 MB: byte-identical.
- `./native_host/install.sh` writes valid manifests; host ping replies
  `ok:true, slicer_found:true` on this machine.
- Packaged zips verified (bridge JS in, host excluded).

## Why it can't work on Firefox yet (root cause, verified 2026-09-14)

The user's Firefox install **did** have a correct manifest
(`~/Library/Application Support/Mozilla/NativeMessagingHosts/com.kobra-s1.makerworld_bridge.json`,
correct `allowed_extensions`), and the host answered pings directly —
yet the extension's helper check failed.

Cause: **temporary add-ons (`about:debugging` loads) get a random ID per
load**, not the manifest's `browser_specific_settings.gecko.id`. The declared
id (`{cb117586-ce92-423f-8267-edf658627950}`) only applies after AMO signing, so the
allowlist never matches an unsigned temporary load. No installer flag or
reload can fix this; it is inherent to the platform.

## Paths to resurrect

1. **Firefox:** submit `dist/*firefox*.zip` + `dist/*source*.zip` to AMO
   (unlisted self-distribution). Once signed + permanently installed, the ID
   stabilizes and the existing manifest matches. Needs the publisher's AMO
   account.
2. **Chrome:** load unpacked from `dist/chrome` (stable path-derived ID),
   read the ID at `chrome://extensions`, run
   `./native_host/install.sh --chrome-id <id>`. Expected to work immediately;
   never tested end-to-end (user chose download-only before trying).
3. Code: `git checkout archive/slicer-bridge -- native_host ks1_native_bridge.js`
   plus the extension wiring (see the plan doc's Task 3 file list). Note: the
   archived code predates the anonymity scrub — regenerate all bridge/host
   identifiers neutrally (this doc's names) before any public use.

## Related finding (Makeronline comparison)

Makeronline's one-click open is a cloud-ID handoff (`acnext://open` +
closed-source slicer plugin resolving via `uc.makeronline.com`) — not reusable
for MakerWorld files, which live on Bambu's CDN behind expiring signed URLs.
Slicer Next's URL handler only fetches http(s) URLs (`Downloader.cpp`), and a
pure extension cannot hand local bytes to another app, so a local bridge is
the only equivalent. Roaming `bambustudio://` to Slicer Next (Orca-style
protocol squatting) opens **raw unconverted** files — rejected as lower
quality than the converted download flow.
