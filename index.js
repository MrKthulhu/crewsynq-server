// server/index.js (CommonJS)
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.static("public")); // provides /quickview.html if present

const PORT = process.env.PORT || 4000;

// Calgary default bbox: south, north, west, east
const DEFAULT_BBOX = (process.env.BBOX || "50.70,51.30,-114.40,-113.70")
  .split(",")
  .map(Number);

// OpenSky OAuth2 (client credentials) 
const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

let cachedToken = null;
let tokenExpiresAt = 0; 

async function getOpenSkyToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }
  const id = process.env.OPEN_SKY_CLIENT_ID;
  const secret = process.env.OPEN_SKY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("Missing OPEN_SKY_CLIENT_ID/OPEN_SKY_CLIENT_SECRET");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: id,
    client_secret: secret,
  });

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`OpenSky token ${r.status}: ${text || r.statusText}`);
  }

  const json = await r.json();
  cachedToken = json.access_token;
  const ttl = Number(json.expires_in ?? 1800); // ~30 min
  tokenExpiresAt = now + ttl * 1000;
  return cachedToken;
}

// Upstream fetch helper  
function parseBoundsFromQuery(q) {
  // Prefer explicit lamin/lamax/lomin/lomax
  const lamin = parseFloat(q.lamin);
  const lamax = parseFloat(q.lamax);
  const lomin = parseFloat(q.lomin);
  const lomax = parseFloat(q.lomax);

  if ([lamin, lamax, lomin, lomax].every(Number.isFinite)) {
    return { lamin, lamax, lomin, lomax, key: `${lamin},${lamax},${lomin},${lomax}` };
  }

  // Fallback: bbox=south,north,west,east
  const bboxStr = (q.bbox || DEFAULT_BBOX.join(",")).toString();
  const [south, north, west, east] = bboxStr.split(",").map(Number);
  return {
    lamin: south,
    lamax: north,
    lomin: west,
    lomax: east,
    key: `${south},${north},${west},${east}`,
  };
}

async function fetchOpenSkyStates({ lamin, lamax, lomin, lomax, timeoutMs = 15000, retries = 1 }) {
  const qs = new URLSearchParams({
    lamin: String(lamin),
    lamax: String(lamax),
    lomin: String(lomin),
    lomax: String(lomax),
  });

  const url = `https://opensky-network.org/api/states/all?${qs.toString()}`;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const token = await getOpenSkyToken();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);

      const r = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "CrewSynq/Dev",
        },
        signal: ctrl.signal,
      });

      clearTimeout(t);

      // If token expired mid-flight, retry once
      if (r.status === 401 && attempt < retries) {
        await new Promise((res) => setTimeout(res, 300));
        continue;
      }

      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`OpenSky ${r.status}: ${text || r.statusText}`);
      }

      const json = await r.json();
      const states = Array.isArray(json.states) ? json.states : [];
      return { time: json.time ?? Math.floor(Date.now() / 1000), states };
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await new Promise((res) => setTimeout(res, Math.min(1000 * 2 ** attempt, 8000)));
    }
  }
  throw lastErr;
}

// Small in-memory cache for /api/adsb 
const ADSB_CACHE = new Map(); // key=bboxKey -> { at, payload }
const CACHE_MS = 5000;
// SOLMS
// Mapping to your flights shape
function toFlight(s) {
  const m2ft = (m) => (m == null ? null : Math.round(m * 3.28084));
  const ms2kt = (m) => (m == null ? null : Math.round(m * 1.94384));
  return {
    callsign: (s[1] || "").trim() || s[0],
    type: "other",
    latitude: s[6],
    longitude: s[5],
    altitude: m2ft(s[13] ?? s[7]),
    speed: ms2kt(s[9]),
    heading: s[10],
    status: s[8] ? "landed" : "active",
    agency: null,
    last_seen: new Date((s[4] || s[3] || 0) * 1000).toISOString(),
    icao24: s[0],
  };
}
function likelyHeli(f) {
  const altOk = f.altitude == null || f.altitude < 9000; // <~ 9k ft
  const spdOk = f.speed == null || f.speed < 160;        // <~ 160 kt
  return altOk && spdOk;
}

// Routes 

app.get("/api/adsb", async (req, res) => {
  try {
    const b = parseBoundsFromQuery(req.query);
    const now = Date.now();
    const cached = ADSB_CACHE.get(b.key);
    if (cached && now - cached.at < CACHE_MS) {
      return res.json(cached.payload);
    }

    const payload = await fetchOpenSkyStates(b);
    ADSB_CACHE.set(b.key, { at: now, payload });
    res.json(payload);
  } catch (e) {
    console.error("ADS-B route error:", e?.message || e);
    res.status(502).json({ error: "Upstream failure", detail: String(e?.message || e) });
  }
});

// Back-compat: your previous route, now backed by the same upstream call
app.get("/api/heli/live", async (req, res) => {
  try {
    const b = parseBoundsFromQuery(req.query);
    const { time, states } = await fetchOpenSkyStates(b);
    const flights = states
      .map(toFlight)
      .filter((f) => Number.isFinite(f.latitude) && Number.isFinite(f.longitude))
      .map((f) => ({ ...f, likelyHeli: likelyHeli(f) }));

    res.json({ ok: true, time, count: flights.length, bbox: [b.lamin, b.lamax, b.lomin, b.lomax], flights });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: "upstream_failure", detail: String(e?.message || e) });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CrewSynq dev ADS-B proxy on http://0.0.0.0:${PORT}`);
});
