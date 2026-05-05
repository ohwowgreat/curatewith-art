#!/usr/bin/env node
/**
 * seed-met.mjs
 *
 * Seeds the Met Museum's public domain collection into Upstash Redis.
 *
 * Data model (prefix: met):
 *   met:ids                   -> Redis List of artwork IDs
 *   met:artwork:<id>          -> Redis Hash of artwork fields
 *   met:search:<term>         -> Redis Set of IDs matching that term
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=https://... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed-met.mjs
 */

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const MET_API     = "https://collectionapi.metmuseum.org/public/collection/v1";
const PREFIX      = "met";
const CONCURRENCY = 25;
const BATCH_SIZE  = 100;

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars.");
  process.exit(1);
}

async function redisPipeline(commands) {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Redis pipeline error ${res.status}: ${t}`);
  }
  return res.json();
}

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      if (!res.ok) return null;
      return res.json();
    } catch {
      if (i === retries - 1) return null;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
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
  if (!raw || !raw.objectID) return null;
  const thumbnailUrl = raw.primaryImageSmall || raw.primaryImage || "";
  if (!thumbnailUrl) return null; // skip artworks without images

  const id             = String(raw.objectID);
  const title          = (raw.title || "Untitled").slice(0, 300);
  const artist         = (raw.artistDisplayName || "Unknown").slice(0, 200);
  const artistBio      = (raw.artistDisplayBio || "").slice(0, 200);
  const nationality    = (raw.artistNationality || "").slice(0, 100);
  const date           = raw.objectDate || raw.objectBeginDate || "";
  const medium         = (raw.medium || "").slice(0, 200);
  const dimensions     = (raw.dimensions || "").slice(0, 200);
  const classification = (raw.classification || "").slice(0, 100);
  const department     = raw.department || "";
  const url            = raw.objectURL || `https://www.metmuseum.org/art/collection/search/${id}`;

  return { id, title, artist, artistBio, nationality, date, medium,
    dimensions, classification, department, url, thumbnailUrl };
}

function searchTerms(artwork) {
  const terms = new Set();
  artwork.artist.toLowerCase().split(/[\s,]+/).forEach(w => {
    if (w.length > 2) terms.add(w);
  });
  if (artwork.department) {
    artwork.department.toLowerCase().split(/[\s&]+/).forEach(w => {
      if (w.length > 2) terms.add(w);
    });
  }
  const firstWord = artwork.title.toLowerCase().split(/\s+/)[0];
  if (firstWord && firstWord.length > 3) terms.add(firstWord);
  return [...terms];
}

async function processConcurrent(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function main() {
  console.log("Fetching public domain object IDs from Met Museum API...");
  const idsData = await fetchWithRetry(`${MET_API}/objects?isPublicDomain=true`);
  if (!idsData || !idsData.objectIDs) {
    console.error("Failed to fetch object IDs.");
    process.exit(1);
  }

  const allIds = idsData.objectIDs;
  console.log(`Got ${allIds.length} public domain object IDs. Fetching details...`);

  // Clear old data
  console.log(`Flushing old ${PREFIX}:ids list...`);
  await redisPipeline([["del", `${PREFIX}:ids`]]);

  const artworks = [];
  let fetched = 0;
  let skipped = 0;

  const idChunks = chunk(allIds, CONCURRENCY);
  for (const idBatch of idChunks) {
    const results = await Promise.all(
      idBatch.map(id => fetchWithRetry(`${MET_API}/objects/${id}`))
    );

    for (const raw of results) {
      fetched++;
      const art = normalize(raw);
      if (art) {
        artworks.push(art);
      } else {
        skipped++;
      }
    }

    if (fetched % 500 === 0) {
      console.log(`  fetched ${fetched} / ${allIds.length} — ${artworks.length} with images`);
    }
  }

  console.log(`\nFetched ${fetched} objects, ${artworks.length} have images, ${skipped} skipped.`);
  console.log("Writing to Redis...");

  const batches = chunk(artworks, BATCH_SIZE);
  let done = 0;

  for (const batch of batches) {
    const commands = [];
    for (const art of batch) {
      commands.push([
        "hset",
        `${PREFIX}:artwork:${art.id}`,
        "id",             art.id,
        "title",          art.title,
        "artist",         art.artist,
        "artistBio",      art.artistBio,
        "nationality",    art.nationality,
        "date",           art.date,
        "medium",         art.medium,
        "dimensions",     art.dimensions,
        "classification", art.classification,
        "department",     art.department,
        "url",            art.url,
        "thumbnailUrl",   art.thumbnailUrl,
      ]);
      commands.push(["rpush", `${PREFIX}:ids`, art.id]);
    }
    await redisPipeline(commands);
    done += batch.length;
    if (done % 1000 === 0) console.log(`  ${done} / ${artworks.length} written`);
  }

  console.log("Building search index...");
  const searchMap = new Map();
  for (const art of artworks) {
    for (const term of searchTerms(art)) {
      if (!searchMap.has(term)) searchMap.set(term, []);
      searchMap.get(term).push(art.id);
    }
  }

  console.log(`  ${searchMap.size} search terms. Writing...`);
  const termBatches = chunk([...searchMap.entries()], 50);
  for (const batch of termBatches) {
    const commands = [];
    for (const [term, ids] of batch) {
      if (ids.length < 2) continue;
      commands.push(["sadd", `${PREFIX}:search:${term}`, ...ids.slice(0, 200)]);
    }
    if (commands.length) await redisPipeline(commands);
  }

  console.log("Seed complete.");
  const total = await (await fetch(`${REDIS_URL}/llen/${PREFIX}:ids`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  })).json();
  console.log(`${PREFIX}:ids list length: ${total.result}`);
}

main().catch(e => { console.error(e); process.exit(1); });
