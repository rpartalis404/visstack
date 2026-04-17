import { defineConfig, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
import { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Dev middleware that fetches an arbitrary upstream audio URL and pipes the
 * response back to the browser. Because our app and this middleware share
 * the same origin (localhost:5173), the browser treats the response as
 * same-origin — the <audio crossOrigin="anonymous"> element plays it AND
 * the Web Audio AnalyserNode can read its samples. This sidesteps the CORS
 * barrier that normally blocks analysis of cross-origin streams like
 * live365's CDN.
 *
 * Usage from the browser: GET /stream?url=<encoded-upstream-url>
 *
 * Production note: this is a DEV-ONLY workaround. The production path is
 * the Chrome extension (Phase 2), which uses chrome.tabCapture and has
 * no CORS constraints against the host page's audio element.
 */
function streamProxyPlugin() {
  return {
    name: 'audio-stream-proxy',
    configureServer(server: { middlewares: Connect.Server }) {
      const handler: Connect.NextHandleFunction = async (req, res, next) => {
        const reqUrl = (req as IncomingMessage).url ?? '';
        if (!reqUrl.startsWith('/stream?')) return next();

        const parsed = new URL(reqUrl, 'http://localhost');
        const target = parsed.searchParams.get('url');
        if (!target) {
          res.statusCode = 400;
          res.end('Missing url parameter');
          return;
        }

        let upstream: Response;
        try {
          upstream = await fetch(target, {
            // Mimic a generic streaming client so radio CDNs don't reject us
            headers: {
              'User-Agent':
                'Mozilla/5.0 VisStack/0.1 (dev proxy)',
              Accept: 'audio/*, */*;q=0.8',
            },
            redirect: 'follow',
          });
        } catch (err) {
          res.statusCode = 502;
          res.end(`Upstream fetch failed: ${(err as Error).message}`);
          return;
        }

        if (!upstream.ok || !upstream.body) {
          res.statusCode = upstream.status || 502;
          res.end(`Upstream responded ${upstream.status}`);
          return;
        }

        // Copy through useful response headers, forcing CORS-open
        const ct = upstream.headers.get('content-type') ?? 'audio/mpeg';
        (res as ServerResponse).setHeader('Content-Type', ct);
        (res as ServerResponse).setHeader('Access-Control-Allow-Origin', '*');
        (res as ServerResponse).setHeader('Cache-Control', 'no-store');

        // Stream the upstream body through to the browser. Works for
        // chunked responses (Icecast/SHOUTcast) and finite files alike.
        const reader = upstream.body.getReader();
        const pump = async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) res.write(Buffer.from(value));
            }
            res.end();
          } catch {
            // Client disconnected or upstream broke — close the response
            try {
              res.end();
            } catch {
              /* already ended */
            }
          }
        };
        void pump();

        // Stop fetching upstream if the client disconnects
        req.on('close', () => {
          void reader.cancel().catch(() => undefined);
        });
      };
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), streamProxyPlugin()],
  // Relative base so the built site works whether it's served at the domain
  // root (username.github.io) or at /<reponame>/ (username.github.io/<repo>).
  base: './',
  server: {
    port: 5173,
    strictPort: false,
  },
});
