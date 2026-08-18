import type * as Party from "partykit/server";
import { handleResolve, CORS } from "./resolve";
import { handleApi } from "./api";
import {
  SINGLE_MUSEUMS,
  type Artwork,
} from "./redis";

interface CurateState {
  slots: (Artwork | null)[];
  users: Record<string, string>;
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

    const cors = CORS;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // GET ?resolve=<id>&museum=<m>[&w=<px>]
    // Shared with the Cloudflare Worker; see party/resolve.ts.
    if (url.searchParams.has("resolve")) {
      return handleResolve(url.searchParams, redisUrl, redisToken);
    }

    // GET ?random / ?page / ?search -- shared with the Cloudflare Worker.
    // See party/api.ts. These routes are served from the Worker in production since
    // 2026-08-18; this path remains for local `partykit dev` and for the day PartyKit
    // is deployable again.
    {
      const res = await handleApi(url.searchParams, redisUrl, redisToken, prefix);
      if (res) return res;
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
