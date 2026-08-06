/**
 * SVG document -> outline contours + fillable colour regions.
 *
 * The geometry is used exactly as drawn -- nothing is traced or approximated,
 * because an SVG already *is* the exact shape a tracer would be guessing at.
 * What comes out is what `paintVectorArt` installs as a clip's artwork; the pen
 * is planned against a raster of it, so a vector and a photograph draw the same
 * way. See `render/rasterize.js`.
 *
 * Scope is the drawing subset that matters for whiteboard art: shapes, groups,
 * transforms, presentation attributes and inline `style`. Not supported (and
 * deliberately so, because each would change the animation model rather than
 * just the parser): gradients and patterns as fills, `<use>`/`<defs>`
 * references, clip paths, masks, filters and embedded raster.
 */

import { DOMParser } from '@xmldom/xmldom';
import { flattenPath, signedArea } from './svgPath.js';

const NUM = '[-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?';

/** Multiply two 6-element affine matrices ([a b c d e f], SVG order). */
export function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Parse an SVG `transform` attribute into a single affine matrix. */
export function parseTransform(str) {
  if (!str) return IDENTITY;
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(str))) {
    const a = (hit[2].match(new RegExp(NUM, 'g')) || []).map(Number);
    const rad = (d) => (d * Math.PI) / 180;
    let t = IDENTITY;
    switch (hit[1]) {
      case 'matrix': t = a.length === 6 ? a : IDENTITY; break;
      case 'translate': t = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale': t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const c = Math.cos(rad(a[0] || 0));
        const s = Math.sin(rad(a[0] || 0));
        t = [c, s, -s, c, 0, 0];
        if (a.length >= 3) {
          // rotate(angle cx cy) == translate(cx cy) rotate(angle) translate(-cx -cy)
          t = matMul(matMul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        }
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(rad(a[0] || 0)), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(rad(a[0] || 0)), 0, 1, 0, 0]; break;
      default: break;
    }
    m = matMul(m, t);
  }
  return m;
}

/** Inline `style` declarations, which override presentation attributes. */
function styleMap(node) {
  const out = {};
  const raw = node.getAttribute?.('style');
  if (!raw) return out;
  for (const decl of raw.split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

function prop(node, name, inherited) {
  const style = styleMap(node);
  return style[name] ?? node.getAttribute?.(name) ?? inherited;
}

const num = (node, name, dflt = 0) => {
  const v = parseFloat(node.getAttribute?.(name));
  return Number.isFinite(v) ? v : dflt;
};

/** Normalise a paint value; returns null when nothing should be painted. */
function paint(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'none' || v === 'transparent') return null;
  // Gradients and patterns resolve to url(#id); we cannot fill with those, so
  // fall back to a mid grey rather than dropping the shape entirely.
  if (v.startsWith('url(')) return '#808080';
  return value;
}

/** Convert a basic shape element into path data. */
export function shapeToPath(node) {
  switch (node.tagName) {
    case 'path':
      return node.getAttribute('d') || '';
    case 'rect': {
      const x = num(node, 'x');
      const y = num(node, 'y');
      const w = num(node, 'width');
      const h = num(node, 'height');
      if (w <= 0 || h <= 0) return '';
      let rx = num(node, 'rx', NaN);
      let ry = num(node, 'ry', NaN);
      if (!Number.isFinite(rx) && !Number.isFinite(ry)) {
        return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
      }
      rx = Math.min(Number.isFinite(rx) ? rx : ry, w / 2);
      ry = Math.min(Number.isFinite(ry) ? ry : rx, h / 2);
      return `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}`
           + `V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}`
           + `H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}`
           + `V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`;
    }
    case 'circle': {
      const r = num(node, 'r');
      if (r <= 0) return '';
      const cx = num(node, 'cx');
      const cy = num(node, 'cy');
      return `M${cx - r},${cy}A${r},${r} 0 1 0 ${cx + r},${cy}A${r},${r} 0 1 0 ${cx - r},${cy}Z`;
    }
    case 'ellipse': {
      const rx = num(node, 'rx');
      const ry = num(node, 'ry');
      if (rx <= 0 || ry <= 0) return '';
      const cx = num(node, 'cx');
      const cy = num(node, 'cy');
      return `M${cx - rx},${cy}A${rx},${ry} 0 1 0 ${cx + rx},${cy}`
           + `A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z`;
    }
    case 'line':
      return `M${num(node, 'x1')},${num(node, 'y1')}L${num(node, 'x2')},${num(node, 'y2')}`;
    case 'polyline':
    case 'polygon': {
      const pts = (node.getAttribute('points') || '').match(new RegExp(NUM, 'g'));
      if (!pts || pts.length < 4) return '';
      let d = `M${pts[0]},${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]},${pts[i + 1]}`;
      return node.tagName === 'polygon' ? `${d}Z` : d;
    }
    default:
      return '';
  }
}

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern',
                      'linearGradient', 'radialGradient', 'filter', 'title', 'desc',
                      'metadata', 'style', 'script']);

