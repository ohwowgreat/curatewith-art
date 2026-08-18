// Cloudflare Worker on the curatewith.art zone.
//
// This Worker now serves the site. It used to be a one-line proxy to the PartyKit
// deployment, but on 2026-08-18 a `partykit deploy` failed against PartyKit's
// zone-wide 10,000 custom-domain cap and left curatewith-art.ohwowgreat.partykit.dev
// unresolvable, taking the site down. PartyKit cannot be redeployed while that cap
// holds, so the routes that never needed it were moved here, onto a zone we control.
//
// Served locally:
//   ?resolve=   plates resolution           -> party/resolve.ts
//   ?random=    random artworks             -> party/api.ts
//   ?page=      paged browse                -> party/api.ts
//   ?search=    full-text search            -> party/api.ts
//   everything else (GET)                   -> public/index.html, bundled as a text module
//
// The curate-together board:
//   WebSocket upgrades on /parties/<party>/<room> go to the CurateRoom Durable Object
//   (party/room.ts), one instance per room. This replaced the PartyKit room on
//   2026-08-18, when PartyKit's custom domain became unresolvable and undeployable;
//   nothing is proxied to PartyKit anymore.
//
// The browser already talks only to curatewith.art (public/index.html derives its host
// from location.hostname), so no frontend change is needed.

import { handleResolve, CORS } from "./party/resolve";
import { handleApi } from "./party/api";
import INDEX_HTML from "./public/index.html";

// The Durable Object class must be exported from the Worker entry module.
export { CurateRoom } from "./party/room";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.searchParams;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // WebSocket upgrades: the curate-together board, one Durable Object per room.
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const m = url.pathname.match(/^\/parties\/([^/]+)\/([^/]+)$/);
      if (!m) return new Response("unknown websocket route", { status: 400 });
      const room = `${m[1]}:${m[2]}`;
      const id = env.CURATE_ROOM.idFromName(room);
      return env.CURATE_ROOM.get(id).fetch(request);
    }

    const isApi =
      p.has("resolve") || p.has("random") || p.has("page") || p.has("search");

    if (isApi) {
      try {
        if (p.has("resolve")) {
          return await handleResolve(
            p,
            env.UPSTASH_REDIS_REST_URL,
            env.UPSTASH_REDIS_REST_TOKEN
          );
        }
        const res = await handleApi(
          p,
          env.UPSTASH_REDIS_REST_URL,
          env.UPSTASH_REDIS_REST_TOKEN
        );
        if (res) return res;
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "upstream failed: " + (e?.message ?? String(e)) }),
          { status: 502, headers: CORS }
        );
      }
    }

    // Static site. Single page, so every unmatched path serves it rather than 404ing.
    return new Response(INDEX_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  },
};
