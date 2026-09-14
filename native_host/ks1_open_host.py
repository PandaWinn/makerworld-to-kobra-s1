#!/usr/bin/env python3
"""MakerWorld to Kobra S1 — one-click open bridge (native messaging host).

Receives a converted 3MF from the browser extension in base64 chunks,
writes it to a temp file and opens it in Anycubic Slicer Next.

Protocol (JSON, stdin/stdout framed with 4-byte little-endian length):
  {"protocol":1,"action":"ping"} -> capabilities + slicer presence
  {"protocol":1,"action":"open-begin","transfer_id","filename",
   "total_bytes","total_chunks"} -> {"ok":true} (starts a transfer)
  {"protocol":1,"action":"open-chunk","transfer_id","index","data_b64"}
  {"protocol":1,"action":"open-commit","transfer_id"}
    -> {"ok":true,"path":...} (assembles, writes temp .3mf, launches slicer)
  {"protocol":1,"action":"open-abort","transfer_id"} -> discards transfer

Stdlib only. macOS is the primary target; launch logic is isolated in
launch_slicer() for later Windows/Linux variants.

Env:
  KS1_DRY_RUN=1  write the file but skip launching the slicer
                 (diagnostics + automated tests). Response includes
                 "dry_run": true.
"""

import base64
import json
import os
import re
import struct
import subprocess
import sys
import tempfile

PROTOCOL_VERSION = 1
HOST_NAME = "ks1-open"
HOST_VERSION = "1.0.0"

MAX_TOTAL_BYTES = 500 * 1024 * 1024
MAX_CHUNK_BYTES = 1 * 1024 * 1024  # raw bytes per chunk after decode
MAX_FILENAME_LEN = 120

SLICER_APP_NAME = "AnycubicSlicerNext"
SLICER_APP_PATH = "/Applications/AnycubicSlicerNext.app"


def read_message():
    """Read one length-prefixed JSON message from stdin. Returns None on EOF."""
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        return None
    if len(raw_len) != 4:
        raise ValueError("truncated message length prefix")
    (length,) = struct.unpack("<I", raw_len)
    if length == 0 or length > 64 * 1024 * 1024:
        raise ValueError("invalid message length: %d" % length)
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise ValueError("truncated message payload")
    return json.loads(payload.decode("utf-8"))


def write_message(obj):
    payload = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def error(message, **extra):
    response = {"protocol": PROTOCOL_VERSION, "ok": False, "error": message}
    response.update(extra)
    return response


def sanitize_filename(raw):
    """Basename-only, safe chars, forced .3mf suffix, capped length."""
    name = os.path.basename(str(raw or ""))
    name = re.sub(r"[^A-Za-z0-9._\-+() ]", "_", name).strip()
    if not name or name in (".", ".."):
        name = "model-KobraS1.3mf"
    if not name.lower().endswith(".3mf"):
        name += ".3mf"
    if len(name) > MAX_FILENAME_LEN:
        stem = name[: -len(".3mf")]
        name = stem[: MAX_FILENAME_LEN - len(".3mf")] + ".3mf"
    return name


def find_slicer():
    """True when Anycubic Slicer Next is installed."""
    return os.path.isdir(SLICER_APP_PATH)


