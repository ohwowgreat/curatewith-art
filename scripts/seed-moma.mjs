#!/usr/bin/env node
/**
 * seed.mjs
 *
 * Downloads MoMA Artworks.json from GitHub and indexes it into Upstash Redis.
 *
 * Data model:
 *   moma:ids                   -> Redis List of all artwork IDs (for paged browsing)
 *   moma:artwork:<id>          -> Redis Hash of artwork fields
 *   moma:search:<term>         -> Redis Set of IDs matching that term (artist name words, dept)
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=https://... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed.mjs
 *
 * The script only indexes artworks that have a MoMA URL (i.e. are on the public site).
 * That gives ~80k records. It runs in batches to stay within Upstash pipeline limits.
 */

import https from "https";

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const MOMA_JSON   = "https://media.githubusercontent.com/media/MuseumofModernArt/collection/main/Artworks.json";

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars.");
  process.exit(1);
}

// Fetch helpers
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

// Download JSON from URL (follows redirects)
function downloadJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "moma-gallery-seed/1.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(downloadJSON(res.headers.location));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Chunk array into batches
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Normalize MoMA artwork record into our flat hash
function normalize(raw) {
  const id = String(raw.ObjectID ?? raw.id ?? "");
  if (!id) return null;

  const url          = raw.URL ?? `https://www.moma.org/collection/works/${id}`;
  const thumbnailUrl = raw.ImageURL ?? "";

  const artists    = Array.isArray(raw.Artist) ? raw.Artist.join(", ") : (raw.Artist ?? "Unknown");
  const artistBio  = Array.isArray(raw.ArtistBio) ? raw.ArtistBio.join(", ") : (raw.ArtistBio ?? "");
  const nationality= Array.isArray(raw.Nationality) ? raw.Nationality.join(", ") : (raw.Nationality ?? "");
  const date       = raw.Date ?? raw.DateAcquired ?? "";
  const medium     = (raw.Medium ?? "").slice(0, 200);
  const dept       = raw.Department ?? "";
  const title      = (raw.Title ?? "Untitled").slice(0, 300);
  const dimensions = (raw.Dimensions ?? "").slice(0, 200);
  const classification = raw.Classification ?? "";

  return { id, title, artist: artists.slice(0, 200), artistBio: artistBio.slice(0, 200),
    nationality: nationality.slice(0, 100), date, medium, department: dept,
    dimensions, classification, url, thumbnailUrl };
}

// Extract search terms from an artwork (artist words + department)
function searchTerms(artwork) {
  const terms = new Set();
  // Artist words
  artwork.artist.toLowerCase().split(/[\s,]+/).forEach((w) => {
    if (w.length > 2) terms.add(w);
  });
  // Department
  if (artwork.department) {
    artwork.department.toLowerCase().split(/[\s&]+/).forEach((w) => {
      if (w.length > 2) terms.add(w);
    });
  }
  // Title first word
  const firstWord = artwork.title.toLowerCase().split(/\s+/)[0];
  if (firstWord && firstWord.length > 3) terms.add(firstWord);
  return [...terms];
}

async function main() {
  console.log("Downloading MoMA Artworks.json from GitHub...");
  const raw = await downloadJSON(MOMA_JSON);
  console.log(`Downloaded ${raw.length} records.`);

  // Filter to records that have an ObjectID
  const artworks = raw
    .map(normalize)
    .filter(Boolean)
    .filter((a) => a.id);

  console.log(`${artworks.length} valid artworks. Seeding Redis...`);

  // Clear old data
  console.log("Flushing old moma:ids list...");
  await redisPipeline([["del", "moma:ids"]]);

  // Process in batches of 100
  const batches = chunk(artworks, 100);
  let done = 0;

  for (const batch of batches) {
    const commands = [];

    for (const art of batch) {
      // Store hash
      commands.push([
        "hset",
        `moma:artwork:${art.id}`,
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
      // Append to ID list
      commands.push(["rpush", "moma:ids", art.id]);
    }

    await redisPipeline(commands);
    done += batch.length;

    if (done % 1000 === 0) {
      console.log(`  ${done} / ${artworks.length}`);
    }
  }

  console.log("Building search index...");

  // Build search index in separate pass (smaller sets to avoid mem pressure)
  const searchMap = new Map(); // term -> [id, ...]

  for (const art of artworks) {
    for (const term of searchTerms(art)) {
      if (!searchMap.has(term)) searchMap.set(term, []);
      searchMap.get(term).push(art.id);
    }
  }

  console.log(`  ${searchMap.size} search terms. Writing...`);

  const termEntries = [...searchMap.entries()];
  const termBatches = chunk(termEntries, 50);

  for (const batch of termBatches) {
    const commands = [];
    for (const [term, ids] of batch) {
      // Only index terms with at least 2 matches (avoids huge memory for rare terms)
      if (ids.length < 2) continue;
      // Cap at 200 IDs per term to keep set sizes manageable
      commands.push(["sadd", `moma:search:${term}`, ...ids.slice(0, 200)]);
    }
    if (commands.length) await redisPipeline(commands);
  }

  console.log("Seed complete.");
  const total = await (await fetch(`${REDIS_URL}/llen/moma:ids`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  })).json();
  console.log(`moma:ids list length: ${total.result}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
