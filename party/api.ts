// The read-only collection routes: ?random, ?page, ?search.
//
// Extracted from party/server.ts 2026-08-18 so they can be served by the Cloudflare
// Worker on the curatewith.art zone. They are stateless reads over Upstash's REST API
// and never needed PartyKit; only the curate-together board does, because that is the
// one piece using WebSockets and room state.
//
// Shared by both runtimes so there is exactly one implementation of each route.

import {
  redisCmd,
  redisPipeline,
  fetchArtworkPairs,
  SINGLE_MUSEUMS,
  ALL_MUSEUMS,
} from "./redis";
import { CORS } from "./resolve";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS });

/**
 * Dispatch ?random / ?page / ?search. Returns null when none of them is present,
 * so the caller can fall through to its own handling.
 */
export async function handleApi(
  params: URLSearchParams,
  redisUrl: string,
  redisToken: string,
  defaultPrefix = "moma"
): Promise<Response | null> {
  const museumParam = params.get("museum") ?? "";
  const isAll = museumParam === "all";
  const prefix = SINGLE_MUSEUMS.has(museumParam) ? museumParam : defaultPrefix;

  // GET ?random=N
  if (params.has("random")) {
    const n = parseInt(params.get("random") ?? "4");
    const prefixes = isAll ? ALL_MUSEUMS : [prefix];
    const perMuseum = Math.max(1, Math.ceil(n / prefixes.length));

    const totals = await Promise.all(
      prefixes.map(
        (p) => redisCmd(redisUrl, redisToken, "llen", `${p}:ids`) as Promise<number>
      )
    );

    const indexCmds: (string | number)[][] = [];
    const indexPrefixes: string[] = [];
    prefixes.forEach((p, i) => {
      const total = totals[i];
      if (!total) return;
      const count = Math.min(perMuseum, total);
      const indices = new Set<number>();
      while (indices.size < count) indices.add(Math.floor(Math.random() * total));
      [...indices].forEach((idx) => {
        indexCmds.push(["lindex", `${p}:ids`, idx]);
        indexPrefixes.push(p);
      });
    });

    if (indexCmds.length === 0) return json({ artworks: [] });

    const idsData = await redisPipeline(redisUrl, redisToken, indexCmds);
    const pairs = idsData
      .map((r, i) => (r.result ? { prefix: indexPrefixes[i], id: r.result as string } : null))
      .filter(Boolean) as { prefix: string; id: string }[];

    return json({ artworks: await fetchArtworkPairs(redisUrl, redisToken, pairs) });
  }

  // GET ?page=N&limit=N  (single museum only)
  if (params.has("page")) {
    const page = parseInt(params.get("page") ?? "1");
    const limit = parseInt(params.get("limit") ?? "24");
    const start = (page - 1) * limit;
    const end = start + limit - 1;

    const ids = (await redisCmd(
      redisUrl, redisToken, "lrange", `${prefix}:ids`, start, end
    )) as string[];

    if (!ids || ids.length === 0) return json({ artworks: [] });

    const pairs = ids.map((id) => ({ prefix, id }));
    return json({ artworks: await fetchArtworkPairs(redisUrl, redisToken, pairs) });
  }

  // GET ?search=Q
  if (params.has("search")) {
    const q = params.get("search")!.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const prefixes = isAll ? ALL_MUSEUMS : [prefix];
    const limitPerMuseum = isAll ? 6 : 30;

    const idSets = await Promise.all(
      prefixes.map((p) => {
        const keys = words.map((w) => `${p}:search:${w}`);
        const cmd =
          keys.length === 1
            ? redisCmd(redisUrl, redisToken, "smembers", keys[0])
            : redisCmd(redisUrl, redisToken, "sinter", ...keys);
        return cmd as Promise<string[] | null>;
      })
    );

    const pairs: { prefix: string; id: string }[] = [];
    idSets.forEach((ids, i) => {
      if (!ids || ids.length === 0) return;
      ids.slice(0, limitPerMuseum).forEach((id) => pairs.push({ prefix: prefixes[i], id }));
    });

    if (pairs.length === 0) return json({ artworks: [] });

    return json({ artworks: await fetchArtworkPairs(redisUrl, redisToken, pairs) });
  }

  return null;
}
