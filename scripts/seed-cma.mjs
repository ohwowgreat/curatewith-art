#!/usr/bin/env node
/**
 * seed-cma.mjs
 *
 * Seeds the Cleveland Museum of Art open access collection into Upstash Redis.
 * Uses the public CMA REST API (no key required).
 *
 * Data model (prefix: cma):
 *   cma:ids                   -> Redis List of artwork IDs
 *   cma:artwork:<id>          -> Redis Hash of artwork fields
 *   cma:search:<term>         -> Redis Set of IDs matching that term
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=https://... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed-cma.mjs
 */

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CMA_API     = "https://openaccess-api.clevelandart.org/api/artworks/";
const PREFIX      = "cma";
const PAGE_SIZE   = 100;
const CONCURRENCY = 5;
const BATCH_SIZE  = 100;

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars.");
  process.exit(1);
}

async function redisPipeline(commands) {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchWithRetry(url, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      if (!res.ok) return null;
      return res.json();
    } catch {
      if (i === retries - 1) return null;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalize(raw) {
  if (!raw || !raw.id) return null;
  const thumbnailUrl = raw.images?.web?.url || raw.images?.print?.url || "";
  if (!thumbnailUrl) return null;

  const id           = String(raw.id);
  const title        = (raw.title || "Untitled").slice(0, 300);
  const creators     = Array.isArray(raw.creators) ? raw.creators : [];
  const artist       = (creators[0]?.description || "Unknown").replace(/\([^)]*\)/g, "").trim().slice(0, 200);
  const artistBio    = creators[0]?.biography || "";
  const nationality  = creators[0]?.nationality || "";
  const date         = raw.creation_date || "";
  const medium       = (raw.technique || "").slice(0, 200);
  const dimensions   = typeof raw.dimensions === "string"
    ? raw.dimensions.slice(0, 200)
    : (raw.dimensions?.overall ? `${raw.dimensions.overall.height} × ${raw.dimensions.overall.width} cm` : "");
  const classification = raw.type || "";
  const department   = raw.department || "";
  const url          = raw.url || `https://www.clevelandart.org/art/${id}`;

  return { id, title, artist, artistBio: artistBio.slice(0, 200),
    nationality: nationality.slice(0, 100), date, medium, dimensions,
    classification, department, url, thumbnailUrl };
}

function searchTerms(artwork) {
  const terms = new Set();
  artwork.artist.toLowerCase().split(/[\s,]+/).forEach(w => { if (w.length > 2) terms.add(w); });
  if (artwork.department) {
    artwork.department.toLowerCase().split(/[\s&]+/).forEach(w => { if (w.length > 2) terms.add(w); });
  }
  const firstWord = artwork.title.toLowerCase().split(/\s+/)[0];
  if (firstWord && firstWord.length > 3) terms.add(firstWord);
  return [...terms];
}

async function main() {
  console.log("Fetching CMA artwork count...");
  const info = await fetchWithRetry(`${CMA_API}?has_image=1&limit=1`);
  if (!info) { console.error("Failed to reach CMA API."); process.exit(1); }
  const total = info.info.total;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  console.log(`Total artworks with images: ${total} (~${totalPages} pages).`);

  console.log(`Flushing old ${PREFIX}:ids list...`);
  await redisPipeline([["del", `${PREFIX}:ids`]]);

  const artworks = [];
  const skips = Array.from({ length: totalPages }, (_, i) => i * PAGE_SIZE);

  for (let i = 0; i < skips.length; i += CONCURRENCY) {
    const batch = skips.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(skip => fetchWithRetry(`${CMA_API}?has_image=1&limit=${PAGE_SIZE}&skip=${skip}`))
    );
    for (const data of results) {
      if (!data?.data) continue;
      for (const raw of data.data) {
        const art = normalize(raw);
        if (art) artworks.push(art);
      }
    }
    if ((i / CONCURRENCY) % 20 === 0) {
      console.log(`  ${Math.min(i + CONCURRENCY, skips.length)}/${totalPages} pages — ${artworks.length} artworks`);
    }
  }

  console.log(`\n${artworks.length} artworks. Writing to Redis...`);

  for (const batch of chunk(artworks, BATCH_SIZE)) {
    const commands = [];
    for (const art of batch) {
      commands.push(["hset", `${PREFIX}:artwork:${art.id}`,
        "id", art.id, "title", art.title, "artist", art.artist,
        "artistBio", art.artistBio, "nationality", art.nationality,
        "date", art.date, "medium", art.medium, "dimensions", art.dimensions,
        "classification", art.classification, "department", art.department,
        "url", art.url, "thumbnailUrl", art.thumbnailUrl]);
      commands.push(["rpush", `${PREFIX}:ids`, art.id]);
    }
    await redisPipeline(commands);
  }

  console.log("Building search index...");
  const searchMap = new Map();
  for (const art of artworks) {
    for (const term of searchTerms(art)) {
      if (!searchMap.has(term)) searchMap.set(term, []);
      searchMap.get(term).push(art.id);
    }
  }
  for (const batch of chunk([...searchMap.entries()], 50)) {
    const commands = [];
    for (const [term, ids] of batch) {
      if (ids.length < 2) continue;
      commands.push(["sadd", `${PREFIX}:search:${term}`, ...ids.slice(0, 200)]);
    }
    if (commands.length) await redisPipeline(commands);
  }

  console.log("Seed complete.");
  const total2 = await (await fetch(`${REDIS_URL}/llen/${PREFIX}:ids`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  })).json();
  console.log(`${PREFIX}:ids length: ${total2.result}`);
}

main().catch(e => { console.error(e); process.exit(1); });