def launch_slicer(path):
    """Open the file in Anycubic Slicer Next without waiting."""
    subprocess.Popen(
        ["open", "-a", SLICER_APP_NAME, path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


class TransferState:
    def __init__(self):
        self.transfers = {}

    def handle_begin(self, msg):
        transfer_id = str(msg.get("transfer_id") or "")
        if not transfer_id or len(transfer_id) > 64:
            return error("bad-transfer-id")
        try:
            total_bytes = int(msg.get("total_bytes", 0))
            total_chunks = int(msg.get("total_chunks", 0))
        except (TypeError, ValueError):
            return error("bad-size")
        if total_bytes <= 0 or total_bytes > MAX_TOTAL_BYTES:
            return error("bad-size")
        if total_chunks <= 0 or total_chunks > MAX_TOTAL_BYTES // 1024:
            return error("bad-size")
        filename = sanitize_filename(msg.get("filename"))
        self.transfers[transfer_id] = {
            "filename": filename,
            "total_bytes": total_bytes,
            "total_chunks": total_chunks,
            "chunks": {},
            "received_bytes": 0,
        }
        return {"protocol": PROTOCOL_VERSION, "ok": True}

    def handle_chunk(self, msg):
        transfer_id = str(msg.get("transfer_id") or "")
        transfer = self.transfers.get(transfer_id)
        if transfer is None:
            return error("unknown-transfer")
        try:
            index = int(msg.get("index", -1))
        except (TypeError, ValueError):
            return error("bad-index")
        if index < 0 or index >= transfer["total_chunks"]:
            return error("bad-index")
        if index in transfer["chunks"]:
            return error("duplicate-chunk")
        try:
            raw = base64.b64decode(str(msg.get("data_b64") or ""), validate=True)
        except (ValueError, TypeError):
            return error("bad-chunk-data")
        if len(raw) == 0 or len(raw) > MAX_CHUNK_BYTES:
            return error("bad-chunk-data")
        if transfer["received_bytes"] + len(raw) > transfer["total_bytes"]:
            return error("size-exceeded")
        transfer["chunks"][index] = raw
        transfer["received_bytes"] += len(raw)
        return {
            "protocol": PROTOCOL_VERSION,
            "ok": True,
            "received": len(transfer["chunks"]),
        }

    def handle_commit(self, msg):
        transfer_id = str(msg.get("transfer_id") or "")
        transfer = self.transfers.get(transfer_id)
        if transfer is None:
            return error("unknown-transfer")
        if len(transfer["chunks"]) != transfer["total_chunks"]:
            return error(
                "incomplete-transfer",
                received=len(transfer["chunks"]),
                expected=transfer["total_chunks"],
            )
        data = b"".join(
            transfer["chunks"][i] for i in range(transfer["total_chunks"])
        )
        if len(data) != transfer["total_bytes"]:
            return error(
                "size-mismatch",
                received=len(data),
                expected=transfer["total_bytes"],
            )
        del self.transfers[transfer_id]
        tmp = tempfile.NamedTemporaryFile(
            delete=False, suffix=".3mf", prefix="ks1-"
        )
        try:
            tmp.write(data)
            tmp.close()
        except OSError as exc:
            return error("write-failed", detail=str(exc))
        if os.environ.get("KS1_DRY_RUN") == "1":
            return {
                "protocol": PROTOCOL_VERSION,
                "ok": True,
                "dry_run": True,
                "path": tmp.name,
            }
        if not find_slicer():
            return error("slicer-not-found", path=tmp.name)
        try:
            launch_slicer(tmp.name)
        except OSError as exc:
            return error("launch-failed", detail=str(exc), path=tmp.name)
        return {"protocol": PROTOCOL_VERSION, "ok": True, "path": tmp.name}

    def handle_abort(self, msg):
        transfer_id = str(msg.get("transfer_id") or "")
        self.transfers.pop(transfer_id, None)
        return {"protocol": PROTOCOL_VERSION, "ok": True}


def handle_message(state, msg):
    if not isinstance(msg, dict) or msg.get("protocol") != PROTOCOL_VERSION:
        return error("bad-protocol")
    action = msg.get("action")
    if action == "ping":
        return {
            "protocol": PROTOCOL_VERSION,
            "ok": True,
            "host": HOST_NAME,
            "version": HOST_VERSION,
            "slicer_found": find_slicer(),
        }
    if action == "open-begin":
        return state.handle_begin(msg)
    if action == "open-chunk":
        return state.handle_chunk(msg)
    if action == "open-commit":
        return state.handle_commit(msg)
    if action == "open-abort":
        return state.handle_abort(msg)
    return error("unknown-action")


def main():
    state = TransferState()
    while True:
        try:
            msg = read_message()
        except ValueError as exc:
            write_message(error("framing-error", detail=str(exc)))
            break
        if msg is None:
            break
        try:
            write_message(handle_message(state, msg))
        except BrokenPipeError:
            break


if __name__ == "__main__":
    main()
