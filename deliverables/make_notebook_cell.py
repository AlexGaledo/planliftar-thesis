#!/usr/bin/env python3
"""Regenerate deliverables/cell11_glb.py from plan_ops.py + glb_builder.py.

The Kaggle notebook cannot import a file from this repo, so the GLB cell has to
be self-contained - which is why cell11_glb.py existed as a byte-for-byte
duplicate of glb_builder.py, and why it silently fell a version behind the
moment gap closure landed. Generating it instead makes that impossible: the
concatenation is mechanical, and --check fails if the committed file is stale.

    python deliverables/make_notebook_cell.py            # write
    python deliverables/make_notebook_cell.py --check    # verify, exit 1 if stale
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "cell11_glb.py")

HEADER = '''# Cell 11-pre - GLB builder (reviewed deliverable)
# Notebook does: !pip install -q trimesh   (run that in the cell above this one)
#
# GENERATED FILE - do not edit. Regenerate with:
#     python deliverables/make_notebook_cell.py
#
# This is plan_ops.py and glb_builder.py concatenated, because a Kaggle cell
# cannot import from this repo. Edit those two, then regenerate.
'''


def _body(name, drop_prefixes=()):
    """Read a module, strip its docstring, and drop lines starting with the
    given prefixes (used to remove the local import that Kaggle cannot resolve).
    """
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        src = fh.read()
    if src.lstrip().startswith('"""'):
        start = src.index('"""')
        end = src.index('"""', start + 3) + 3
        src = src[end:]
    kept = [ln for ln in src.split("\n")
            if not any(ln.startswith(p) for p in drop_prefixes)]
    return "\n".join(kept).strip("\n")


def render():
    plan_ops = _body("plan_ops.py", drop_prefixes=("from __future__",))
    builder = _body("glb_builder.py",
                    drop_prefixes=("from plan_ops import", "# Cell 11-pre",
                                   "# Notebook does:"))
    # plan_ops.py ends with a __main__ CLI block that makes no sense in a cell
    marker = 'if __name__ == "__main__":'
    if marker in plan_ops:
        plan_ops = plan_ops[:plan_ops.index(marker)].rstrip("\n")
    return HEADER + "\n" + plan_ops + "\n\n\n" + builder + "\n"


def main():
    text = render()
    if "--check" in sys.argv:
        current = ""
        if os.path.exists(TARGET):
            with open(TARGET, encoding="utf-8", newline="") as fh:
                current = fh.read().replace("\r\n", "\n")
        if current != text:
            print("STALE: cell11_glb.py does not match plan_ops.py + glb_builder.py")
            print("       run: python deliverables/make_notebook_cell.py")
            return 1
        print("OK: cell11_glb.py is current")
        return 0
    with open(TARGET, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    print("wrote %s (%d lines)" % (TARGET, text.count("\n")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
