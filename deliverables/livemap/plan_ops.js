/* Shared plan preparation for both browser views.
 *
 * PORT of deliverables/plan_ops.py. Python is the reference implementation -
 * the GLB builder calls it, and the GLB is the artifact people are actually
 * handed. This copy exists only because the browser fetches plan JSON directly
 * and cannot import Python. local/test_plan_ops_parity.py runs both over every
 * file in plans/ and fails if they disagree, so the two cannot drift silently.
 *
 * Loaded as a classic script before each page's own script, so index.html
 * (classic) and ar.html (module) can both reach window.PlanOps.
 */
(function (global) {
  "use strict";

  var DEFAULT_HEIGHT_M = 2.7;

  // All tolerances are multiples of the median wall thickness (tMed), so the
  // same numbers hold at any raster resolution - the same convention the
  // segmentation pipeline uses for its own tolerances.
  var SNAP_T_MED_FRAC = 0.5;     // endpoints this close are already the same node
  var JOIN_T_MED_FRAC = 3.0;     // corner / jog / T-junction closure range
  var ONLINE_T_MED_FRAC = 1.0;   // a fixture this close counts as "on" a line

  // Beyond this a dangling endpoint has nothing to connect to. A real limit,
  // not just a performance guard: the widest gap any of this project's plans
  // legitimately closes is 599.9 px at t_med 20, i.e. 30x, and only because
  // two windows sit on the line.
  var SEARCH_T_MED_FRAC = 40.0;

  // This page accepts UPLOADED plan JSON, so these two are the only thing
  // between a hostile file and a frozen tab. The count alone is not enough -
  // cost depends on how DISCONNECTED a plan is, not how big: 244 real walls
  // finish in milliseconds because almost nothing dangles, while 2000
  // deliberately disconnected segments ran for 42 s before this was bounded.
  var MAX_WALLS_FOR_CLOSURE = 5000;
  var CLOSURE_BUDGET_MS = 2000;

  // Minimal binary heap; the closure pops gaps shortest-first and there is no
  // built-in priority queue. Entries are [d, wallIndex, keyNum, targetIndex, q]
  // and compare in that order, which is the order the original exhaustive scan
  // happened to visit in - so results are unchanged.
  function heapLess(a, b) {
    for (var k = 0; k < 4; k++) { if (a[k] !== b[k]) return a[k] < b[k]; }
    return false;
  }
  function heapPush(h, v) {
    h.push(v);
    var i = h.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (!heapLess(h[i], h[p])) break;
      var t = h[i]; h[i] = h[p]; h[p] = t; i = p;
    }
  }
  function heapPop(h) {
    var top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < h.length && heapLess(h[l], h[m])) m = l;
        if (r < h.length && heapLess(h[r], h[m])) m = r;
        if (m === i) break;
        var t = h[i]; h[i] = h[m]; h[m] = t; i = m;
      }
    }
    return top;
  }

  // -----------------------------------------------------------------------
  // schema normalisation
  // -----------------------------------------------------------------------
  // Three coordinate conventions exist across this project's own files, so the
  // loader normalises rather than rejecting two of them:
  //
  //   schema 1.0  "start": [x, y]  + thickness_px          (mitunet_geometry.json,
  //                                                         out-cubicasa/sample_geometry.json
  //                                                         - the pipeline itself reads
  //                                                         this form via np.array(w["start"]))
  //   forked      "start": {x, y}  + thickness in METRES   (sample_response.json)
  //   schema 2.0  "start": {x, y}  + thickness in px       (our export)
  //
  // Everything downstream expects {x, y} objects and a px thickness, so convert
  // once here. Where a file states its own conversion
  // (metadata.pixel_to_meter_ratio) metre thicknesses are converted with it.
  // That is verified exact against this project's own pair: every wall in
  // sample_response.json (metres) equals mitunet_geometry.json's thickness_px
  // when divided by that ratio of 0.01. Without a stated ratio the value is
  // left alone and simply draws thin - guessing a scale would invent geometry,
  // and note the OTHER scale field, scale.pixels_per_meter, is marked
  // "assumed_default" with confidence 0.0.
  //
  // Idempotent, via the "_plan_ops_normalized" marker. It has to be: the
  // metre->px division is destructive, so a second pass over an already
  // converted plan turns a 0.10 m wall into 1000 px instead of 10. The upload
  // path below normalises once to validate and once more inside applyPlan,
  // and hit exactly that.
  function normalizePlan(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.walls)) return data;
    if (data._plan_ops_normalized) return data;
    var ratio = Number(data.metadata && data.metadata.pixel_to_meter_ratio) || 0;
    var pt = function (v) {
      return Array.isArray(v) && v.length >= 2 ? { x: +v[0], y: +v[1] } : v;
    };
    data.walls = data.walls.map(function (w) {
      if (!w || typeof w !== "object") return w;
      var out = Object.assign({}, w, { start: pt(w.start), end: pt(w.end) });
      if (typeof out.thickness !== "number") {
        if (typeof w.thickness_px === "number") out.thickness = w.thickness_px;
      } else if (ratio > 0) {
        out.thickness = out.thickness / ratio;          // metres -> px
      }
      if (typeof out.height !== "number") {
        // schema 1.0 spells it height_m; both are real-world metres
        out.height = typeof w.height_m === "number" ? w.height_m : DEFAULT_HEIGHT_M;
      }
      return out;
    });
    if (Array.isArray(data.rooms)) {
      data.rooms = data.rooms.map(function (r) {
        return r && Array.isArray(r.polygon)
          ? Object.assign({}, r, { polygon: r.polygon.map(pt) }) : r;
      });
    }
    data._plan_ops_normalized = true;
    return data;
  }

  // -----------------------------------------------------------------------
  // geometry helpers
  // -----------------------------------------------------------------------
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  // Closest point on segment ab to p, plus that distance. Clamping the
  // projection parameter to [0, 1] is what makes this a segment rather than an
  // infinite line; without it a dangling end would "connect" to a wall's
  // imaginary extension.
  function nearestOnSegment(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    if (l2 === 0) return { q: a, d: dist(p, a) };
    var t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    var q = [a[0] + t * dx, a[1] + t * dy];
    return { q: q, d: dist(p, q) };
  }

  // -----------------------------------------------------------------------
  // wall-gap closure
  // -----------------------------------------------------------------------
  // Line-first detectors (newri's Hough + merge_walls pipeline, and anything
  // else that emits independent segments) produce walls that look tidy in 2D
  // but do not meet: a wall runs down x=645.4, stops at y=340, and the next
  // starts at x=607, y=373. Extruded to 3D that reads as the wall teleporting
  // sideways and back, and the model has no enclosed interior.
  //
  // Three rules decide each gap, and they exist to stop this from inventing
  // geometry the plan gives no evidence for:
  //
  //   junction  gap <= JOIN (3x tMed) -> fill. A corner, jog or T-junction the
  //             detector clipped; the surrounding geometry implies it.
  //   doorway   a DOOR fixture lies on the gap -> leave open. That hole is a
  //             real opening, not a detector miss, and in AR you have to be
  //             able to walk through it.
  //   span      a longer gap fills ONLY if a WINDOW fixture sits on the line.
  //             A window cannot float in mid-air, so the plan's own fixtures
  //             are evidence a wall belongs there. No evidence, no wall.
  //
  // Our own rooms-first pipeline output is already closed by construction (2
  // dangling endpoints out of 488), so this is a repair pass for foreign or
  // upstream plans rather than a fix for our own.
  function closeWallGaps(data, enabled) {
    if (enabled === undefined) enabled = true;
    var walls = (data && data.walls) || [];
    // already closed; re-running would duplicate fill ids
    if (walls.some(function (w) { return w && w.generated; })) return data;
    data.gapFill = { added: [], skipped: [], enabled: enabled };
    if (!enabled || walls.length < 2) return data;

    if (walls.length > MAX_WALLS_FOR_CLOSURE) {
      data.gapFill = { added: [], enabled: false, skipped: [
        walls.length + " walls exceeds MAX_WALLS_FOR_CLOSURE=" +
        MAX_WALLS_FOR_CLOSURE + "; closure skipped"] };
      return data;
    }

    // Sanitation, not decoration. JSON has no NaN literal but 1e400 parses to
    // Infinity, and Infinity/NaN coordinates poison every comparison below:
    // NaN fails every < test silently, so a poisoned wall is never "nearest"
    // but is also never rejected, and an Infinity endpoint makes the spatial
    // grid try to enumerate an unbounded number of cells. Drop those walls.
    var seg = [];
    var dropped = 0;
    walls.forEach(function (w, i) {
      if (!w || typeof w !== "object" || !w.start || !w.end) return;
      var s = [+w.start.x, +w.start.y];
      var e = [+w.end.x, +w.end.y];
      var t = Number(w.thickness) || 4;
      var h = Number(w.height) || DEFAULT_HEIGHT_M;
      if (!isFinite(s[0]) || !isFinite(s[1]) || !isFinite(e[0]) || !isFinite(e[1]) ||
          !isFinite(t) || !isFinite(h) || t <= 0) { dropped++; return; }
      seg.push({ id: w.id || ("w" + i), s: s, e: e, t: t, h: h });
    });
    if (seg.length < 2) {
      if (dropped) {
        data.gapFill.skipped.push(
          dropped + " wall(s) dropped: non-finite or non-positive values");
      }
      return data;
    }

    var ts = seg.map(function (w) { return w.t; }).sort(function (a, b) { return a - b; });
    var tMed = ts[ts.length >> 1] || 4;
    var snap = SNAP_T_MED_FRAC * tMed;
    var join = JOIN_T_MED_FRAC * tMed;
    var online = ONLINE_T_MED_FRAC * tMed;

    var fixtures = (data.fixtures || []).filter(function (f) {
      return f && f.position && typeof f.position.x === "number";
    });
    function fixturesOn(p, q, kind) {
      return fixtures.filter(function (f) {
        return f.type === kind &&
          nearestOnSegment([f.position.x, f.position.y], p, q).d <= online;
      }).map(function (f) { return f.id; });
    }

    // Object.create(null), not {}: the keys here are attacker-supplied wall
    // ids from an uploaded file, and a plain object would consult
    // Object.prototype on lookup.
    var done = Object.create(null);
    var searchR = SEARCH_T_MED_FRAC * tMed;

    // Uniform grid over segment bounding boxes. The nearest-wall query used to
    // scan every wall, inside a loop that itself re-scanned every endpoint,
    // and the whole thing ran once per fill: measured at 1.3 s for 50
    // disconnected walls and 21.5 s for 100 - roughly n^4. On a page that
    // accepts uploaded plans that is a hostile-file freeze, not a slow path.
    //
    // A wall is registered in every cell its bbox touches, so the cell holding
    // the closest point on it is always registered and a query cannot miss it.
    var cell = Math.max(2 * tMed, 1e-6);
    var grid = new Map();
    function indexSeg(idx) {
      var a = seg[idx].s, b = seg[idx].e;
      var x0 = Math.floor(Math.min(a[0], b[0]) / cell);
      var x1 = Math.floor(Math.max(a[0], b[0]) / cell);
      var y0 = Math.floor(Math.min(a[1], b[1]) / cell);
      var y1 = Math.floor(Math.max(a[1], b[1]) / cell);
      for (var cx = x0; cx <= x1; cx++) {
        for (var cy = y0; cy <= y1; cy++) {
          var k = cx + ":" + cy;
          var bucket = grid.get(k);
          if (bucket) bucket.push(idx); else grid.set(k, [idx]);
        }
      }
    }
    for (var gi = 0; gi < seg.length; gi++) indexSeg(gi);

    function near(p, radius) {
      var out = new Set();
      var x0 = Math.floor((p[0] - radius) / cell), x1 = Math.floor((p[0] + radius) / cell);
      var y0 = Math.floor((p[1] - radius) / cell), y1 = Math.floor((p[1] + radius) / cell);
      for (var cx = x0; cx <= x1; cx++) {
        for (var cy = y0; cy <= y1; cy++) {
          var bucket = grid.get(cx + ":" + cy);
          if (bucket) for (var n = 0; n < bucket.length; n++) out.add(bucket[n]);
        }
      }
      return out;
    }

    function isJoined(i, p) {
      var hits = near(p, snap);
      var it = hits.values(), r;
      while (!(r = it.next()).done) {
        var j = r.value;
        if (j !== i && nearestOnSegment(p, seg[j].s, seg[j].e).d <= snap) return true;
      }
      return false;
    }

    // Nearest connectable wall to seg[i][key], or null. The radius grows from
    // `join` outward: most endpoints resolve against a corner one wall
    // thickness away, and only the genuinely isolated ones pay for the wide
    // search. A hit at radius r is only PROVABLY nearest if it lies within r,
    // since a wall whose bbox reaches into the box while its body stays far
    // away can be returned at a distance greater than r.
    function candidate(i, key) {
      var a = seg[i], p = a[key], radius = join;
      for (;;) {
        var best = null;
        var idx = Array.from(near(p, radius)).sort(function (x, y) { return x - y; });
        for (var n = 0; n < idx.length; n++) {
          var j = idx[n];
          if (j === i) continue;
          var b = seg[j];
          // sharing a node already: joining again just overlays wall a
          if (Math.min(dist(a.s, b.s), dist(a.s, b.e),
                       dist(a.e, b.s), dist(a.e, b.e)) <= snap) continue;
          var hit = nearestOnSegment(p, b.s, b.e);
          var q = hit.q, d = hit.d;
          var ends = [b.s, b.e];
          for (var m = 0; m < 2; m++) {
            // a target within join range of b's own end IS that corner
            if (dist(q, ends[m]) <= join) { q = ends[m]; d = dist(p, ends[m]); break; }
          }
          if (!best || d < best.d) best = { d: d, j: j, q: q };
        }
        if (best && best.d <= radius) return best;
        if (radius >= searchR) return best;   // widest scan done
        radius = Math.min(radius * 2, searchR);
      }
    }

    var heap = [];
    function push(i, key) {
      if (done[seg[i].id + key]) return;
      var c = candidate(i, key);
      if (c) heapPush(heap, [c.d, i, key === "s" ? 0 : 1, c.j, c.q]);
    }

    // The deadline starts HERE, not at the loop. Seeding costs one
    // nearest-wall search per endpoint, and on a plan where nothing is
    // connected every one widens all the way to searchR - 5000 disconnected
    // walls spent 46 s in this loop alone, before the first pop.
    var deadline = Date.now() + CLOSURE_BUDGET_MS;
    var timedOut = false;
    for (var si = 0; si < seg.length; si++) {
      if ((si & 0x3f) === 0 && Date.now() > deadline) { timedOut = true; break; }
      push(si, "s");
      push(si, "e");
    }

    var added = [], skipped = [];
    // Two separate limits. `decisions` counts endpoints actually resolved.
    // `pops` bounds queue churn - stale and already-resolved entries get
    // popped and discarded, and counting those against the decision budget
    // silently starved the long-gap endpoints.
    var decisions = 4 * seg.length;
    var pops = 64 * seg.length + 1000;
    while (heap.length && decisions > 0 && pops > 0 && !timedOut) {
      pops--;
      if ((pops & 0x3f) === 0 && Date.now() > deadline) { timedOut = true; break; }
      var top = heapPop(heap);
      var d = top[0], i = top[1], keyn = top[2], j = top[3], q = top[4];
      var key = keyn === 0 ? "s" : "e";
      var a = seg[i], p = a[key];
      if (done[a.id + key]) continue;
      if (isJoined(i, p)) { done[a.id + key] = true; continue; }
      var fresh = candidate(i, key);
      if (!fresh) { done[a.id + key] = true; continue; }
      if (Math.abs(fresh.d - d) > 1e-9 || fresh.j !== j) {
        // a later insertion changed this endpoint's nearest wall
        heapPush(heap, [fresh.d, i, keyn, fresh.j, fresh.q]);
        continue;
      }
      var b = seg[j];
      done[a.id + key] = true;
      decisions--;

      // The connector turns exactly one corner (both walls are axis-aligned).
      // Reject the corner whose first leg runs back along wall a over itself;
      // keep the one that leaves a's far end.
      var far = key === "s" ? a.e : a.s;
      var opts = [[p[0], q[1]], [q[0], p[1]]].filter(function (c) {
        return dist(far, c) >= dist(far, p) - 1e-6;
      });
      var doors = fixturesOn(p, q, "door");
      var windows = fixturesOn(p, q, "window");

      var why = null;
      if (!opts.length) why = "corner backtracks";
      else if (doors.length) why = "doorway " + doors.join(",");
      else if (d > join && !windows.length) why = "no fixture evidence";
      if (why) {
        skipped.push(a.id + "." + key + "->" + b.id + " " + d.toFixed(1) + "px: " + why);
        continue;
      }

      var c = opts.reduce(function (best, x) {
        return dist(p, x) + dist(x, q) < dist(p, best) + dist(best, q) ? x : best;
      });
      var thickness = Math.min(a.t, b.t);
      var reason = d <= join ? "junction" : "span/fixture";
      var legs = [[p, c], [c, q]];
      for (var n = 0; n < 2; n++) {
        var u = legs[n][0], v = legs[n][1];
        if (dist(u, v) <= snap) continue;
        var wid = "fill_" + String(added.length + 1).padStart(3, "0");
        walls.push({
          id: wid,
          start: { x: u[0], y: u[1] },
          end: { x: v[0], y: v[1] },
          thickness: thickness,
          height: a.h,
          generated: true,
          reason: reason,
        });
        seg.push({ id: wid, s: u, e: v, t: thickness, h: a.h });
        indexSeg(seg.length - 1);
        added.push(wid + " " + a.id + "->" + b.id + " " +
                   dist(u, v).toFixed(1) + "px [" + reason + "]");
        // This connector may now be the nearest wall to some other dangling
        // endpoint, so anything near it needs re-queuing.
        var touched = near(u, searchR);
        near(v, searchR).forEach(function (k) { touched.add(k); });
        touched.forEach(function (k) {
          if (k < seg.length) { push(k, "s"); push(k, "e"); }
        });
      }
    }

    if (timedOut) {
      skipped.push("closure stopped after " + (CLOSURE_BUDGET_MS / 1000).toFixed(1) +
                   "s (CLOSURE_BUDGET_MS); remaining gaps left open");
    }
    if (dropped) {
      skipped.push(dropped + " wall(s) dropped: non-finite or non-positive values");
    }
    data.gapFill = { added: added, skipped: skipped, enabled: true,
                     tMed: tMed, join: join };
    return data;
  }

  // normalizePlan + closeWallGaps. What every consumer should call.
  function preparePlan(data, opts) {
    opts = opts || {};
    var closeGaps = opts.closeGaps !== false;
    var out = closeWallGaps(normalizePlan(data), closeGaps);
    var rep = out.gapFill || {};
    if (rep.enabled) {
      console.info("[plan_ops] gap closure: +" + rep.added.length + " connectors, " +
                   rep.skipped.length + " gaps left open", rep);
    }
    return out;
  }

  global.PlanOps = { normalizePlan: normalizePlan, closeWallGaps: closeWallGaps,
                     preparePlan: preparePlan,
                     MAX_WALLS_FOR_CLOSURE: MAX_WALLS_FOR_CLOSURE };
})(typeof window !== "undefined" ? window : globalThis);
