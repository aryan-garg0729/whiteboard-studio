"""Raster image -> outline contours + fillable colour regions.

Feeds the two halves of the draw animation: region boundaries become the
outline pass the pen traces, and the region polygons become the zig-zag fill.

Whiteboard animation fundamentally assumes line art. A photograph quantises
into hundreds of noisy regions whose boundaries look like static when traced,
so imports are classified and handled with different parameters rather than
pretending one pipeline suits both.
"""

import math

import cv2
import numpy as np

from skeleton import centrelines_from_mask, mask_metrics


# --- classification -------------------------------------------------------

def classify(bgr):
    """Guess whether this is line art or a photograph.

    Line art has few distinct colours and a high proportion of near-background
    pixels; photographs have smooth gradients and high colour cardinality.
    Returns (mode, stats) so callers can show the user why and let them
    override -- the classifier is a default, not an authority.
    """
    small = cv2.resize(bgr, (128, 128), interpolation=cv2.INTER_AREA)

    # colour cardinality after coarse quantisation
    q = (small // 32).astype(np.int32)
    keys = q[:, :, 0] * 64 + q[:, :, 1] * 8 + q[:, :, 2]
    unique = int(np.unique(keys).size)

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 80, 160)
    edge_density = float(np.count_nonzero(edges)) / edges.size

    # flat-region fraction: low local variance means large uniform areas
    var = cv2.Laplacian(gray, cv2.CV_32F).var()

    line_art = unique <= 48 and var < 900
    stats = {
        "uniqueColors": unique,
        "edgeDensity": round(edge_density, 4),
        "laplacianVar": round(float(var), 1),
    }
    return ("lineArt" if line_art else "photo"), stats


# --- quantisation ---------------------------------------------------------

