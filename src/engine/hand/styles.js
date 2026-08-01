/**
 * Which hand-style manifests exist, and what each is for.
 *
 * Kept as data in one place because three hosts load these independently -- the
 * CLI renderer, the Electron main process and the browser engine host -- and a
 * style that only some of them load produces a preview that disagrees with the
 * export, which is the one thing the architecture is built to prevent.
 */

/** Drawing hands: offered in the picker, one chosen per project. */
export const HAND_STYLE_IDS = ['hand1', 'hand2', 'hand3', 'hand4'];

/**
 * Tool styles loaded *alongside* whichever hand is chosen.
 *
 * `pickStyleForTool()` in render/renderFrame.js resolves a non-pen tool by
 * scanning `session.hands` for a style whose `tool.type` matches, and falls back
 * to drawing no hand at all when none does. So a style listed here is not
 * optional decoration: leaving it out is what made erase sweeps run with an
 * invisible hand.
 */
export const TOOL_STYLE_IDS = ['eraser'];

/** Every manifest a session needs when `id` is the chosen drawing hand. */
export const styleIdsFor = (id) => [id, ...TOOL_STYLE_IDS.filter((t) => t !== id)];
