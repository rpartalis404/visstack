# VisStack

Audio-reactive visualizations overlaid on any web page. 32 styles across fractals, synthwave, psychedelics, and demoscene classics — all reacting to whatever audio is playing in your tab.

## What it does

VisStack is a Chrome extension that captures audio from your current browser tab and overlays the page with a live audio-reactive visualizer. Audio continues playing normally from the source — VisStack just gets a copy of the stream for analysis, so there's no interruption, no routing, no lag.

Works on any site with audio: YouTube, Spotify Web, Bandcamp, SoundCloud, internet radio, your own uploads — anywhere Chrome's `getDisplayMedia` can see a tab.

## The library

32 visualizations across five architectural patterns:

**Butterchurn / MilkDrop (16 presets)** — curated from the Winamp community's classic library. Astral Projection, Tide Pool, Area 51, Mindblob, Spiral Dance, Acid Etching, Jelly Parade, Cell Bloom, Liquid Arrows, Tokamak, Artifact, Desert Rose, Hurricane, Witchcraft, Neon Graffiti, Liquid Fire.

**Fractals (4)** — Julia Fractal, Mandelbrot, Burning Ship, Newton Bloom. Real math, per-pixel, animated in real time by bass/mid/treble/beat. The Mandelbrot and Burning Ship plugins drift through hand-picked "points of interest" on a timer, zooming into detail-dense valleys.

**Three.js generative (5)** — Ribbons, Starfield, Prism, Neon Grid, Wireframe Pulse. Warp-speed particle fields, orbiting wireframe polyhedra, synthwave grids rushing toward a scan-line sun.

**Shader "trippy" plugins (3)** — Infinite Tunnel, Oil Slick, Inkblot. Demoscene polar-zoom tunnels, iridescent thin-film rainbow over flowing liquid, and a Rorschach-symmetric fBm noise field.

**2D canvas stylized effects (4)** — Matrix Rain, Circuit Traces, Flow Fields, Vibrant Equalizer. Cascading katakana, PCB pulses racing between nodes on every beat, particle swarms tracing smooth vector fields, and an angular CRT-style EQ.

Each plugin has its own tunable parameters — palette, speed, density, sensitivity, and more — controllable live via a modern slider / toggle / dropdown panel.

## Install

### From source (until Chrome Web Store approval lands)

Prereqs: Node 20+, Chrome.

```bash
git clone https://github.com/rpartalis404/visstack.git
cd visstack
npm install
npm run build:extension
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and pick the `dist-extension/` folder

### Chrome Web Store

*Coming soon — extension is pending review.*

## Usage

1. Play audio on any web page (YouTube, a music site, a radio stream — whatever)
2. Click the VisStack toolbar icon
3. The start card appears over the page. Click **Tap to start**
4. Chrome shows a tab picker — select the tab with the audio and click **Share**. Make sure **Also share tab audio** is checked
5. The visualizer starts. Original audio keeps playing through your speakers normally

### Controls

- **Viz name button** — open the switcher to pick one of the 32 visualizations
- **Gear icon** — tune the active viz's parameters live
- **Fullscreen icon** — enter or exit true browser fullscreen
- **X icon** — close the visualizer
- **Esc** — same as X icon

## Development

```bash
npm run dev              # Webapp dev server on http://localhost:5173
npm run dev:extension    # Extension watch mode
npm run typecheck        # Full TypeScript check
npm run build            # Webapp production build → dist/
npm run build:extension  # Extension production build → dist-extension/
```

### Adding a visualization

Each plugin lives in its own directory under `src/visualizations/<name>/` and exports a `VisualizationPlugin`:

```ts
export const myPlugin: VisualizationPlugin = {
  id: 'my-viz',
  name: 'My Viz',
  description: 'A short description shown in the tooltip.',
  params: {
    palette: { type: 'select', label: 'Palette', options: [...], default: 'neon' },
    intensity: { type: 'number', label: 'Intensity', min: 0, max: 2, default: 1 },
  },
  mount(container, ctx) {
    return new MyVizMounted(container, ctx);
  },
};
```

Your mounted class implements `MountedViz` (render / setParams / resize / destroy). Starting points:

- **Three.js shader-based** (fullscreen quad) → extend `FractalBase` in `src/visualizations/common/fractal-base.ts`. See `mandelbrot/`, `newton/`, `infinite-tunnel/`, `oil-slick/`, `inkblot/`.
- **Three.js scene-based** → use `createThreeScaffold` from `src/visualizations/common/three-scaffold.ts`. See `starfield/`, `prism/`, `neon-grid/`, `wireframe-pulse/`.
- **2D canvas** → roll the lifecycle yourself. See `matrix-rain/`, `circuit-traces/`, `flow-fields/`.

Register your plugin in `src/visualizations/registry.ts` by importing it and appending it to the `VISUALIZATIONS` array.

Every plugin receives an `AudioFrame` each tick with `fft`, `waveform`, `bass`, `mid`, `treble`, `beat`, `energy`, a tempo estimate, and timing. Shared smoothing helpers (`BandSmoother`, `BeatEnvelope`) live in `src/visualizations/common/reactive.ts`.

## Architecture

Full design rationale sits in the JSDoc at the top of `extension/content/mount.tsx` and `extension/viz.tsx`. Short version:

- **Audio capture** — `getDisplayMedia({ audio: true, video: true })` in the content script. Duplicates the tab's audio stream rather than redirecting it, so the source tab continues playing through Chrome's normal output.
- **AudioContext** lives in the content script, created synchronously inside the user's click handler so it starts in the `running` state without needing `.resume()`.
- **Visualizations render** inside a sandboxed iframe because butterchurn's MilkDrop preset compiler uses `new Function()`, which MV3 forbids on normal pages. `manifest.sandbox.pages` gets the relaxed CSP.
- **Per-frame communication** — the content script computes an `AudioFrame` every rAF tick and `postMessage`s it into the iframe. No WebRTC loopback.
- **Split-DOM UI** — the visualization canvas sits in a shadow DOM with `pointer-events: none` so host-page overlays behave normally. The interactive controls live in a *separate* shadow DOM at `document.documentElement` with `z-index: 2147483647`, so clicks always reach the buttons no matter what the host page stacks on top.

## Privacy

VisStack doesn't collect, transmit, or store any user data. All audio analysis happens locally in the browser. Your preferences (active plugin, slider values) are stored in `localStorage` under the keys `viz-ext-state-v1` (extension) and `viz-state-v1` (webapp), and never leave your device.

## Credits

Built on top of a lot of excellent open-source work:

- [butterchurn](https://github.com/jberg/butterchurn) — the MilkDrop visualization engine
- [butterchurn-presets](https://github.com/jberg/butterchurn-presets) — curated community MilkDrop preset library
- [three.js](https://threejs.org/) — WebGL scenes and post-processing
- [React](https://react.dev/) + [Vite](https://vitejs.dev/) + [@crxjs/vite-plugin](https://crxjs.dev/) — UI and build tooling
- [web-audio-beat-detector](https://github.com/chrisguttandin/web-audio-beat-detector) — tempo estimation
