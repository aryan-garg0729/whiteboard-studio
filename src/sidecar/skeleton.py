"""Glyph outline -> ordered single-stroke centrelines.

This is what makes text animate as real handwriting rather than as an outline
being traced. The JS side owns typography (kerning, advance widths, layout) via
opentype.js and sends only the glyph *outline*, so this module never needs the
font file -- and two fonts sharing a glyph share a cache entry.

Honest limitation: this extracts the medial axis of a printed letterform. On a
near-monoline handwriting face the medial axis genuinely is the pen path and
the result is excellent. On a modulated serif face (Times, Georgia, any Didone)
a serif's medial axis is a T-shaped blob that prunes to a stub, and the output
reads as a wireframe of printed type rather than as writing.
"""

import math

import numpy as np
from scipy import ndimage
from skimage.morphology import skeletonize

# 8-neighbour offsets
NEIGH = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


# --- rasterisation --------------------------------------------------------

def _flatten_cubic(p0, p1, p2, p3, out, tol=0.25):
    ax = p0[0] - 2 * p1[0] + p2[0]
    ay = p0[1] - 2 * p1[1] + p2[1]
    bx = p1[0] - 2 * p2[0] + p3[0]
    by = p1[1] - 2 * p2[1] + p3[1]
    l = max(math.hypot(ax, ay), math.hypot(bx, by))
    n = max(1, int(math.ceil(math.sqrt(3.0 * l / (4.0 * tol))))) if l > 0 else 1
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        out.append((
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ))


def rasterize(commands, upem, size):
    """Render an opentype.js command list into a binary mask.

    Returns (mask, transform) where transform maps mask pixels back to font
    units. y is flipped: font units are y-up, rasters are y-down.
    """
    import cv2

    scale = float(size) / float(upem)
    polys = []
    cur = []
    start = (0.0, 0.0)
    pen = (0.0, 0.0)

    for c in commands:
        t = c["type"]
        if t == "M":
            if len(cur) >= 3:
                polys.append(cur)
            pen = start = (c["x"], c["y"])
            cur = [pen]
        elif t == "L":
            pen = (c["x"], c["y"])
            cur.append(pen)
        elif t == "C":
            _flatten_cubic(pen, (c["x1"], c["y1"]), (c["x2"], c["y2"]),
                           (c["x"], c["y"]), cur, tol=upem / 800.0)
            pen = (c["x"], c["y"])
        elif t == "Q":
            c1 = (pen[0] + 2.0 / 3 * (c["x1"] - pen[0]),
                  pen[1] + 2.0 / 3 * (c["y1"] - pen[1]))
            c2 = (c["x"] + 2.0 / 3 * (c["x1"] - c["x"]),
                  c["y"] + 2.0 / 3 * (c["y1"] - c["y"]))
            _flatten_cubic(pen, c1, c2, (c["x"], c["y"]), cur, tol=upem / 800.0)
            pen = (c["x"], c["y"])
        elif t == "Z":
            if len(cur) >= 3:
                polys.append(cur)
            cur = []
            pen = start
    if len(cur) >= 3:
        polys.append(cur)
    if not polys:
        return None, None

    xs = [p[0] for poly in polys for p in poly]
    ys = [p[1] for poly in polys for p in poly]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)

    pad = 6
    w = int(math.ceil((maxx - minx) * scale)) + pad * 2
    h = int(math.ceil((maxy - miny) * scale)) + pad * 2
    if w < 3 or h < 3:
        return None, None

    mask = np.zeros((h, w), np.uint8)
    cvpolys = []
    for poly in polys:
        arr = np.array([[(x - minx) * scale + pad,
                         h - 1 - ((y - miny) * scale + pad)] for x, y in poly],
                       dtype=np.int32)
        cvpolys.append(arr)
    # Non-zero winding matches how font outlines define interiors, so counters
    # (the hole in 'o') come out correctly without extra bookkeeping.
    cv2.fillPoly(mask, cvpolys, 255, lineType=cv2.LINE_8)

    def to_font(px, py):
        return (px - pad) / scale + minx, (h - 1 - py - pad) / scale + miny

    return mask, to_font


# --- skeleton graph -------------------------------------------------------

def _neighbours(skel, y, x):
    h, w = skel.shape
    out = []
    for dy, dx in NEIGH:
        ny, nx = y + dy, x + dx
        if 0 <= ny < h and 0 <= nx < w and skel[ny, nx]:
            out.append((ny, nx))
    return out


