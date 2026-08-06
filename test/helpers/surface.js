/**
 * The node-canvas surface factory every rendering test needs.
 *
 * A called function rather than an import side effect, deliberately: the engine
 * makes the same choice in `installNodeSurfaces` for the same reason. A module
 * that silently repointed the allocator on import would make the *order* of a
 * test file's imports load-bearing, and a test that wanted its own factory
 * would have no way to win.
 */

import { createCanvas } from '@napi-rs/canvas';
import { setSurfaceFactory } from '../../src/engine/render/surfaces.js';

export function useTestSurfaces() {
  setSurfaceFactory((w, h) => {
    const canvas = createCanvas(w, h);
    return { canvas, ctx: canvas.getContext('2d') };
  });
}
