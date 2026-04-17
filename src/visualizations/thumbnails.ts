/**
 * Signature CSS gradients for each visualization's preview tile.
 *
 * Rendered as the `background` of buttons in the extension's viz menu
 * and the webapp's switcher modal, giving each plugin a visually
 * distinct preview without the cost of running 32 simultaneous
 * render loops behind miniature canvases.
 *
 * Adding a new plugin? You don't have to touch this file — the hash
 * fallback at the bottom produces a deterministic, pleasant gradient
 * from any id. Drop in a signature entry here only when the default
 * feels off-brand for the plugin.
 */

const THUMBNAILS: Record<string, string> = {
  // --- Butterchurn / MilkDrop presets -------------------------------------
  // Each preset gets a gradient evoking its vibe. These are hand-tuned so
  // the thumbnail reads as a miniature version of the actual scene.
  'astral-projection':
    'linear-gradient(135deg, #1a0a3e 0%, #a78bfa 50%, #22d3ee 100%)',
  'tide-pool':
    'linear-gradient(135deg, #0a2d3e 0%, #22d3ee 60%, #54ff9f 100%)',
  'area-51':
    'linear-gradient(135deg, #0a1a0a 0%, #3fd97a 55%, #22d3ee 100%)',
  'mindblob':
    'radial-gradient(circle at 30% 40%, #ff6bcb 0%, #7c3dff 60%, #1a0a3e 100%)',
  'spiral-dance':
    'conic-gradient(from 45deg, #ff8c2b, #ff3c6d, #a78bfa, #ff8c2b)',
  'acid-etching':
    'linear-gradient(135deg, #0a2d1a 0%, #9dff54 60%, #f5ff66 100%)',
  'jelly-parade':
    'linear-gradient(135deg, #ff9ac5 0%, #a78bfa 33%, #54ff9f 66%, #ffe066 100%)',
  'cell-bloom':
    'radial-gradient(circle at 50% 50%, #ff6bcb 0%, #d1263c 65%, #300a14 100%)',
  'liquid-arrows':
    'linear-gradient(135deg, #0a1a3e 0%, #3a69ff 55%, #22d3ee 100%)',
  'tokamak':
    'radial-gradient(circle at 50% 60%, #ffe066 0%, #ff5a1a 40%, #300a14 100%)',
  'artifact':
    'linear-gradient(135deg, #2a2a35 0%, #6b6b82 55%, #d4a24c 100%)',
  'desert-rose':
    'linear-gradient(135deg, #ff3c6d 0%, #ff8c2b 55%, #ffd68a 100%)',
  'hurricane':
    'conic-gradient(from 0deg at 50% 50%, #1d2a7d, #6ac4ff, #1d2a7d)',
  'witchcraft':
    'linear-gradient(135deg, #1a0a3e 0%, #7c3dff 55%, #0a0a12 100%)',
  'neon-graffiti':
    'linear-gradient(135deg, #ff2bd6 0%, #00e0ff 100%)',
  'liquid-fire':
    'radial-gradient(circle at 30% 70%, #ffe066 0%, #ff5a1a 45%, #300a14 100%)',

  // --- Fractals -----------------------------------------------------------
  julia:
    'radial-gradient(circle at 50% 50%, #ff2bd6 0%, #7c3dff 50%, #1a0a3e 100%)',
  mandelbrot:
    'radial-gradient(circle at 40% 50%, #fff08a 0%, #ff7a1f 28%, #d1263c 58%, #0a0205 100%)',
  'burning-ship':
    'linear-gradient(180deg, #0a0205 0%, #ff5a1a 55%, #ffe066 85%, #0a0205 100%)',
  'newton-bloom':
    'conic-gradient(from 0deg, #ff2bd6, #a78bfa, #22d3ee, #54ff9f, #ffe066, #ff2bd6)',

  // --- Three.js generative scenes -----------------------------------------
  ribbons:
    'linear-gradient(135deg, #a78bfa 0%, #f472b6 33%, #22d3ee 66%, #54ff9f 100%)',
  starfield:
    'radial-gradient(circle at 50% 50%, #fff 0%, #a78bfa 12%, #1a0a3e 55%, #02020a 100%)',
  prism:
    'conic-gradient(from 45deg, #ff3c6d, #ffd68a, #54ff9f, #22d3ee, #a78bfa, #ff3c6d)',
  'neon-grid':
    'linear-gradient(180deg, #1a0a3e 0%, #7c3dff 40%, #ff3c6d 78%, #ff9f6b 100%)',
  'wireframe-pulse':
    'radial-gradient(circle at 50% 50%, #22d3ee 0%, #7c3dff 55%, #02020a 100%)',

  // --- Shader "trippy" plugins --------------------------------------------
  'infinite-tunnel':
    'radial-gradient(circle at 50% 50%, #000 0%, #7c3dff 28%, #ff2bd6 58%, #ffd68a 100%)',
  'oil-slick':
    'conic-gradient(from 180deg, #ff006e, #fb5607, #ffbe0b, #8338ec, #3a86ff, #ff006e)',
  inkblot:
    'radial-gradient(ellipse at 50% 40%, #0a0205 0%, #1a0a10 38%, #f5f0e0 100%)',

  // --- 2D canvas stylized effects -----------------------------------------
  'matrix-rain':
    'linear-gradient(180deg, #000 0%, #005020 40%, #00ff41 100%)',
  'circuit-traces':
    'linear-gradient(135deg, #001a00 0%, #004d20 50%, #50ff80 100%)',
  'flow-fields':
    'linear-gradient(135deg, #1a0a3e 0%, #ff2bd6 38%, #22d3ee 78%, #54ff9f 100%)',
  crt: 'linear-gradient(90deg, #ff2bd6 0%, #ffe066 25%, #54ff9f 50%, #22d3ee 75%, #7c3dff 100%)',
};

/**
 * Deterministic pseudo-random gradient for any id. Uses a small string
 * hash to pick two hues from opposite sides of the wheel, producing
 * colorful-but-harmonious tiles for plugins without a signature entry
 * above.
 */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fallbackGradient(id: string): string {
  const hash = hashString(id);
  const h1 = hash % 360;
  const h2 = (hash * 7) % 360;
  return `linear-gradient(135deg, hsl(${h1}, 65%, 55%) 0%, hsl(${h2}, 65%, 28%) 100%)`;
}

/** Resolve the CSS `background` value for a plugin's thumbnail tile. */
export function thumbnailFor(id: string): string {
  return THUMBNAILS[id] ?? fallbackGradient(id);
}
