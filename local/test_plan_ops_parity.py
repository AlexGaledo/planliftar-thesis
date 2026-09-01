#!/usr/bin/env python3
"""Assert the JavaScript gap-closure in ar.html matches deliverables/plan_ops.py.

The browser fetches plan JSON directly and cannot import Python, so the WebXR
view carries a hand-kept port of normalize_plan/close_wall_gaps. Two copies of
a geometry algorithm drift silently: the AR view would quietly stop agreeing
with the GLB you hand people, and nothing would fail. This test makes that
drift loud.

Python is the reference implementation. If this fails, fix the JavaScript.

Requires node on PATH; skips (exit 0, loudly) if it is missing, so it never
blocks a machine that only has Python.

    python local/test_plan_ops_parity.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "deliverables"))
from plan_ops import prepare_plan  # noqa: E402

AR_HTML = os.path.join(ROOT, "deliverables", "livemap", "ar.html")
PLANS_DIR = os.path.join(ROOT, "deliverables", "livemap", "plans")

# Pulls the two functions out of ar.html's <script type="module"> block by name
# and runs them on one plan file, emitting the same summary the Python side
# builds. ar.html is CRLF, but the "\nfunction " terminator still matches
# inside a CRLF pair, so no line-ending normalisation is needed.
NODE_HARNESS = r"""
const fs = require("fs");
// argv: [node, harness.js, ar.html, plan.json]
const html = fs.readFileSync(process.argv[2], "utf8");
function grab(name) {
  const i = html.indexOf("function " + name + "(");
  if (i < 0) throw new Error("not found in ar.html: " + name);
  const j = html.indexOf("\nfunction ", i + 1);
  return html.slice(i, j > 0 ? j : html.length);
}
const api = new Function(
  grab("normalizePlan") + "\n" + grab("closeWallGaps") +
  "; return { normalizePlan, closeWallGaps };"
)();
console.info = () => {};   // the browser-facing log is noise here
const plan = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const out = api.closeWallGaps(api.normalizePlan(plan));
process.stdout.write(JSON.stringify({
  walls: out.walls.length,
  generated: (out.walls || []).filter((w) => w.generated).map((w) => [
    w.id, +w.start.x.toFixed(4), +w.start.y.toFixed(4),
    +w.end.x.toFixed(4), +w.end.y.toFixed(4), +w.thickness.toFixed(4), w.reason,
  ]),
  skipped: (out.gapFill || {}).skipped || [],
}));
"""


def python_side(path):
    with open(path, encoding="utf-8") as fh:
        data = prepare_plan(json.load(fh), verbose=False)
    return {
        "walls": len(data["walls"]),
        "generated": [[w["id"], round(w["start"]["x"], 4), round(w["start"]["y"], 4),
                       round(w["end"]["x"], 4), round(w["end"]["y"], 4),
                       round(w["thickness"], 4), w["reason"]]
                      for w in data["walls"] if w.get("generated")],
        "skipped": data["gap_fill"]["skipped"],
    }


def js_side(path, harness):
    out = subprocess.run(["node", harness, AR_HTML, path],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError("node failed: " + out.stderr.strip())
    return json.loads(out.stdout)


def main():
    if shutil.which("node") is None:
        print("SKIP: node is not on PATH, cannot check the JavaScript port")
        return 0

    plans = sorted(f for f in os.listdir(PLANS_DIR) if f.endswith(".json"))
    if not plans:
        print("FAIL: no plans found in " + PLANS_DIR)
        return 1

    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        harness = os.path.join(tmp, "harness.js")
        with open(harness, "w", encoding="utf-8") as fh:
            fh.write(NODE_HARNESS)

        for name in plans:
            path = os.path.join(PLANS_DIR, name)
            py, js = python_side(path), js_side(path, harness)
            if py == js:
                print("PASS %-28s %3d walls, %d generated, %d left open"
                      % (name, py["walls"], len(py["generated"]), len(py["skipped"])))
                continue
            failures += 1
            print("FAIL %s" % name)
            for key in ("walls", "generated", "skipped"):
                if py[key] != js[key]:
                    print("  %s:\n    py: %r\n    js: %r" % (key, py[key], js[key]))

    print("\n%d/%d plans in parity" % (len(plans) - failures, len(plans)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
