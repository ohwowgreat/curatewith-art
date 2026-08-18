// Plate resolution: turn an indexed artwork into a full-resolution, licence-checked
// image URL plus the provenance needed to caption it.
//
// This module is the SINGLE place where per-museum image and licensing rules live.
// Deck builds, Reflow and the Cadence LMS all resolve through it, so when a museum
// changes its IIIF route or its licence field, exactly one file needs editing.
//
// Every transform below was verified live 2026-08-18 (see the table in
// ~/.claude/plans/deck-plates-via-curatewith-art.md).

export type Museum = "met" | "aic" | "cma" | "nga" | "moma";

export interface Credit {
  artist: string;
  title: string;
  date: string;
  medium: string;
  museum: string;
  objectUrl: string;
}

export interface PlateOk {
  ok: true;
  museum: Museum;
  id: string;
  imageUrl: string;
  license: string;
  /** "seed" = the whole index was filtered at seed time; "live" = checked just now. */
  verified: "seed" | "live";
  credit: Credit;
}

export interface PlateErr {
  ok: false;
  error: string;
  museum?: string;
  id?: string;
}

export type PlateResult = PlateOk | PlateErr;

/**
 * Swap the size segment of a IIIF Image API URL.
 * Path shape: .../{id}/{region}/{size}/{rotation}/{quality}.{format}
 * Anchored at the end so an id containing "full" cannot confuse it.
 */
export function iiifResize(url: string, size: string): string {
  const m = url.match(/^(.*\/full\/)([^/]+)(\/[^/]+\/[^/]+)$/);
  return m ? `${m[1]}${size}${m[3]}` : url;
}

/** Target size segment for IIIF museums. `w` is a pixel width; omit for native size. */
function iiifSize(w?: number): string {
  return w && Number.isFinite(w) && w > 0 ? `${Math.round(w)},` : "full";
}

/**
 * Derive the full-resolution URL from the thumbnail stored in the index.
 * Returns null when the museum has no usable full-resolution derivative.
 *
 * Verified transforms:
 *   aic  /full/400,/0/default.jpg   -> /full/full/0/default.jpg   3000 x 2009
 *   nga  /full/!200,200/0/default.jpg -> /full/full/0/default.jpg 3061 x 4096
 *   met  /web-large/DP113911.jpg    -> /original/DP113911.jpg     2703 x 2943
 *   cma  1925.943_web.jpg           -> 1925.943_print.jpg         2479 x 3400
 *        (_full.jpg returns 404 -- _print is the top tier)
 */
export function fullResUrl(museum: Museum, thumbnailUrl: string, w?: number): string | null {
  if (!thumbnailUrl) return null;
  switch (museum) {
    case "aic":
    case "nga":
      return iiifResize(thumbnailUrl, iiifSize(w));
    case "met":
      return thumbnailUrl.replace("/web-large/", "/original/");
    case "cma":
      return thumbnailUrl.replace(/_web\.jpg$/, "_print.jpg");
    case "moma":
      return null;
    default:
      return null;
  }
}

/**
 * Licence posture per museum.
 *
 * met and nga are filtered at seed time, so every record in the index is already
 * clear: seed-met.mjs pulls from ?isPublicDomain=true, seed-nga.mjs keeps only
 * rows with openaccess === "1".
 *
 * aic and cma are NOT filtered at seed -- seed-aic.mjs takes every artwork with an
 * image_id, seed-cma.mjs uses has_image=1 only. Both collections contain
 * in-copyright work, so those must be checked live before an image is handed out.
 *
 * moma is excluded entirely: most records carry an empty thumbnailUrl and the
 * collection is largely in copyright. It stays a metadata source, not an image source.
 */
const SEED_FILTERED: Partial<Record<Museum, string>> = {
  met: "Public domain (Met Open Access, CC0)",
  nga: "Open access (National Gallery of Art)",
};

async function checkAic(id: string): Promise<{ ok: boolean; license: string }> {
  const res = await fetch(
    `https://api.artic.edu/api/v1/artworks/${encodeURIComponent(id)}?fields=id,is_public_domain`,
    { headers: { "User-Agent": "curatewith-art-plates/1.0" } }
  );
  if (!res.ok) return { ok: false, license: "" };
  const body = (await res.json()) as { data?: { is_public_domain?: boolean } };
  return body?.data?.is_public_domain === true
    ? { ok: true, license: "Public domain (Art Institute of Chicago, CC0)" }
    : { ok: false, license: "" };
}

async function checkCma(id: string): Promise<{ ok: boolean; license: string }> {
  const res = await fetch(
    `https://openaccess-api.clevelandart.org/api/artworks/${encodeURIComponent(id)}`,
    { headers: { "User-Agent": "curatewith-art-plates/1.0" } }
  );
  if (!res.ok) return { ok: false, license: "" };
  const body = (await res.json()) as { data?: { share_license_status?: string } };
  return body?.data?.share_license_status === "CC0"
    ? { ok: true, license: "Public domain (Cleveland Museum of Art, CC0)" }
    : { ok: false, license: "" };
}

/** Verify the licence, querying the museum only where the seed did not filter. */
export async function verifyLicense(
  museum: Museum,
  id: string
): Promise<{ ok: boolean; license: string; verified: "seed" | "live" }> {
  const seeded = SEED_FILTERED[museum];
  if (seeded) return { ok: true, license: seeded, verified: "seed" };
  if (museum === "aic") return { ...(await checkAic(id)), verified: "live" };
  if (museum === "cma") return { ...(await checkCma(id)), verified: "live" };
  return { ok: false, license: "", verified: "live" };
}

/** Build the caption payload from an indexed artwork record. */
export function creditFrom(art: Record<string, string>, museum: Museum): Credit {
  return {
    artist: art.artist || "Unknown",
    title: art.title || "Untitled",
    date: art.date || "",
    medium: art.medium || "",
    museum,
    objectUrl: art.url || "",
  };
}
