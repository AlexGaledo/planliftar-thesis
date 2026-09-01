#!/usr/bin/env python3
"""Assert livemap/plan_ops.js matches deliverables/plan_ops.py.

The browser fetches plan JSON directly and cannot import Python, so the two
livemap pages share a hand-kept JavaScript port. Two copies of a geometry
algorithm drift silently: the map and the AR view would quietly stop agreeing
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

PLAN_OPS_JS = os.path.join(ROOT, "deliverables", "livemap", "plan_ops.js")
PLANS_DIR = os.path.join(ROOT, "deliverables", "livemap", "plans")

# Evaluates plan_ops.js (a classic script that assigns window.PlanOps, falling
# back to globalThis where there is no window) and runs it over one plan file,
# emitting the same summary the Python side builds.
NODE_HARNESS = r"""
const fs = require("fs");
// argv: [node, harness.js, plan_ops.js, plan.json]
new Function(fs.readFileSync(process.argv[2], "utf8"))();
console.info = () => {};   // the browser-facing log is noise here
const plan = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const out = PlanOps.preparePlan(plan);
process.stdout.write(JSON.stringify({
  walls: out.walls.length,
  generated: (out.walls || []).filter((w) => w.generated).map((w) => [
    w.id, +w.start.x.toFixed(4), +w.start.y.toFixed(4),
    +w.end.x.toFixed(4), +w.end.y.toFixed(4), +w.thickness.toFixed(4), w.reason,
  ]),
  skipped: (out.gapFill || {}).skipped || [],
}));
"""


def summarise(data):
    return {
        "walls": len(data["walls"]),
        "generated": [[w["id"], round(w["start"]["x"], 4), round(w["start"]["y"], 4),
                       round(w["end"]["x"], 4), round(w["end"]["y"], 4),
                       round(w["thickness"], 4), w["reason"]]
                      for w in data["walls"] if w.get("generated")],
        "skipped": data["gap_fill"]["skipped"],
    }


def python_side(path):
    with open(path, encoding="utf-8") as fh:
        return summarise(prepare_plan(json.load(fh), verbose=False))


def python_twice(path):
    """prepare_plan must be idempotent.

    The metre->px division in normalize_plan is destructive, so a second pass
    over an already converted plan turned a 0.10 m wall into 1000 px. The
    livemap upload path called it twice (once to validate, once inside
    applyPlan) and hit exactly that.
    """
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return summarise(prepare_plan(prepare_plan(data, verbose=False), verbose=False))


def js_side(path, harness):
    out = subprocess.run(["node", harness, PLAN_OPS_JS, path],
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
            py, js, twice = python_side(path), js_side(path, harness), python_twice(path)
            if py == js and py == twice:
                print("PASS %-28s %3d walls, %d generated, %d left open"
                      % (name, py["walls"], len(py["generated"]), len(py["skipped"])))
                continue
            failures += 1
            print("FAIL %s" % name)
            for key in ("walls", "generated", "skipped"):
                if py[key] != js[key]:
                    print("  %s (py vs js):\n    py: %r\n    js: %r" % (key, py[key], js[key]))
                if py[key] != twice[key]:
                    print("  %s (not idempotent):\n    once:  %r\n    twice: %r"
                          % (key, py[key], twice[key]))

    print("\n%d/%d plans in parity" % (len(plans) - failures, len(plans)))

    # The Kaggle cell is the third copy of this code and the one nobody looks
    # at, so check it here rather than leaving it to rot again.
    gen = subprocess.run([sys.executable,
                          os.path.join(ROOT, "deliverables", "make_notebook_cell.py"),
                          "--check"], capture_output=True, text=True)
    print(gen.stdout.strip() or gen.stderr.strip())
    return 1 if (failures or gen.returncode) else 0


if __name__ == "__main__":
    sys.exit(main())