function bboxOf(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of list) {
    for (let i = 0; i < s.pts.length; i += 2) {
      if (s.pts[i] < x0) x0 = s.pts[i];
      if (s.pts[i] > x1) x1 = s.pts[i];
      if (s.pts[i + 1] < y0) y0 = s.pts[i + 1];
      if (s.pts[i + 1] > y1) y1 = s.pts[i + 1];
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

/**
 * @param {string} text SVG source
 * @param {Object} [opts]
 * @param {number} [opts.eps=0.2] flattening tolerance, in user units
 * @returns {{width:number, height:number, bbox:number[], subpaths:Array, regions:Array}}
 */
export function parseSvg(text, opts = {}) {
  const eps = opts.eps ?? 0.2;
  const doc = new DOMParser({ onError: () => {} }).parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'svg') throw new Error('not an SVG document');

  const subpaths = [];
  const regions = [];

  const walk = (node, matrix, inherited) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeType !== 1) continue;                  // elements only
      if (SKIP.has(child.tagName)) continue;

      const m = matMul(matrix, parseTransform(child.getAttribute('transform')));
      const style = {
        fill: prop(child, 'fill', inherited.fill),
        stroke: prop(child, 'stroke', inherited.stroke),
        strokeWidth: prop(child, 'stroke-width', inherited.strokeWidth),
      };

      if (child.tagName === 'g' || child.tagName === 'svg') {
        walk(child, m, style);
        continue;
      }
      if (!SHAPES.has(child.tagName)) continue;

      const d = shapeToPath(child);
      if (!d) continue;
      const flat = flattenPath(d, { eps, matrix: m });
      if (!flat.length) continue;

      // Every contour is something the pen traces. Carry the source stroke
      // paint with it: once the drawing settles to the original artwork we
      // have to reproduce the file's own hairlines, not the pen's ink width.
      // The transform scales stroke widths along with the geometry.
      const strokePaint = paint(style.stroke);
      const strokeScale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
      for (const sp of flat) {
        if (strokePaint) {
          sp.stroke = strokePaint;
          sp.strokeWidth = (parseFloat(style.strokeWidth) || 1) * strokeScale;
        }
        subpaths.push(sp);
      }

      // A filled shape becomes one region; its own subpaths are the rings, so
      // holes (a donut, a counter) fall out of the even-odd rule for free.
      const fill = paint(style.fill === undefined ? '#000000' : style.fill);
      if (fill) {
        const rings = flat.map((sp) => sp.pts);
        // Largest ring first, so consumers that assume rings[0] is the outer
        // boundary are right.
        rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
        const bb = bboxOf(flat);
        regions.push({
          rings,
          color: fill,
          bbox: bb,
          area: Math.abs(signedArea(rings[0])),
        });
      }
    }
  };

  walk(root, IDENTITY, { fill: undefined, stroke: undefined, strokeWidth: undefined });

  // Prefer viewBox: width/height may be in physical units (mm, in) while all
  // coordinates are in user units.
  const vb = (root.getAttribute('viewBox') || '').match(new RegExp(NUM, 'g'))?.map(Number);
  const content = bboxOf(subpaths);
  const width = vb ? vb[2] : (parseFloat(root.getAttribute('width')) || content[2]);
  const height = vb ? vb[3] : (parseFloat(root.getAttribute('height')) || content[3]);

  regions.sort((a, b) => b.area - a.area);

  return {
    width: width || content[2] || 1,
    height: height || content[3] || 1,
    bbox: [0, 0, width || content[2] || 1, height || content[3] || 1],
    subpaths,
    regions,
    source: 'svg',
  };
}
