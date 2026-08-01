#!/usr/bin/env python3
"""Derive hand-style manifests from the raw PNG assets.

Everything the hand rig needs is measurable from the alpha channel, so authors
only hand-write identity fields (id, label, tool, handedness). Run:

    python3 scripts/calibrate_hands.py

Writes assets/hands/<id>.json. See the plan's "Hand rig" section for how each
field is consumed.
"""
import json
import math
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "hands")
OUT_DIR = os.path.join(ROOT, "assets", "hands")

ALPHA_MIN = 10           # below this a pixel is transparent for our purposes
EDGE_RUN_MIN_FRAC = 0.05 # an edge run wider than this counts as a limb exit
NIB_SAMPLES = 5          # leading samples that define "shaft width" for the walk guard

# Identity fields can't be measured. Everything else is derived below.
# `tip_hint` pins the nib for assets where the extremity is ambiguous; see the
# hand4 note -- its nib is the *bottom-left* end, but a naive topmost-opaque
# scan finds the pen cap instead.
STYLES = {
    "hand1": {
        "label": "Right hand, ballpoint",
        "handedness": "right",
        "tool": {"type": "pen", "inkWidth": 4.0},
        "tip_hint": "top",
    },
    "hand2": {
        "label": "Right hand, felt-tip",
        "handedness": "right",
        "tool": {"type": "pen", "inkWidth": 4.5},
        "tip_hint": "top",
    },
    "hand3": {
        "label": "Right hand, marker",
        "handedness": "right",
        # A chisel-tip marker rather than a ballpoint, so it lays a wider line.
        "tool": {"type": "pen", "inkWidth": 4.5},
        "tip_hint": "top",
    },
    "hand4": {
        "label": "Floating pen (no hand)",
        "handedness": "right",
        "tool": {"type": "pen", "inkWidth": 4.0},
        "tip_hint": "bottom-left",
        # Both ends of the bbox are interior, so the never-detached constraint
        # is unsatisfiable at any scale. This is a deliberate "floating pen"
        # style -- distinct from no-hand mode, which draws no sprite at all.
        "constraint": "none",
    },
    "eraser": {
        "label": "Right hand, eraser",
        "handedness": "right",
        # inkWidth is the tool's own contact width in source pixels; the eraser
        # block is ~107px across against a pen nib's ~4. erase.js sizes its
        # sweep from the clip's pen width, not from this, so it is descriptive.
        "tool": {"type": "eraser", "inkWidth": 26.0},
        # Neither alpha hint works here. The topmost opaque pixel is the index
        # *fingertip*, which touches the frame edge above the block, so "top"
        # would rig the hand by its finger and drag the eraser off the stroke.
        # The working face is identifiable by colour instead -- see is_tool_px.
        "tip_hint": "tool",
    },
}

# Skin is always R > G > B. The eraser's pink is the only saturated thing in
# these assets with more blue than green, which separates block from fingers
# without hand-authoring a pixel coordinate that would rot if the art changed.
TOOL_MIN_R = 150
TOOL_BLUE_OVER_GREEN = 18
# A row counts as "the face" once it is this fraction of the block's widest row.
# The very first tool row is a single antialiased pixel at a corner; taking its
# centre would put the tip several px off the face it is supposed to be.
FACE_MIN_FRAC = 0.35

RESOLUTIONS = ["720p", "1080p", "1440p"]