def build_graph(skel):
    """Classify skeleton pixels and merge junction clusters.

    Skeletons produce junction *blobs*, not points. Without merging, every
    crossing becomes a four-node tangle and stroke chaining explodes into
    spokes instead of continuous strokes.
    """
    ys, xs = np.nonzero(skel)
    degree = {}
    for y, x in zip(ys, xs):
        degree[(y, x)] = len(_neighbours(skel, y, x))

    nodes = {p for p, d in degree.items() if d != 2}

    # merge junctions that touch each other into one node at their centroid
    junctions = [p for p in nodes if degree[p] >= 3]
    jset = set(junctions)
    clusters = []
    seen = set()
    for p in junctions:
        if p in seen:
            continue
        stack, comp = [p], []
        seen.add(p)
        while stack:
            q = stack.pop()
            comp.append(q)
            for n in _neighbours(skel, *q):
                if n in jset and n not in seen:
                    seen.add(n)
                    stack.append(n)
        clusters.append(comp)

    rep = {}
    for comp in clusters:
        cy = sum(p[0] for p in comp) / len(comp)
        cx = sum(p[1] for p in comp) / len(comp)
        anchor = min(comp, key=lambda p: (p[0] - cy) ** 2 + (p[1] - cx) ** 2)
        for p in comp:
            rep[p] = anchor

    return degree, nodes, rep


def trace_edges(skel, degree, nodes, rep):
    """Walk the skeleton into edges between endpoints/junctions.

    Edge endpoints are canonicalised onto their junction-cluster anchor. That
    is what lets chain_strokes() join edges later: two edges meeting at a
    merged junction otherwise terminate on *different* raw pixels of the same
    cluster, never compare equal, and every crossing stays shattered into
    separate spokes (a 't' comes out as 8 strokes instead of 2).
    """
    node_at = {rep.get(p, p) for p in nodes}
    edges = []
    visited = set()

    def canon(p):
        return rep.get(p, p)

    for p in list(nodes):
        for start in _neighbours(skel, *p):
            key = (p, start)
            if key in visited:
                continue
            path = [p, start]
            visited.add(key)
            visited.add((start, p))
            prev, cur = p, start
            while canon(cur) not in node_at and degree.get(cur, 0) == 2:
                nxt = [n for n in _neighbours(skel, *cur) if n != prev]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                path.append(cur)
                visited.add((prev, cur))
                visited.add((cur, prev))
            path[0] = canon(path[0])
            path[-1] = canon(path[-1])
            # collapse any duplicate introduced by canonicalisation
            path = [q for i, q in enumerate(path) if i == 0 or q != path[i - 1]]
            if len(path) >= 2:
                edges.append(path)

    # isolated loops (o, 0) have no endpoints or junctions at all
    covered = {p for e in edges for p in e}
    ys, xs = np.nonzero(skel)
    for y, x in zip(ys, xs):
        if (y, x) in covered:
            continue
        loop = [(y, x)]
        covered.add((y, x))
        prev, cur = None, (y, x)
        while True:
            nxt = [n for n in _neighbours(skel, *cur) if n != prev and n not in covered]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            loop.append(cur)
            covered.add(cur)
        if len(loop) > 6:
            edges.append(loop)
    return edges


def prune_spurs(edges, dist, factor=1.4):
    """Drop branches that are skeletonisation noise rather than real strokes.

    The threshold is *local stroke thickness*, not a constant. That is what
    removes serif barbs and the little Y-forks at stroke ends while keeping a
    genuinely short stroke like the crossbar of a 't'.
    """
    kept = list(edges)
    changed = True
    while changed:
        changed = False
        endpoint_count = {}
        for e in kept:
            for p in (e[0], e[-1]):
                endpoint_count[p] = endpoint_count.get(p, 0) + 1

        out = []
        for e in kept:
            free = [p for p in (e[0], e[-1]) if endpoint_count.get(p, 0) == 1]
            if len(free) == 1 and len(e) > 1:
                anchor = e[-1] if free[0] == e[0] else e[0]
                thickness = float(dist[anchor[0], anchor[1]])
                if len(e) < factor * max(thickness, 1.0) * 2.0:
                    changed = True
                    continue
            out.append(e)
        if len(out) == len(kept):
            break
        kept = out
    return kept


def _angle(a, b):
    return math.atan2(b[0] - a[0], b[1] - a[1])


