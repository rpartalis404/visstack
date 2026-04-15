import * as THREE from 'three';

/**
 * Shared palettes used by all visualizations. Each palette is a small ordered
 * list of colors that visualizations sample cyclically — typically with a
 * continuously-advancing "hue cursor" driven by audio.
 */
export const PALETTES: Record<string, readonly THREE.Color[]> = {
  neon: [
    new THREE.Color('#ff2bd6'),
    new THREE.Color('#7c3dff'),
    new THREE.Color('#00e0ff'),
    new THREE.Color('#54ff9f'),
  ],
  sunset: [
    new THREE.Color('#ff9a2b'),
    new THREE.Color('#ff3c6d'),
    new THREE.Color('#8a1e9b'),
    new THREE.Color('#2b1a5e'),
  ],
  ice: [
    new THREE.Color('#b4f6ff'),
    new THREE.Color('#6ac4ff'),
    new THREE.Color('#3a69ff'),
    new THREE.Color('#1d2a7d'),
  ],
  lava: [
    new THREE.Color('#fff08a'),
    new THREE.Color('#ff7a1f'),
    new THREE.Color('#d1263c'),
    new THREE.Color('#300a14'),
  ],
  forest: [
    new THREE.Color('#d4ff7a'),
    new THREE.Color('#3fd97a'),
    new THREE.Color('#1c8a72'),
    new THREE.Color('#0a2d3d'),
  ],
  monochrome: [
    new THREE.Color('#ffffff'),
    new THREE.Color('#bdbdd0'),
    new THREE.Color('#6b6b82'),
    new THREE.Color('#2a2a35'),
  ],
};

export const PALETTE_NAMES = Object.keys(PALETTES) as readonly (keyof typeof PALETTES)[];

/** Sample a palette at continuous t∈[0,1] with smooth interpolation. */
export function samplePalette(
  name: string,
  t: number,
  out: THREE.Color,
): THREE.Color {
  const p = PALETTES[name] ?? PALETTES.neon;
  const scaled = ((t % 1) + 1) % 1; // wrap into [0,1)
  const slot = scaled * p.length;
  const i = Math.floor(slot) % p.length;
  const j = (i + 1) % p.length;
  const frac = slot - Math.floor(slot);
  return out.copy(p[i]).lerp(p[j], frac);
}

/** For visualizations that want CSS-hex samples (e.g. CRT retro modes). */
export function paletteHex(name: string, index: number): string {
  const p = PALETTES[name] ?? PALETTES.neon;
  return `#${p[index % p.length].getHexString()}`;
}