def load_alpha(path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    return im.split()[3].load(), w, h


def load_rgba(path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    return im.load(), w, h


def is_tool_px(p):
    """True for a pixel belonging to the coloured tool rather than to skin."""
    r, g, b, a = p
    return a > 200 and r > TOOL_MIN_R and b > g + TOOL_BLUE_OVER_GREEN


def row_runs(px, w, y):
    """Maximal runs of opaque pixels on scanline y, as (x0, x1) inclusive."""
    runs, start = [], None
    for x in range(w):
        if px[x, y] > ALPHA_MIN:
            if start is None:
                start = x
        elif start is not None:
            runs.append((start, x - 1))
            start = None
    if start is not None:
        runs.append((start, w - 1))
    return runs


def col_runs(px, h, x):
    runs, start = [], None
    for y in range(h):
        if px[x, y] > ALPHA_MIN:
            if start is None:
                start = y
        elif start is not None:
            runs.append((start, y - 1))
            start = None
    if start is not None:
        runs.append((start, h - 1))
    return runs


def opaque_bbox(px, w, h):
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        rs = row_runs(px, w, y)
        if not rs:
            continue
        y0 = min(y0, y)
        y1 = max(y1, y)
        x0 = min(x0, rs[0][0])
        x1 = max(x1, rs[-1][1])
    return [x0, y0, x1, y1]


def edge_runs(px, w, h):
    """Opaque runs lying on each frame edge, widest first per edge."""
    out = {}
    for name, runs, extent in (
        ("top", row_runs(px, w, 0), w),
        ("bottom", row_runs(px, w, h - 1), w),
        ("left", col_runs(px, h, 0), h),
        ("right", col_runs(px, h, w - 1), h),
    ):
        if not runs:
            continue
        widest = max(runs, key=lambda r: r[1] - r[0])
        out[name] = {
            "run": widest,
            "width": widest[1] - widest[0] + 1,
            "frac": (widest[1] - widest[0] + 1) / extent,
        }
    return out


def weighted_center(px, y, x0, x1):
    num = den = 0.0
    for x in range(x0, x1 + 1):
        a = px[x, y]
        if a > ALPHA_MIN:
            num += x * a
            den += a
    return num / den if den else (x0 + x1) / 2.0


def find_anchor(edges, w, h):
    """The frame edge the limb exits through: the widest edge run, if any run
    is wide enough to be a forearm rather than a pen nib touching the border."""
    best, best_frac = None, 0.0
    for name, info in edges.items():
        if info["frac"] >= EDGE_RUN_MIN_FRAC and info["frac"] > best_frac:
            best, best_frac = name, info["frac"]
    return best


def arm_exit(px, w, h, anchor, edges):
    """Alpha-weighted centre of the limb where it crosses the frame edge, in
    source pixels. Y/X are pushed to the true edge (h or w, not h-1) so the
    tip->elbow vector spans the full asset."""
    run = edges[anchor]["run"]
    if anchor in ("top", "bottom"):
        y = 0 if anchor == "top" else h - 1
        return [round(weighted_center(px, y, run[0], run[1]), 1),
                float(0 if anchor == "top" else h)]
    x = 0 if anchor == "left" else w - 1
    num = den = 0.0
    for y in range(run[0], run[1] + 1):
        a = px[x, y]
        if a > ALPHA_MIN:
            num += y * a
            den += a
    cy = num / den if den else (run[0] + run[1]) / 2.0
    return [float(0 if anchor == "left" else w), round(cy, 1)]


def find_tip(px, w, h, hint, bbox):
    """Nib position in source pixels.

    'top' assets put the nib on the top edge, so the alpha-weighted centre of
    the topmost opaque scanline is exact. 'bottom-left' walks up from the
    bottom of the opaque bbox instead -- auto-detection from the top would
    return the pen *cap*.
    """
    if hint == "top":
        for y in range(h):
            rs = row_runs(px, w, y)
            if rs:
                r = max(rs, key=lambda t: t[1] - t[0])
                return [round(weighted_center(px, y, r[0], r[1]), 1), float(y)]
    elif hint == "bottom-left":
        for y in range(h - 1, -1, -1):
            rs = row_runs(px, w, y)
            if rs:
                r = min(rs, key=lambda t: t[0])  # leftmost run at the lowest row
                return [round(weighted_center(px, y, r[0], r[1]), 1), float(y)]
    raise ValueError("unknown tip hint %r" % hint)


def tool_rows(cpx, w, h):
    """Per-row extent of the coloured tool: {y: (x0, x1, count)}."""
    rows = {}
    for y in range(h):
        xs = [x for x in range(w) if is_tool_px(cpx[x, y])]
        if xs:
            rows[y] = (min(xs), max(xs), len(xs))
    return rows


def find_tool_tip(rows):
    """Centre of the tool's leading face, in source pixels.

    The face is a face, not a point -- a block eraser contacts the page along a
    whole edge -- so the tip is the midpoint of the first row wide enough to be
    the face proper rather than its antialiased corner.
    """
    if not rows:
        raise ValueError("no tool-coloured pixels found; check is_tool_px")
    widest = max(x1 - x0 + 1 for x0, x1, _ in rows.values())
    for y in sorted(rows):
        x0, x1, _ = rows[y]
        if x1 - x0 + 1 >= FACE_MIN_FRAC * widest:
            return [round((x0 + x1) / 2.0, 1), float(y)]
    raise ValueError("tool region never reaches face width")


def tool_axis_deg(rows, tip):
    """Rest direction of the tool, as the ray face -> tool body.

    The alpha walk `shaft_angle_deg` does cannot work here: the tip sits inside
    a silhouette that also contains the whole fist, so the walk immediately
    fits a line through the knuckles. The tool's own centroid is unambiguous.
    """
    num_x = num_y = n = 0.0
    for y, (x0, x1, count) in rows.items():
        num_x += (x0 + x1) / 2.0 * count
        num_y += y * count
        n += count
    cx, cy = num_x / n, num_y / n
    dx, dy = cx - tip[0], cy - tip[1]
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return 0.0
    return round(math.degrees(math.atan2(dx, dy)), 1)


def shaft_angle_deg(px, w, h, tip, bbox):
    """Rest direction of the pen shaft, as the ray nib -> body.

    Degrees from screen-down (+Y), positive clockwise toward +X. This is a
    *ray*, not a line, so it distinguishes hand1 (nib at top, body running
    down, ~0 deg) from hand4 (nib at bottom-left, body running up-right,
    ~150 deg). The rig uses it purely as a static pre-rotation, so what matters
    is that it describes this asset's rest pose -- values need not be
    comparable across styles.

    Walks away from the nib following the run containing the previous centre.
    The stop condition is keyed to the *nib* width, not the bbox: on hand1 the
    nib is a 3px cone at the tip but the silhouette is 124px wide only 200 rows
    later, and a bbox-relative guard keeps walking straight into the knuckles,
    dragging the fitted centre sideways and inventing ~10 deg of tilt.
    """
    tx, ty = tip
    span = max(24, int(0.14 * (bbox[3] - bbox[1] + 1)))
    step = max(1, span // 40)
    direction = 1 if ty < h / 2 else -1

    pts, cx, widths = [], tx, []
    for k in range(0, span, step):
        y = int(ty) + direction * k
        if not (0 <= y < h):
            break
        rs = row_runs(px, w, y)
        if not rs:
            continue
        # follow the run containing (or nearest) the previous centre
        run = min(rs, key=lambda r: 0 if r[0] <= cx <= r[1]
                  else min(abs(r[0] - cx), abs(r[1] - cx)))
        wd = run[1] - run[0] + 1
        if len(widths) >= NIB_SAMPLES:
            # Reference is the nib itself -- the first few samples only. A
            # running median tracks the growth and lets the walk creep all the
            # way into the hand one gradual row at a time.
            ref = sorted(widths[:NIB_SAMPLES])[NIB_SAMPLES // 2]
            if wd > max(3.5 * ref, ref + 12):
                break  # widened into the hand; the shaft ended here
        widths.append(wd)
        cx = weighted_center(px, y, run[0], run[1])
        pts.append((cx, float(y)))

    if len(pts) < 3:
        return 0.0
    # least-squares fit of x against y -> dx/dy along the walked direction
    n = len(pts)
    my = sum(p[1] for p in pts) / n
    mx = sum(p[0] for p in pts) / n
    den = sum((p[1] - my) ** 2 for p in pts)
    if abs(den) < 1e-9:
        return 0.0
    slope = sum((p[1] - my) * (p[0] - mx) for p in pts) / den
    # ray away from the nib: dy = direction, dx = slope * direction
    return round(math.degrees(math.atan2(slope * direction, direction)), 1)


def stretch_band(px, w, h, anchor, bbox):
    """Contiguous source rows safe to stretch vertically: a single clean alpha
    run of slowly-varying width. Used to lengthen the forearm for portrait
    output instead of scaling the whole hand up."""
    if anchor != "bottom":
        return None
    lo = int(bbox[1] + 0.72 * (bbox[3] - bbox[1]))
    rows = []
    for y in range(lo, min(h, bbox[3] + 1)):
        rs = row_runs(px, w, y)
        if len(rs) == 1 and rs[0][1] - rs[0][0] > 0.08 * w:
            rows.append((y, rs[0][1] - rs[0][0] + 1))
    if len(rows) < 20:
        return None
    # longest sub-run whose width changes by <2% per row
    best = cur = [0, 0]
    for i in range(1, len(rows)):
        smooth = (rows[i][0] == rows[i - 1][0] + 1 and
                  abs(rows[i][1] - rows[i - 1][1]) <= max(2, 0.02 * rows[i - 1][1]))
        cur = [i - 1, i] if not smooth else [cur[0], i]
        if cur[1] - cur[0] > best[1] - best[0]:
            best = list(cur)
    if best[1] - best[0] < 20:
        return None
    # Normalised to source height, NOT absolute rows. The style manifest is
    # shared by every resolution variant, and the rig picks whichever variant
    # suits the output size -- absolute rows measured on the 1080p art fall
    # outside the 720p image entirely, so the stretch silently draws nothing
    # and the forearm just ends mid-frame.
    return [round(rows[best[0]][0] / float(h), 4),
            round(rows[best[1]][0] / float(h), 4)]


def calibrate(style_id, spec):
    sources, derived = [], {}
    for res in RESOLUTIONS:
        fname = "%s-%s.png" % (style_id, res)
        path = os.path.join(SRC_DIR, fname)
        if not os.path.exists(path):
            continue
        px, w, h = load_alpha(path)
        bbox = opaque_bbox(px, w, h)
        edges = edge_runs(px, w, h)
        anchor = find_anchor(edges, w, h) if spec.get("constraint") != "none" else None

        rows = None
        if spec["tip_hint"] == "tool":
            cpx, _, _ = load_rgba(path)
            rows = tool_rows(cpx, w, h)
            tip = find_tool_tip(rows)
        else:
            tip = find_tip(px, w, h, spec["tip_hint"], bbox)

        entry = {"w": w, "h": h, "file": "hands/" + fname,
                 "tipPx": tip, "opaqueBBox": bbox}
        if anchor:
            entry["armExitPx"] = arm_exit(px, w, h, anchor, edges)
            entry["armLenPx"] = round(math.hypot(entry["armExitPx"][0] - tip[0],
                                                 entry["armExitPx"][1] - tip[1]), 1)
        sources.append(entry)

        if res == "1080p" or not derived:
            derived = {
                "anchorEdge": anchor,
                "naturalAngleDeg": (tool_axis_deg(rows, tip) if rows
                                    else shaft_angle_deg(px, w, h, tip, bbox)),
                "stretchBand": stretch_band(px, w, h, anchor, bbox),
            }

    manifest = {
        "schema": 1,
        "id": style_id,
        "label": spec["label"],
        "handedness": spec["handedness"],
        "tool": spec["tool"],
        "anchorEdge": derived["anchorEdge"],
        "constraint": spec.get("constraint", "edge"),
        "naturalAngleDeg": derived["naturalAngleDeg"],
        "alignFactor": 0.16,
        "maxRotationDeg": 25,
        "stretchBand": derived["stretchBand"],
        "sources": sources,
    }
    return manifest


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for style_id, spec in STYLES.items():
        m = calibrate(style_id, spec)
        out = os.path.join(OUT_DIR, style_id + ".json")
        with open(out, "w") as f:
            json.dump(m, f, indent=2)
            f.write("\n")
        s = m["sources"][1] if len(m["sources"]) > 1 else m["sources"][0]
        print("%-6s anchor=%-6s angle=%+6.1f deg  tip=%s  arm=%s len=%s  stretch=%s"
              % (m["id"], m["anchorEdge"], m["naturalAngleDeg"], s["tipPx"],
                 s.get("armExitPx"), s.get("armLenPx"), m["stretchBand"]))
    print("\nwrote %d manifests to %s" % (len(STYLES), os.path.relpath(OUT_DIR, ROOT)))


if __name__ == "__main__":
    sys.exit(main())
