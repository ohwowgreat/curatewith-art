import type * as Party from "partykit/server";

async function redisCmd(
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

async function redisPipeline(
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

function flatToObj(arr: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < arr.length - 1; i += 2) out[arr[i]] = arr[i + 1];
  return out;
}

interface Artwork {
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

interface CurateState {
  slots: (Artwork | null)[];
  users: Record<string, string>;
}

const SINGLE_MUSEUMS = new Set(["moma", "met", "aic", "cma", "nga"]);
const ALL_MUSEUMS = ["moma", "met", "aic", "cma", "nga"];

async function fetchArtworkPairs(
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

export default class GalleryServer implements Party.Server {
  state: CurateState = {
    slots: [null, null, null, null],
    users: {},
  };

  constructor(readonly room: Party.Room) {}

  async onRequest(req: Party.Request): Promise<Response> {
    const url = new URL(req.url);
    const redisUrl = this.room.env.UPSTASH_REDIS_REST_URL as string;
    const redisToken = this.room.env.UPSTASH_REDIS_REST_TOKEN as string;

    const museumParam = url.searchParams.get("museum") ?? "";
    const isAll = museumParam === "all";
    const prefix = SINGLE_MUSEUMS.has(museumParam)
      ? museumParam
      : ((this.room.env.MUSEUM_PREFIX as string | undefined) ?? "moma");

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // GET ?random=N
    if (url.searchParams.has("random")) {
      const n = parseInt(url.searchParams.get("random") ?? "4");
      const prefixes = isAll ? ALL_MUSEUMS : [prefix];
      const perMuseum = Math.max(1, Math.ceil(n / prefixes.length));

      const totals = await Promise.all(
        prefixes.map((p) => redisCmd(redisUrl, redisToken, "llen", `${p}:ids`) as Promise<number>)
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

      if (indexCmds.length === 0)
        return new Response(JSON.stringify({ artworks: [] }), { headers: cors });

      const idsData = await redisPipeline(redisUrl, redisToken, indexCmds);
      const pairs = idsData
        .map((r, i) =>
          r.result ? { prefix: indexPrefixes[i], id: r.result as string } : null
        )
        .filter(Boolean) as { prefix: string; id: string }[];

      const artworks = await fetchArtworkPairs(redisUrl, redisToken, pairs);
      return new Response(JSON.stringify({ artworks }), { headers: cors });
    }

    // GET ?page=N&limit=N  (single museum only)
    if (url.searchParams.has("page")) {
      const page = parseInt(url.searchParams.get("page") ?? "1");
      const limit = parseInt(url.searchParams.get("limit") ?? "24");
      const start = (page - 1) * limit;
      const end = start + limit - 1;

      const ids = (await redisCmd(
        redisUrl, redisToken, "lrange", `${prefix}:ids`, start, end
      )) as string[];

      if (!ids || ids.length === 0)
        return new Response(JSON.stringify({ artworks: [] }), { headers: cors });

      const pairs = ids.map((id) => ({ prefix, id }));
      const artworks = await fetchArtworkPairs(redisUrl, redisToken, pairs);
      return new Response(JSON.stringify({ artworks }), { headers: cors });
    }

    // GET ?search=Q
    if (url.searchParams.has("search")) {
      const q = url.searchParams.get("search")!.toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const prefixes = isAll ? ALL_MUSEUMS : [prefix];
      const limitPerMuseum = isAll ? 6 : 30;

      const idSets = await Promise.all(
        prefixes.map((p) => {
          const keys = words.map((w) => `${p}:search:${w}`);
          const cmd = keys.length === 1
            ? redisCmd(redisUrl, redisToken, "smembers", keys[0])
            : redisCmd(redisUrl, redisToken, "sinter", ...keys);
          return cmd as Promise<string[] | null>;
        })
      );

      const pairs: { prefix: string; id: string }[] = [];
      idSets.forEach((ids, i) => {
        if (!ids || ids.length === 0) return;
        ids.slice(0, limitPerMuseum).forEach((id) =>
          pairs.push({ prefix: prefixes[i], id })
        );
      });

      if (pairs.length === 0)
        return new Response(JSON.stringify({ artworks: [] }), { headers: cors });

      const artworks = await fetchArtworkPairs(redisUrl, redisToken, pairs);
      return new Response(JSON.stringify({ artworks }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: "unknown route" }), {
      status: 400,
      headers: cors,
    });
  }

  onConnect(conn: Party.Connection) {
    conn.send(JSON.stringify({ type: "init", state: this.state }));
    this.state.users[conn.id] = `visitor-${conn.id.slice(0, 4)}`;
    this.room.broadcast(JSON.stringify({ type: "users", users: this.state.users }));
  }

  onClose(conn: Party.Connection) {
    delete this.state.users[conn.id];
    this.room.broadcast(JSON.stringify({ type: "users", users: this.state.users }));
  }

  onMessage(message: string, sender: Party.Connection) {
    const msg = JSON.parse(message) as {
      type: string;
      slot?: number;
      artwork?: Artwork | null;
      slots?: (Artwork | null)[];
      name?: string;
    };

    if (msg.type === "update_slots" && Array.isArray(msg.slots)) {
      this.state.slots = msg.slots;
      this.room.broadcast(JSON.stringify({ type: "slots", slots: this.state.slots }));
    }

    if (msg.type === "set_slot" && msg.slot !== undefined) {
      this.state.slots[msg.slot] = msg.artwork ?? null;
      this.room.broadcast(JSON.stringify({ type: "slots", slots: this.state.slots }));
    }

    if (msg.type === "set_name" && msg.name) {
      this.state.users[sender.id] = msg.name;
      this.room.broadcast(JSON.stringify({ type: "users", users: this.state.users }));
    }
  }
}
