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


def hostile_checks():
    """Bound the two things an uploaded plan can do to the browser.

    Both livemap pages run closure on user-supplied JSON. Before this was
    bounded, 50 disconnected walls took 1.3 s and 100 took 21.5 s - roughly
    n^4 - so a 5 MB upload froze the tab outright. A wall count alone does not
    bound it either: cost depends on how DISCONNECTED a plan is, which is why
    there is a wall-clock budget as well as a ceiling.
    """
    import random
    import time as _time
    from plan_ops import (close_wall_gaps, CLOSURE_BUDGET_S,
                          MAX_WALLS_FOR_CLOSURE)

    failures = 0
    rnd = random.Random(1)

    def disconnected(n):
        return {"walls": [{"id": "w%d" % i,
                           "start": {"x": rnd.uniform(0, 4000), "y": rnd.uniform(0, 4000)},
                           "end": {"x": rnd.uniform(0, 4000), "y": rnd.uniform(0, 4000)},
                           "thickness": 20.0, "height": 2.7} for i in range(n)]}

    # A pathological plan must return, not hang. The ceiling is generous
    # against the budget because indexing and the final report sit outside it.
    ceiling = CLOSURE_BUDGET_S * 4
    for n in (500, MAX_WALLS_FOR_CLOSURE):
        d = disconnected(n)
        t0 = _time.time()
        close_wall_gaps(d)
        el = _time.time() - t0
        ok = el <= ceiling
        failures += 0 if ok else 1
        print("%s %d disconnected walls closed in %.2fs (ceiling %.1fs)"
              % ("PASS" if ok else "FAIL", n, el, ceiling))

    # Over the ceiling: refused outright, and it must say so.
    d = disconnected(MAX_WALLS_FOR_CLOSURE + 1)
    close_wall_gaps(d)
    ok = d["gap_fill"]["enabled"] is False and d["gap_fill"]["skipped"]
    failures += 0 if ok else 1
    print("%s %d walls refused: %s" % ("PASS" if ok else "FAIL", MAX_WALLS_FOR_CLOSURE + 1,
                                       (d["gap_fill"]["skipped"] or ["(no reason given)"])[0]))

    # JSON has no NaN literal, but 1e400 parses to inf. A non-finite or
    # non-positive wall must be dropped, not silently poison every comparison.
    poisoned = {"walls": [
        {"id": "inf", "start": {"x": float("inf"), "y": 0}, "end": {"x": 1, "y": 1},
         "thickness": 10},
        {"id": "neg", "start": {"x": 0, "y": 50}, "end": {"x": 100, "y": 50},
         "thickness": -5},
        {"id": "ok1", "start": {"x": 0, "y": 0}, "end": {"x": 100, "y": 0},
         "thickness": 10},
        {"id": "ok2", "start": {"x": 0, "y": 90}, "end": {"x": 100, "y": 90},
         "thickness": 10},
    ]}
    close_wall_gaps(poisoned)
    note = " ".join(poisoned["gap_fill"]["skipped"])
    ok = "2 wall(s) dropped" in note
    failures += 0 if ok else 1
    print("%s non-finite and non-positive walls dropped" % ("PASS" if ok else "FAIL"))

    return failures


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

    failures += hostile_checks()

    # The Kaggle cell is the third copy of this code and the one nobody looks
    # at, so check it here rather than leaving it to rot again.
    gen = subprocess.run([sys.executable,
                          os.path.join(ROOT, "deliverables", "make_notebook_cell.py"),
                          "--check"], capture_output=True, text=True)
    print(gen.stdout.strip() or gen.stderr.strip())
    return 1 if (failures or gen.returncode) else 0


if __name__ == "__main__":
    sys.exit(main())
