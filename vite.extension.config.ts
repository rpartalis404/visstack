import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './extension/manifest.json' with { type: 'json' };

/**
 * Extension build.
 *
 * Entirely separate from the webapp build (vite.config.ts). The webapp
 * output goes to dist/; this goes to dist-extension/. Root is set to the
 * extension/ folder so manifest-relative paths resolve cleanly.
 *
 * @crxjs/vite-plugin:
 *   - Reads manifest.json and bundles every script it references
 *     (background service worker, content scripts)
 *   - Handles dynamic imports and web_accessible_resources
 *   - Emits a valid MV3 directory that Chrome can load unpacked
 */
export default defineConfig({
  root: 'extension',
  plugins: [
    react(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    crx({ manifest: manifest as any }),
  ],
  build: {
    outDir: '../dist-extension',
    emptyOutDir: true,
    rollupOptions: {
      // Increase the size-warning threshold — butterchurn-presets is ~2MB
      // on its own, which triggers warnings at the default 500kB cutoff.
      // Not a real problem: the content script bundle is loaded on-demand
      // (user clicks extension icon), not on every page visit.
      onwarn(warning, warn) {
        if (warning.code === 'EVAL') return; // butterchurn uses eval internally
        warn(warning);
      },
    },
    chunkSizeWarningLimit: 3000,
  },
});