def chain_strokes(edges):
    """Join edges into continuous strokes at junctions.

    At each junction continue into the *straightest* branch rather than the
    shortest or the first found. That is what makes a 'k' read as a stem plus
    one diagonal instead of three disconnected stubs.
    """
    remaining = list(edges)
    strokes = []

    while remaining:
        cur = remaining.pop(0)
        extended = True
        while extended:
            extended = False
            tail = cur[-1]
            if len(cur) < 2:
                break
            indir = _angle(cur[-2], cur[-1])
            best, best_turn, best_rev = None, math.pi / 3, False
            for i, e in enumerate(remaining):
                for rev in (False, True):
                    cand = e[::-1] if rev else e
                    if cand[0] != tail or len(cand) < 2:
                        continue
                    turn = abs(((_angle(cand[0], cand[1]) - indir + math.pi)
                                % (2 * math.pi)) - math.pi)
                    if turn < best_turn:
                        best, best_turn, best_rev = i, turn, rev
            if best is not None:
                e = remaining.pop(best)
                cur = cur + (e[::-1] if best_rev else e)[1:]
                extended = True
        strokes.append(cur)
    return strokes


def rdp(points, eps):
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    den = math.hypot(dx, dy)
    worst, idx = -1.0, 0
    for i in range(1, len(points) - 1):
        p = points[i]
        if den < 1e-9:
            d = math.hypot(p[0] - a[0], p[1] - a[1])
        else:
            d = abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / den
        if d > worst:
            worst, idx = d, i
    if worst <= eps:
        return [a, b]
    return rdp(points[:idx + 1], eps)[:-1] + rdp(points[idx:], eps)


# --- entry point ----------------------------------------------------------

def skeletonize_glyph(commands, upem=1000, size=256, prune_factor=1.4,
                      supersample=2):
    """Ordered centreline strokes for one glyph outline, in font units."""
    render = int(size * supersample)
    mask, to_font = rasterize(commands, upem, render)
    if mask is None:
        return {"strokes": [], "empty": True}

    binary = mask > 127
    dist = ndimage.distance_transform_edt(binary)
    skel = skeletonize(binary, method="lee")

    degree, nodes, rep = build_graph(skel)
    edges = trace_edges(skel, degree, nodes, rep)

    # Chain BEFORE pruning. A crossbar crosses its stem, so it arrives as two
    # short free-ended edges; pruned individually they both look like spurs and
    # vanish, which turned "coffee" into "coliee" while 't' survived only
    # because its bar happened to clear the threshold. Chaining first fuses the
    # halves into one long stroke that no longer reads as noise. Genuine
    # skeleton spurs (serif barbs) are near-perpendicular, so the collinearity
    # test in chain_strokes will not absorb them and they still get pruned.
    strokes_px = chain_strokes(edges)
    strokes_px = prune_spurs(strokes_px, dist, prune_factor)

    eps = 0.4 * supersample
    out = []
    for path in strokes_px:
        if len(path) < 2:
            continue
        pts = [(float(x), float(y)) for y, x in path]

        # Skeletonisation and pruning both retract stroke ends inward by about
        # the local radius; without extending them every letter looks slightly
        # eroded at the tips.
        #
        # Only genuine *free* ends may be extended. An end sitting on a
        # junction is not a stroke terminus at all -- the letter continues
        # there through another stroke -- so extending it shoots a hook out
        # into empty space, and since `dist` peaks at junctions the overshoot
        # is largest exactly where it is most wrong. That is what put the
        # spurs on the arches of 'm', the arm of 'r' and the join of 'e'.
        for end in (0, -1):
            y, x = path[end]
            if degree.get((y, x), 0) != 1:
                continue
            r = float(dist[y, x])
            if r > 1.0 and len(pts) >= 2:
                ax, ay = (pts[0], pts[1]) if end == 0 else (pts[-1], pts[-2])
                px, py = ax
                qx, qy = ay
                dx, dy = px - qx, py - qy
                n = math.hypot(dx, dy)
                if n > 1e-6:
                    ext = (px + dx / n * r, py + dy / n * r)
                    if end == 0:
                        pts.insert(0, ext)
                    else:
                        pts.append(ext)

        simple = rdp(pts, eps)
        radii = []
        for x, y in simple:
            yi = min(max(int(round(y)), 0), dist.shape[0] - 1)
            xi = min(max(int(round(x)), 0), dist.shape[1] - 1)
            radii.append(float(dist[yi, xi]))

        font_pts = []
        for x, y in simple:
            fx, fy = to_font(x, y)
            font_pts.append([round(fx, 2), round(fy, 2)])

        scale_back = upem / float(render)
        out.append({
            "pts": font_pts,
            "radius": [round(r * scale_back, 2) for r in radii],
            "length": sum(math.hypot(simple[i + 1][0] - simple[i][0],
                                     simple[i + 1][1] - simple[i][1])
                          for i in range(len(simple) - 1)) * scale_back,
        })

    # A high ratio of thickness variation means a modulated/serif face, whose
    # medial axis will not read as handwriting. Surfaced so the UI can warn.
    #
    # Sample the distance transform at SKELETON pixels only. On the medial axis
    # dist is the local stroke half-width, which is exactly what modulation
    # means. Sampling the whole interior instead measures the taper from centre
    # to edge that every stroke has by definition, so even a perfectly monoline
    # face scores ~0.57 and the flag fires on everything.
    axis = dist[skel]
    modulation = float(axis.std() / axis.mean()) if axis.size and axis.mean() else 0.0

    return {
        "strokes": out,
        "modulation": round(modulation, 3),
        "monoline": modulation < 0.22,
        "empty": not out,
    }


