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

    var seg = [];
    walls.forEach(function (w, i) {
      if (!w || !w.start || !w.end) return;
      seg.push({
        id: w.id || ("w" + i),
        s: [+w.start.x, +w.start.y],
        e: [+w.end.x, +w.end.y],
        t: Number(w.thickness) || 4,
        h: Number(w.height) || DEFAULT_HEIGHT_M,
      });
    });
    if (seg.length < 2) return data;

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

    var done = {};
    function bestGap() {
      var best = null;
      for (var i = 0; i < seg.length; i++) {
        var keys = ["s", "e"];
        for (var k = 0; k < 2; k++) {
          var key = keys[k], a = seg[i], p = a[key];
          if (done[a.id + key]) continue;
          // already joined: some other wall's BODY passes within snap
          var joined = seg.some(function (b, j) {
            return j !== i && nearestOnSegment(p, b.s, b.e).d <= snap;
          });
          if (joined) continue;
          for (var j = 0; j < seg.length; j++) {
            var b = seg[j];
            if (j === i) continue;
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
            if (!best || d < best.d) best = { d: d, i: i, key: key, j: j, q: q };
          }
        }
      }
      return best;
    }

    var added = [], skipped = [];
    for (var guard = 0; guard < 4 * seg.length; guard++) {
      var g = bestGap();
      if (!g) break;
      var a = seg[g.i], b = seg[g.j], p = a[g.key], q = g.q;
      done[a.id + g.key] = true;

      // The connector turns exactly one corner (both walls are axis-aligned).
      // Reject the corner whose first leg runs back along wall a over itself;
      // keep the one that leaves a's far end.
      var far = g.key === "s" ? a.e : a.s;
      var opts = [[p[0], q[1]], [q[0], p[1]]].filter(function (c) {
        return dist(far, c) >= dist(far, p) - 1e-6;
      });
      var doors = fixturesOn(p, q, "door");
      var windows = fixturesOn(p, q, "window");

      var why = null;
      if (!opts.length) why = "corner backtracks";
      else if (doors.length) why = "doorway " + doors.join(",");
      else if (g.d > join && !windows.length) why = "no fixture evidence";
      if (why) {
        skipped.push(a.id + "." + g.key + "->" + b.id + " " + g.d.toFixed(1) + "px: " + why);
        continue;
      }

      var c = opts.reduce(function (best, x) {
        return dist(p, x) + dist(x, q) < dist(p, best) + dist(best, q) ? x : best;
      });
      var thickness = Math.min(a.t, b.t);
      var reason = g.d <= join ? "junction" : "span/fixture";
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
        added.push(wid + " " + a.id + "->" + b.id + " " +
                   dist(u, v).toFixed(1) + "px [" + reason + "]");
      }
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
                     preparePlan: preparePlan };
})(typeof window !== "undefined" ? window : globalThis);
