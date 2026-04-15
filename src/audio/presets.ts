/**
 * Stream presets shown in the URL bar dropdown.
 *
 * The curated list is hand-picked for two qualities:
 *   1. Reliable CORS — these stream servers send permissive CORS headers
 *      (or at minimum work cleanly through our /stream proxy)
 *   2. Different musical content — so the user can quickly A/B how a
 *      visualization responds to ambient vs beat-driven vs vocal-heavy audio
 *
 * SomaFM streams are evergreen — no session tokens, valid for years.
 *
 * Live365 streams contain a session token in the URL that expires after
 * a few hours. The CurtJazz preset here is included as an example but
 * will need refreshing periodically — grab a fresh URL from the live365
 * station page if it stops working.
 */
export interface StreamPreset {
  /** Stable id for React keys + persistence. */
  id: string;
  name: string;
  description: string;
  url: string;
}

export const CURATED_PRESETS: readonly StreamPreset[] = [
  {
    id: 'somafm-groovesalad',
    name: 'SomaFM Groove Salad',
    description: 'Downtempo beats and grooves',
    url: 'https://ice1.somafm.com/groovesalad-128-mp3',
  },
  {
    id: 'somafm-beatblender',
    name: 'SomaFM Beat Blender',
    description: 'Deep house and tribal grooves',
    url: 'https://ice1.somafm.com/beatblender-128-mp3',
  },
  {
    id: 'somafm-dronezone',
    name: 'SomaFM Drone Zone',
    description: 'Atmospheric ambient — sparse, immersive',
    url: 'https://ice1.somafm.com/dronezone-128-mp3',
  },
  {
    id: 'somafm-deepspaceone',
    name: 'SomaFM Deep Space One',
    description: 'Spacey ambient electronica',
    url: 'https://ice1.somafm.com/deepspaceone-128-mp3',
  },
  {
    id: 'somafm-indiepop',
    name: 'SomaFM Indie Pop Rocks!',
    description: 'Indie / alt-rock with vocals',
    url: 'https://ice1.somafm.com/indiepop-128-mp3',
  },
  {
    id: 'somafm-folk',
    name: 'SomaFM Folk Forward',
    description: 'Acoustic, folk, singer-songwriter',
    url: 'https://ice1.somafm.com/folkfwd-128-mp3',
  },
  {
    id: 'live365-curtjazz',
    name: 'Live365 — CurtJazz Radio',
    description: 'Jazz (live365 token expires — grab a fresh URL if it stops)',
    url: 'https://das-edge12-live365-dal02.cdnstream.com/a09856?listeningSessionId=MjVXSldUUlhKTjNIUTRONlNHWkNWS1JUS1VfZGFzLWVkZ2UxMi1saXZlMzY1LWRhbDAyLmNkbnN0cmVhbS5jb206ODE4Ng..&aw_0_1st.playerId=Live365-Widget&aw_0_1st.skey=1776240461130',
  },
];

/** Cap on how many recent URLs we remember in localStorage. */
export const MAX_RECENTS = 8;

/** Truncate a URL nicely for display in the dropdown / chip. */
export function shortLabelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip query string, prefix host, show last path segment
    const lastSeg = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const label = lastSeg ? `${u.hostname}/${lastSeg}` : u.hostname;
    return label.length > 48 ? label.slice(0, 45) + '…' : label;
  } catch {
    return url.length > 48 ? url.slice(0, 45) + '…' : url;
  }
}