# --- centrelines for arbitrary ink masks ----------------------------------

def mask_metrics(binary):
    """Medial-axis statistics for a binary mask.

    `mean_width` is the average stroke thickness: on the medial axis the
    distance transform *is* the local half-width. `elongation` is skeleton
    length over that width, which separates a drawn line (hundreds) from a
    filled shape (single digits) without depending on image resolution.
    """
    dist = ndimage.distance_transform_edt(binary)
    skel = skeletonize(binary, method="lee")
    axis = dist[skel]
    if axis.size == 0:
        return None
    mean_width = float(axis.mean()) * 2.0
    length = float(skel.sum())
    return {
        "dist": dist,
        "skel": skel,
        "mean_width": mean_width,
        "max_width": float(axis.max()) * 2.0,
        "length": length,
        "elongation": length / max(mean_width, 1e-6),
    }


def centrelines_from_mask(binary, prune_factor=1.4, eps=0.8, metrics=None):
    """Ordered centreline polylines for an ink mask, in pixel coordinates.

    This is the same pipeline the glyph path uses -- and for the same reason.
    Contouring a drawn line returns a loop that runs down one side and back up
    the other, so the pen traces every line twice, a hair apart. Following the
    medial axis instead draws each line once, the way it was drawn originally.

    @returns list of {"pts": [[x, y], ...], "width": float}
    """
    m = metrics or mask_metrics(binary)
    if m is None:
        return []
    dist, skel = m["dist"], m["skel"]

    degree, nodes, rep = build_graph(skel)
    edges = trace_edges(skel, degree, nodes, rep)

    # Chain before pruning, exactly as for glyphs: a crossing arrives as short
    # free-ended edges that each look like a spur in isolation.
    strokes = prune_spurs(chain_strokes(edges), dist, prune_factor)

    out = []
    for path in strokes:
        if len(path) < 2:
            continue
        pts = [(float(x), float(y)) for y, x in path]

        # Skeletonisation retracts free ends inward by about the local radius.
        # Only ends with degree 1 are genuine termini; extending a junction
        # would shoot a hook into empty space.
        for end in (0, -1):
            y, x = path[end]
            if degree.get((y, x), 0) != 1:
                continue
            r = float(dist[y, x])
            if r > 1.0:
                (px, py), (qx, qy) = (pts[0], pts[1]) if end == 0 else (pts[-1], pts[-2])
                dx, dy = px - qx, py - qy
                n = math.hypot(dx, dy)
                if n > 1e-6:
                    ext = (px + dx / n * r, py + dy / n * r)
                    pts.insert(0, ext) if end == 0 else pts.append(ext)

        simple = rdp(pts, eps)
        if len(simple) < 2:
            continue
        radii = []
        for x, y in simple:
            yi = min(max(int(round(y)), 0), dist.shape[0] - 1)
            xi = min(max(int(round(x)), 0), dist.shape[1] - 1)
            radii.append(float(dist[yi, xi]))
        out.append({
            "pts": [[round(x, 2), round(y, 2)] for x, y in simple],
            "width": round(2.0 * (sum(radii) / len(radii)), 2),
        })
    return out
