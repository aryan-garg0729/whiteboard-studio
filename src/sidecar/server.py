"""Stdio JSON-RPC sidecar.

One newline-delimited JSON object per line in each direction. stdout carries
only protocol messages -- anything diagnostic goes to stderr, because a stray
print would corrupt the stream.

    {"id": 1, "method": "vectorize", "params": {...}}
    -> {"id": 1, "result": {...}}  |  {"id": 1, "error": {"message": ...}}
"""

import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import skeleton  # noqa: E402
import vectorize  # noqa: E402

CACHE_DIR = os.environ.get("WB_CACHE_DIR")


def _cache_path(key):
    if not CACHE_DIR or not key:
        return None
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, "%s.json" % key)


def _cached(key, produce):
    path = _cache_path(key)
    if path and os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except (ValueError, OSError):
            pass  # corrupt cache entry; recompute rather than fail
    value = produce()
    if path:
        tmp = path + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(value, f)
            os.replace(tmp, path)  # atomic, so a crash can't leave a partial file
        except OSError:
            pass
    return value


def op_ping(_params):
    import numpy, scipy, skimage, cv2
    return {
        "ok": True,
        "python": sys.version.split()[0],
        "numpy": numpy.__version__,
        "scipy": scipy.__version__,
        "skimage": skimage.__version__,
        "cv2": cv2.__version__,
    }


def op_vectorize(params):
    return _cached(params.get("key"),
                   lambda: vectorize.vectorize(params["path"], params.get("opts")))


def op_skeletonize_glyph(params):
    return _cached(params.get("key"), lambda: skeleton.skeletonize_glyph(
        params["commands"],
        upem=params.get("unitsPerEm", 1000),
        size=params.get("size", 256),
        prune_factor=params.get("pruneFactor", 1.4),
        supersample=params.get("supersample", 2),
    ))


def op_skeletonize_batch(params):
    """Warm a whole character set in one round trip -- typically fired when the
    user picks a font, so the cost hides behind the font picker."""
    out = {}
    for g in params["glyphs"]:
        try:
            out[g["key"]] = op_skeletonize_glyph({**g, **{
                "unitsPerEm": params.get("unitsPerEm", 1000),
                "size": params.get("size", 256),
                "supersample": params.get("supersample", 2),
            }})
        except Exception as exc:  # one bad glyph must not sink the batch
            out[g["key"]] = {"error": str(exc), "strokes": []}
    return out


OPS = {
    "ping": op_ping,
    "vectorize": op_vectorize,
    "skeletonizeGlyph": op_skeletonize_glyph,
    "skeletonizeBatch": op_skeletonize_batch,
}


def main():
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue

        rid = req.get("id")
        try:
            op = OPS.get(req.get("method"))
            if op is None:
                raise ValueError("unknown method: %r" % req.get("method"))
            result = op(req.get("params") or {})
            out.write(json.dumps({"id": rid, "result": result}) + "\n")
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            out.write(json.dumps({
                "id": rid,
                "error": {"message": str(exc), "type": type(exc).__name__},
            }) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
