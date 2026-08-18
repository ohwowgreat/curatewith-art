// The plates resolve route, written once and callable from either runtime:
// the PartyKit server (party/server.ts) and the Cloudflare Worker (worker.js).
//
// It exists as a standalone handler because PartyKit's shared zone hit Cloudflare's
// 10,000 custom-domain cap on 2026-08-18 and stopped accepting deploys, so the plates
// path serves from the Worker on the curatewith.art zone instead. Keeping one
// implementation means the museum rules in plates.ts still have exactly one caller
// shape, whichever runtime is in front.

import { fullResUrl, verifyLicense, creditFrom, type Museum } from "./plates";
import { fetchArtworkPairs, SINGLE_MUSEUMS, ALL_MUSEUMS } from "./redis";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS });

/**
 * Handle ?resolve=<id>&museum=<m>[&w=<px>].
 * Returns a full-resolution image URL plus provenance. Never proxies image bytes:
 * the caller fetches those direct from the museum.
 */
export async function handleResolve(
  params: URLSearchParams,
  redisUrl: string,
  redisToken: string
): Promise<Response> {
  const id = params.get("resolve") ?? "";
  const museumParam = params.get("museum") ?? "";

  // Unlike the other routes, resolve must not fall back to a default museum:
  // silently resolving against the wrong collection would hand back a wrong image.
  if (!SINGLE_MUSEUMS.has(museumParam)) {
    return json(
      { ok: false, error: "museum required: one of " + ALL_MUSEUMS.join(", ") },
      400
    );
  }
  const museum = museumParam as Museum;

  const wRaw = params.get("w");
  const w = wRaw ? parseInt(wRaw, 10) : undefined;

  const [art] = await fetchArtworkPairs(redisUrl, redisToken, [{ prefix: museum, id }]);
  if (!art) return json({ ok: false, error: "not found", museum, id }, 404);

  const lic = await verifyLicense(museum, id);
  if (!lic.ok) {
    return json(
      {
        ok: false,
        error: "not cleared for reuse: no open-access or public-domain flag for this record",
        museum,
        id,
      },
      403
    );
  }

  const imageUrl = fullResUrl(museum, art.thumbnailUrl, w);
  if (!imageUrl) {
    return json(
      { ok: false, error: "no full-resolution derivative available", museum, id },
      422
    );
  }

  return json({
    ok: true,
    museum,
    id,
    imageUrl,
    license: lic.license,
    verified: lic.verified,
    credit: creditFrom(art as unknown as Record<string, string>, museum),
  });
}
