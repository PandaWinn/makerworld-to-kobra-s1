# Privacy Statement

**MakerWorld to Anycubic Kobra S1 — Browser Extension (Chrome & Firefox)**

This document describes what data the extension accesses and how it is handled,
based on the current implementation.

---

## What the extension does

The extension operates on MakerWorld model pages to:

1. Inject a Anycubic Kobra S1 option into the printer filter carousel.
2. Intercept MakerWorld's own authenticated `.3mf` download when the user
   clicks **Convert to Anycubic Kobra S1**.
3. Convert the downloaded `.3mf` file locally in the browser using bundled
   JavaScript logic.
4. Trigger a file download of the converted `.3mf` to the user's device.

## Data the extension accesses

| Data | Purpose | Stored? | Transmitted? |
|---|---|---|---|
| MakerWorld page DOM | Inject Kobra S1 printer option and intercept download | No | No |
| `.3mf` file downloaded from MakerWorld | In-browser conversion | No | No |
| Extension settings (print profile, converter options and user preferences) | User preferences | Browser storage only | No |

## Credentials and authentication

The extension uses MakerWorld's existing authenticated download flow by
intercepting the network request that MakerWorld itself initiates when the
user clicks its own download button. The extension does not:

- Read, log, or store MakerWorld passwords
- Read, copy, or transmit browser cookies or session tokens
- Make authenticated requests to MakerWorld on its own, separate from the
  user's own browser session

## Local processing

The downloaded `.3mf` file is converted entirely within the browser using
bundled JavaScript code. The file is not uploaded to any server operated by
this project.

## Extension storage

User data is stored only in browser-managed extension storage, split by purpose:

- `storage.sync` — user settings (selected print profile, converter options,
  filament preset mode and other user preferences). The browser may sync this
  across devices if the user has browser sync enabled.
- `storage.local` — user-imported custom printer profiles.
- `storage.session` — transient per-download state used only to apply the
  expected filename to the converted file download (Chromium only).

No settings or profile data is transmitted to servers operated by this project.

## Analytics and telemetry

This extension does not include analytics, crash reporting, telemetry, or
remote error reporting of any kind.

## Third-party services

The extension interacts only with:

- **MakerWorld** (`makerworld.com`, `makerworld.com.cn`) — to intercept the
  user-initiated download, including the MakerWorld-signed file-delivery (CDN)
  URL that MakerWorld's own download response supplies for that download.
- **Browser extension APIs** — for storage and downloads.

No other third-party services are contacted by this extension.

## MakerWorld's own privacy policy

Accessing MakerWorld is subject to MakerWorld's own privacy policy and terms
of service. This extension does not modify or override those policies.

## Changes

If the extension's data practices change in a future version, this file will
be updated accordingly.
