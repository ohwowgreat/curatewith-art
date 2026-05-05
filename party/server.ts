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
}

interface CurateState {
  slots: (Artwork | null)[];
  users: Record<string, string>;
}

const ALLOWED_MUSEUMS = new Set(["moma", "met", "aic", "cma", "nga"]);

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
    const prefix = ALLOWED_MUSEUMS.has(museumParam)
      ? museumParam
      : ((this.room.env.MUSEUM_PREFIX as string | undefined) ?? "moma");

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // GET ?page=N&limit=N
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

      const pipeline = ids.map((id) => ["hgetall", `${prefix}:artwork:${id}`]);
      const res = await fetch(`${redisUrl}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(pipeline),
      });
      const results = (await res.json()) as { result: string[] }[];
      const artworks = results.map((r) => flatToObj(r.result)).filter((r) => r && r.id);
      return new Response(JSON.stringify({ artworks }), { headers: cors });
    }

    // GET ?random=N
    if (url.searchParams.has("random")) {
      const n = parseInt(url.searchParams.get("random") ?? "4");
      const total = (await redisCmd(redisUrl, redisToken, "llen", `${prefix}:ids`)) as number;

      const indices = new Set<number>();
      while (indices.size < Math.min(n, total)) {
        indices.add(Math.floor(Math.random() * total));
      }

      const pipeline = [...indices].map((i) => ["lindex", `${prefix}:ids`, i]);
      const idsRes = await fetch(`${redisUrl}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(pipeline),
      });
      const idsData = (await idsRes.json()) as { result: string }[];
      const ids = idsData.map((r) => r.result).filter(Boolean);

      const pipeline2 = ids.map((id) => ["hgetall", `${prefix}:artwork:${id}`]);
      const res2 = await fetch(`${redisUrl}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(pipeline2),
      });
      const results2 = (await res2.json()) as { result: string[] }[];
      const artworks = results2.map((r) => flatToObj(r.result)).filter((r) => r && r.id);
      return new Response(JSON.stringify({ artworks }), { headers: cors });
    }

    // GET ?search=Q
    if (url.searchParams.has("search")) {
      const q = url.searchParams.get("search")!.toLowerCase();
      const ids = (await redisCmd(
        redisUrl, redisToken, "smembers", `${prefix}:search:${q}`
      )) as string[];

      if (!ids || ids.length === 0)
        return new Response(JSON.stringify({ artworks: [] }), { headers: cors });

      const pipeline = ids.slice(0, 30).map((id) => ["hgetall", `${prefix}:artwork:${id}`]);
      const res = await fetch(`${redisUrl}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(pipeline),
      });
      const results = (await res.json()) as { result: string[] }[];
      const artworks = results.map((r) => flatToObj(r.result)).filter((r) => r && r.id);
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
