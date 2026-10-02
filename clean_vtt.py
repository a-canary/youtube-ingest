#!/usr/bin/env python3
"""Dedupe YouTube auto-caption VTT into '[MM:SS] text' lines."""
import re
import sys

out, last = [], ""
ts = "0:00"
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    m = re.match(r"(\d+):(\d\d):(\d\d)\.\d+ -->", line)
    if m:
        h, mn, s = map(int, m.groups())
        ts = f"{h * 60 + mn}:{s:02d}"
        continue
    if not line or line.startswith(("WEBVTT", "Kind:", "Language:")):
        continue
    text = re.sub(r"<[^>]+>", "", line).strip()
    # rolling captions repeat the previous line before adding the next
    if text and text != last:
        out.append(f"[{ts}] {text}")
        last = text
print("\n".join(out))
