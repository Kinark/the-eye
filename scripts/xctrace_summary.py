#!/usr/bin/env python3
"""Export an Instruments trace into a compact JSON timeline the-eye can align with screen frames.

usage: xctrace_summary.py <trace> <out.json>

Output:
  start_wall  unix seconds when the trace started (ms precision, from the TOC)
  frames      interned stack frames: [[name, binary], ...]
  samples     main-thread Time Profiler samples: [[t_wall, [frame_idx leaf→root ...]], ...]
  hitches     [[t_wall, dur_ms, description], ...]
Only main-thread samples are kept. The trace's environment block (which can hold secrets) is never copied.
"""
import json, subprocess, sys, xml.etree.ElementTree as ET
from datetime import datetime

trace, out = sys.argv[1], sys.argv[2]

def export(args):
    return subprocess.run(["xcrun", "xctrace", "export", "--input", trace, *args], capture_output=True, check=True).stdout

toc = ET.fromstring(export(["--toc"]))
sd = toc.find(".//start-date")
start_wall = datetime.fromisoformat(sd.text.strip()).timestamp() if sd is not None else 0.0
schemas = {t.get("schema") for t in toc.iter("table")}

def rows(schema):
    data = export(["--xpath", f'/trace-toc/run[@number="1"]/data/table[@schema="{schema}"]'])
    # Elements are interned: first occurrence carries id=…, later ones ref=…
    return ET.fromstring(data).iter("row")

frames, frame_idx = [], {}
def intern(name, binary):
    k = (name, binary)
    if k not in frame_idx:
        frame_idx[k] = len(frames); frames.append([name, binary])
    return frame_idx[k]

samples, hitches = [], []
if "time-profile" in schemas:
    by_id = {}  # id -> resolved value (thread fmt, frame idx, backtrace list, binary name, time)
    def resolve(el):
        if el is None: return None
        r = el.get("ref")
        if r is not None: return by_id.get(r)
        tag = el.tag
        if tag == "binary": v = el.get("name", "?")
        elif tag == "frame":
            b = el.find("binary")
            v = intern(el.get("name", "?"), resolve(b) if b is not None else "?")
        elif tag in ("backtrace", "tagged-backtrace"):
            inner = el.find("backtrace")
            v = resolve(inner) if (tag == "tagged-backtrace" and inner is not None) else [resolve(f) for f in el.findall("frame")]
        elif tag == "thread": v = el.get("fmt", "")
        else: v = el.text
        if el.get("id") is not None: by_id[el.get("id")] = v
        return v
    for row in rows("time-profile"):
        t = resolve(row.find("sample-time"))
        thread = resolve(row.find("thread")) or ""
        bt = row.find("tagged-backtrace")
        if bt is None: bt = row.find("backtrace")
        stack = resolve(bt) or []
        # Resolve every child so later refs work, but keep only the main thread.
        for c in row: resolve(c)
        if t is None or not str(thread).startswith("Main Thread"): continue
        samples.append([round(start_wall + int(t) / 1e9, 6), [s for s in stack if s is not None][:40]])

if "hitches" in schemas:
    by_id = {}
    for row in rows("hitches"):
        vals = {}
        for c in row:
            r = c.get("ref")
            v = by_id.get(r) if r is not None else (c.text or c.get("fmt", ""))
            if c.get("id") is not None and r is None: by_id[c.get("id")] = v
            vals.setdefault(c.tag, []).append(v)
        try:
            st = int(vals["start-time"][0]); du = int(vals["duration"][0])
        except (KeyError, ValueError, TypeError):
            continue
        desc = [s for s in vals.get("string", []) if s and not str(s).startswith("0x")]
        hitches.append([round(start_wall + st / 1e9, 6), round(du / 1e6, 2), desc[0] if desc else ""])

json.dump({"start_wall": start_wall, "frames": frames, "samples": samples, "hitches": hitches}, open(out, "w"))
print(json.dumps({"start_wall": start_wall, "main_thread_samples": len(samples), "unique_frames": len(frames), "hitches": len(hitches)}))
