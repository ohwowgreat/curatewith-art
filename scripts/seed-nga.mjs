#!/usr/bin/env node
/**
 * seed-nga.mjs
 *
 * Seeds the National Gallery of Art (US) public domain collection into Upstash Redis.
 * Streams bulk CSV data from the NGA opendata GitHub repo (no key required).
 * Uses line-by-line streaming to avoid loading large CSVs into memory.
 *
 * Data model (prefix: nga):
 *   nga:ids                   -> Redis List of artwork IDs
 *   nga:artwork:<id>          -> Redis Hash of artwork fields
 *   nga:search:<term>         -> Redis Set of IDs matching that term
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=https://... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed-nga.mjs
 */

import https from "https";
import { createInterface } from "readline";
import { Readable } from "stream";

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PREFIX      = "nga";
const BATCH_SIZE  = 100;

const OBJECTS_CSV = "https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/objects.csv";
const IMAGES_CSV  = "https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/published_images.csv";

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

// Stream a CSV from URL line by line, calling onRow(headers, values) for each data row
function streamCSV(url, onRow) {
  return new Promise((resolve, reject) => {
    function request(targetUrl) {
      https.get(targetUrl, { headers: { "User-Agent": "open-archive/1.0" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
        }

        let headers = null;
        let rowCount = 0;
        const rl = createInterface({ input: res, crlfDelay: Infinity });

        rl.on("line", (line) => {
          if (!line.trim()) return;
          const values = parseCSVRow(line);
          if (!headers) {
            headers = values.map(h => h.trim());
            return;
          }
          const obj = {};
          headers.forEach((h, i) => { obj[h] = values[i] ?? ""; });
          onRow(obj);
          rowCount++;
        });

        rl.on("close", () => resolve(rowCount));
        rl.on("error", reject);
        res.on("error", reject);
      }).on("error", reject);
    }
    request(url);
  });
}

function parseCSVRow(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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

const DEPT_MAP = {
  "DCAM": "American and British Paintings",
  "DCEF": "French and British Paintings",
  "DCGM": "German and Flemish Paintings",
  "DCIT": "Italian and Spanish Paintings",
  "DCN":  "Northern European Paintings",
  "DCPH": "Photographs",
  "DCPG": "Prints and Drawings",
  "DCSM": "Sculpture and Decorative Arts",
};

async function main() {
  // Pass 1: stream published_images.csv into a Map (objectid -> thumbnailUrl)
  console.log("Streaming NGA published_images.csv...");
  const imageMap = new Map();
  const imgCount = await streamCSV(IMAGES_CSV, (row) => {
    const objId = row.depictstmsobjectid?.trim();
    if (!objId || imageMap.has(objId)) return;
    if (row.openaccess?.trim() !== "1") return; // only open access images
    const thumb = row.iiifthumburl?.trim();      // lowercase header
    if (thumb) imageMap.set(objId, thumb);
  });
  console.log(`  ${imgCount} image rows read, ${imageMap.size} unique objects have images.`);

  // Pass 2: stream objects.csv, join with imageMap, collect artworks
  console.log("Streaming NGA objects.csv...");
  const artworks = [];
  let objCount = 0;
  await streamCSV(OBJECTS_CSV, (row) => {
    objCount++;
    const id = row.objectid?.trim();
    if (!id) return;
    const thumbnailUrl = imageMap.get(id); // presence means open access
    if (!thumbnailUrl) return;

    const dept = row.departmentabbr?.trim() || "";
    artworks.push({
      id,
      title:          (row.title || "Untitled").trim().slice(0, 300),
      artist:         (row.attribution || "Unknown").trim().slice(0, 200),
      artistBio:      "",
      nationality:    "",
      date:           (row.displaydate || "").trim(),
      medium:         (row.medium || "").trim().slice(0, 200),
      dimensions:     (row.dimensions || "").trim().slice(0, 200),
      classification: (row.classification || "").trim(),
      department:     DEPT_MAP[dept] || dept,
      url:            `https://www.nga.gov/collection/art-object-page.${id}.html`,
      thumbnailUrl,
    });
  });
  console.log(`  ${objCount} object rows read, ${artworks.length} public domain artworks with images.`);

  console.log(`Flushing old ${PREFIX}:ids list...`);
  await redisPipeline([["del", `${PREFIX}:ids`]]);

  console.log("Writing to Redis...");
  let done = 0;
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
    done += batch.length;
    if (done % 2000 === 0) console.log(`  ${done} / ${artworks.length} written`);
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
  const total = await (await fetch(`${REDIS_URL}/llen/${PREFIX}:ids`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  })).json();
  console.log(`${PREFIX}:ids length: ${total.result}`);
}

main().catch(e => { console.error(e); process.exit(1); });
