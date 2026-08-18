// Upstash Redis REST helpers, shared by the PartyKit server and the Cloudflare Worker.
// Extracted from party/server.ts 2026-08-18 so the resolve route can run from either
// runtime without a second copy of this code.

export async function redisCmd(
  url: string,
  token: string,
  ...args: (string | number)[]
): Promise<unknown> {
  const path = args.map((a) => encodeURIComponent(String(a))).join("/");
  const res = await fetch(`${url}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as { result: unknown };
  return json.result;
}

export async function redisPipeline(
  url: string,
  token: string,
  cmds: (string | number)[][]
): Promise<{ result: unknown }[]> {
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  return res.json() as Promise<{ result: unknown }[]>;
}

export function flatToObj(arr: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < arr.length - 1; i += 2) out[arr[i]] = arr[i + 1];
  return out;
}

export interface Artwork {
  id: string;
  title: string;
  artist: string;
  artistBio: string;
  nationality: string;
  date: string;
  medium: string;
  dimensions: string;
  classification: string;
  department: string;
  url: string;
  thumbnailUrl: string;
  museum?: string;
}

export async function fetchArtworkPairs(
  redisUrl: string,
  redisToken: string,
  pairs: { prefix: string; id: string }[]
): Promise<Artwork[]> {
  if (pairs.length === 0) return [];
  const cmds = pairs.map(({ prefix, id }) => ["hgetall", `${prefix}:artwork:${id}`]);
  const results = await redisPipeline(redisUrl, redisToken, cmds);
  return results
    .map((r, i) => {
      const obj = flatToObj(r.result as string[]);
      if (!obj || !obj.id) return null;
      obj.museum = pairs[i].prefix;
      return obj as Artwork;
    })
    .filter(Boolean) as Artwork[];
}

export const SINGLE_MUSEUMS = new Set(["moma", "met", "aic", "cma", "nga"]);
export const ALL_MUSEUMS = ["moma", "met", "aic", "cma", "nga"];
