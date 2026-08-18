// The curate-together board, rebuilt as a Cloudflare Durable Object.
//
// This replaces the PartyKit room (the onConnect/onMessage/onClose trio that used to
// live in party/server.ts). It is the one piece of the site that genuinely needs
// WebSockets and room state, which is why it could not move to the stateless Worker
// with the API routes when PartyKit's custom domain died on 2026-08-18.
//
// One DO instance per room, addressed by idFromName(room) from worker.js. The wire
// protocol is unchanged from PartyKit, because public/index.html is the contract:
//   server -> client:  {type:"init", state:{slots, users}}
//                      {type:"slots", slots}
//                      {type:"users", users}
//   client -> server:  {type:"set_name", name}
//                      {type:"update_slots", slots}
//                      {type:"set_slot", slot, artwork}
//
// Differences from the PartyKit room, both deliberate:
//   - Slots persist in DO storage, so a board now survives restarts. PartyKit kept
//     them in memory and lost them whenever the room instance recycled.
//   - Uses the WebSocket hibernation API, so an idle room costs nothing; presence is
//     reconstructed from the surviving sockets' attachments on wake.

interface Artwork {
  id: string;
  title: string;
  [k: string]: unknown;
}

type Slots = (Artwork | null)[];

const EMPTY_SLOTS: Slots = [null, null, null, null];

export class CurateRoom {
  ctx: DurableObjectState;
  slots: Slots = [...EMPTY_SLOTS];

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
    // Restore persisted slots before any request is allowed in.
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<Slots>("slots");
      if (stored) this.slots = stored;
    });
  }

  /** Presence map rebuilt from the live sockets; survives hibernation. */
  users(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { id: string; name: string } | null;
      if (att) out[att.id] = att.name;
    }
    return out;
  }

  broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // A socket can die between getWebSockets() and send(); close events clean up.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const id = crypto.randomUUID();
    // Same order as the PartyKit room: init reflects the users present BEFORE this
    // connection, then the join is announced to everyone including the newcomer.
    server.serializeAttachment({ id, name: `visitor-${id.slice(0, 4)}` });
    this.ctx.acceptWebSocket(server);

    server.send(
      JSON.stringify({ type: "init", state: { slots: this.slots, users: this.users() } })
    );
    this.broadcast({ type: "users", users: this.users() });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: {
      type?: string;
      slot?: number;
      artwork?: Artwork | null;
      slots?: Slots;
      name?: string;
    };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (msg.type === "update_slots" && Array.isArray(msg.slots)) {
      this.slots = msg.slots;
      await this.ctx.storage.put("slots", this.slots);
      this.broadcast({ type: "slots", slots: this.slots });
    }

    if (msg.type === "set_slot" && msg.slot !== undefined) {
      this.slots[msg.slot] = msg.artwork ?? null;
      await this.ctx.storage.put("slots", this.slots);
      this.broadcast({ type: "slots", slots: this.slots });
    }

    if (msg.type === "set_name" && msg.name) {
      const att = ws.deserializeAttachment() as { id: string; name: string };
      ws.serializeAttachment({ ...att, name: String(msg.name).slice(0, 60) });
      this.broadcast({ type: "users", users: this.users() });
    }
  }

  webSocketClose(_ws: WebSocket) {
    this.broadcast({ type: "users", users: this.users() });
  }

  webSocketError(_ws: WebSocket) {
    this.broadcast({ type: "users", users: this.users() });
  }
}