def quantize(bgr, k, seed=0):
    """k-means in Lab space, where Euclidean distance tracks perception far
    better than it does in RGB. Returns (labels HxW, centres_bgr kx3)."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)

    # Deterministic: fixed attempt count and PP centres seeded identically, so
    # re-importing the same file cannot produce different geometry.
    cv2.setRNGSeed(seed)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, labels, centers = cv2.kmeans(
        lab, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS)

    centers_bgr = cv2.cvtColor(
        centers.astype(np.uint8).reshape(-1, 1, 3), cv2.COLOR_LAB2BGR
    ).reshape(-1, 3)
    return labels.reshape(bgr.shape[:2]), centers_bgr


# --- contour extraction ---------------------------------------------------

def _rings_from_mask(mask, epsilon, min_area):
    """Contours of a binary mask as (outer, [holes]) pairs.

    RETR_CCOMP gives exactly the two-level hierarchy we want: top-level
    contours are region outlines, their children are holes. That maps straight
    onto the even-odd ring model the scribble generator expects, so holes need
    no special handling downstream.
    """
    contours, hierarchy = cv2.findContours(
        mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []

    hierarchy = hierarchy[0]
    out = []
    for i, cnt in enumerate(contours):
        if hierarchy[i][3] != -1:      # a hole; collected via its parent
            continue
        if cv2.contourArea(cnt) < min_area:
            continue
        outer = cv2.approxPolyDP(cnt, epsilon, True).reshape(-1, 2)
        if len(outer) < 3:
            continue

        holes = []
        child = hierarchy[i][2]
        while child != -1:
            hc = contours[child]
            if cv2.contourArea(hc) >= min_area:
                h = cv2.approxPolyDP(hc, epsilon, True).reshape(-1, 2)
                if len(h) >= 3:
                    holes.append(h)
            child = hierarchy[child][0]
        out.append((outer, holes))
    return out


def _hex(bgr_px):
    b, g, r = int(bgr_px[0]), int(bgr_px[1]), int(bgr_px[2])
    return "#%02x%02x%02x" % (r, g, b)


def _ring_list(pts):
    return [float(v) for xy in pts for v in xy]


# --- main entry point -----------------------------------------------------

# A drawn line is long relative to its thickness; a filled shape is not. The
# ratio is resolution-independent, unlike an absolute pixel width.
STROKE_ELONGATION = 6.0
# ...but a genuinely thick elongated shape (a banner, a broad brush sweep) is
# still better filled than centrelined, so cap the thickness too.
STROKE_MAX_WIDTH_FRAC = 0.02


def _stroke_like(mask, w, h):
    """Is this cluster drawn lines rather than a filled shape?"""
    m = mask_metrics(mask > 127)
    if m is None or m["length"] < 8:
        return False
    diag = math.hypot(w, h)
    return (m["elongation"] >= STROKE_ELONGATION
            and m["mean_width"] <= STROKE_MAX_WIDTH_FRAC * diag)


def vectorize(path, opts=None):
    """Trace an image into outline subpaths and fillable regions.

    Options (all optional): mode ('auto'|'lineArt'|'photo'), colors,
    minAreaFrac, smoothing, maxDim, backgroundTolerance.
    """
    opts = opts or {}

    raw = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise ValueError("cannot read image: %s" % path)

    # Flatten alpha onto white; transparent pixels become background and are
    # dropped below rather than traced as a giant rectangle.
    alpha = None
    if raw.ndim == 3 and raw.shape[2] == 4:
        alpha = raw[:, :, 3]
        bgr = raw[:, :, :3].copy()
        bgr[alpha < 8] = 255
    elif raw.ndim == 2:
        bgr = cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR)
    else:
        bgr = raw

    # Cap working resolution: contour count scales with pixels, and beyond
    # ~1600px the extra vertices are far below the pen's stroke width.
    max_dim = int(opts.get("maxDim", 1600))
    h0, w0 = bgr.shape[:2]
    scale = 1.0
    if max(h0, w0) > max_dim:
        scale = max_dim / float(max(h0, w0))
        bgr = cv2.resize(bgr, (int(w0 * scale), int(h0 * scale)),
                         interpolation=cv2.INTER_AREA)
        if alpha is not None:
            alpha = cv2.resize(alpha, (bgr.shape[1], bgr.shape[0]),
                               interpolation=cv2.INTER_AREA)

    mode = opts.get("mode", "auto")
    detected, stats = classify(bgr)
    if mode == "auto":
        mode = detected

    h, w = bgr.shape[:2]
    if mode == "lineArt":
        k = int(opts.get("colors", 6))
        smoothing = float(opts.get("smoothing", 1.4))
        min_area_frac = float(opts.get("minAreaFrac", 0.0004))
    else:
        # Photos need fewer, larger regions or the fill phase degenerates into
        # thousands of one-frame twitches, and heavier smoothing or the outline
        # pass looks like static.
        k = int(opts.get("colors", 12))
        smoothing = float(opts.get("smoothing", 3.0))
        min_area_frac = float(opts.get("minAreaFrac", 0.0015))

    # Denoise before quantising; speckle becomes spurious single-pixel regions.
    work = cv2.bilateralFilter(bgr, 7, 40, 40) if mode == "photo" else bgr

    labels, centers = quantize(work, k, seed=int(opts.get("seed", 0)))

    min_area = max(8.0, min_area_frac * w * h)
    epsilon = max(0.5, smoothing)

    # Treat the most common near-white cluster as background so we don't trace
    # and scribble-fill the paper itself.
    bg_tol = int(opts.get("backgroundTolerance", 26))
    counts = np.bincount(labels.ravel(), minlength=k)
    background = set()
    for idx in range(k):
        c = centers[idx]
        if int(c.min()) >= 255 - bg_tol:
            background.add(idx)
    if not background:
        # nothing near-white: fall back to the largest cluster only if it is
        # both dominant and light
        top = int(np.argmax(counts))
        if counts[top] > 0.45 * labels.size and int(centers[top].min()) > 190:
            background.add(top)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    regions = []
    subpaths = []
    strokes_found = 0
    for idx in range(k):
        if idx in background:
            continue
        mask = np.uint8(labels == idx) * 255
        if alpha is not None:
            mask[alpha < 8] = 0
        if not mask.any():
            continue
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

        color = _hex(centers[idx])

        # Drawn lines must be followed down their middle, not contoured.
        #
        # A contour of a thin region is a loop running down one side of the
        # line and back up the other, so the pen traces every line twice a
        # hair apart -- visibly a double outline, and on thicker ink the two
        # passes merge into a line far heavier than the original. The medial
        # axis draws each line once, which is also how it was drawn to begin
        # with.
        if mode == "lineArt" and _stroke_like(mask, w, h):
            for s in centrelines_from_mask(mask > 127, eps=max(0.6, epsilon * 0.5)):
                if len(s["pts"]) < 2:
                    continue
                subpaths.append({
                    "pts": [c for p in s["pts"] for c in p],
                    "closed": False,
                    "width": s["width"],
                    "color": color,
                })
                strokes_found += 1
            # No fillable region: the stroke's own width already covers the
            # ink, and scribbling inside a line-width region is meaningless.
            continue

        for outer, holes in _rings_from_mask(mask, epsilon, min_area):
            rings = [_ring_list(outer)] + [_ring_list(hh) for hh in holes]
            xs = outer[:, 0]
            ys = outer[:, 1]
            regions.append({
                "rings": rings,
                "color": color,
                "bbox": [float(xs.min()), float(ys.min()),
                         float(xs.max()), float(ys.max())],
                "area": float(cv2.contourArea(outer)),
            })
            # every ring is also an outline contour for the pen to trace
            for r in rings:
                subpaths.append({"pts": r, "closed": True})

    # Largest first, so the fill phase lays down big areas before detail.
    regions.sort(key=lambda r: -r["area"])

    return {
        "width": w,
        "height": h,
        "sourceWidth": w0,
        "sourceHeight": h0,
        "scale": scale,
        "bbox": [0.0, 0.0, float(w), float(h)],
        "mode": mode,
        "detectedMode": detected,
        "stats": stats,
        "params": {"colors": k, "smoothing": smoothing,
                   "minAreaFrac": min_area_frac},
        "regions": regions,
        "subpaths": subpaths,
    }
