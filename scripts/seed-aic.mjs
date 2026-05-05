#!/usr/bin/env node
/**
 * seed-aic.mjs
 *
 * Seeds the Art Institute of Chicago collection into Upstash Redis.
 * Uses the public AIC REST API (no key required).
 *
 * Data model (prefix: aic):
 *   aic:ids                   -> Redis List of artwork IDs
 *   aic:artwork:<id>          -> Redis Hash of artwork fields
 *   aic:search:<term>         -> Redis Set of IDs matching that term
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=https://... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed-aic.mjs
 */

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AIC_API     = "https://api.artic.edu/api/v1/artworks";
const FIELDS      = "id,title,artist_display,date_display,medium_display,dimensions,department_title,image_id,artwork_type_title,place_of_origin";
const PREFIX      = "aic";
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
      const res = await fetch(url, { headers: { "User-Agent": "open-archive/1.0" } });
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
  if (!raw || !raw.id || !raw.image_id) return null;
  const id           = String(raw.id);
  const thumbnailUrl = `https://www.artic.edu/iiif/2/${raw.image_id}/full/400,/0/default.jpg`;
  const title        = (raw.title || "Untitled").slice(0, 300);
  const artist       = (raw.artist_display || "Unknown").replace(/\n/g, " ").slice(0, 200);
  const date         = raw.date_display || "";
  const medium       = (raw.medium_display || "").slice(0, 200);
  const dimensions   = (raw.dimensions || "").slice(0, 200);
  const classification = raw.artwork_type_title || "";
  const department   = raw.department_title || "";
  const nationality  = raw.place_of_origin || "";
  const url          = `https://www.artic.edu/artworks/${id}`;
  return { id, title, artist, artistBio: "", nationality, date, medium,
    dimensions, classification, department, url, thumbnailUrl };
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
  console.log("Fetching AIC artwork count...");
  const info = await fetchWithRetry(`${AIC_API}?fields=id&limit=1`);
  if (!info) { console.error("Failed to reach AIC API."); process.exit(1); }
  const total = info.pagination.total;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  console.log(`Total artworks: ${total} (~${totalPages} pages). Fetching...`);

  console.log(`Flushing old ${PREFIX}:ids list...`);
  await redisPipeline([["del", `${PREFIX}:ids`]]);

  const artworks = [];
  const pageNums = Array.from({ length: totalPages }, (_, i) => i + 1);

  for (let i = 0; i < pageNums.length; i += CONCURRENCY) {
    const batch = pageNums.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(page => fetchWithRetry(`${AIC_API}?fields=${FIELDS}&limit=${PAGE_SIZE}&page=${page}`))
    );
    for (const data of results) {
      if (!data?.data) continue;
      for (const raw of data.data) {
        const art = normalize(raw);
        if (art) artworks.push(art);
      }
    }
    if ((i / CONCURRENCY) % 20 === 0) {
      console.log(`  pages ${i}–${i + CONCURRENCY} done — ${artworks.length} with images so far`);
    }
    await new Promise(r => setTimeout(r, 100)); // gentle rate limiting
  }

  console.log(`\n${artworks.length} artworks with images. Writing to Redis...`);

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
