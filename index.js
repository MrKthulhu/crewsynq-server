// server/index.js (CommonJS)
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.static("public")); // serves /quickview.html if present

const PORT = process.env.PORT || 4000;

// Calgary default bbox: south, north, west, east
const DEFAULT_BBOX = (process.env.BBOX || "50.70,51.30,-114.40,-113.70")
  .split(",")
  .map(Number);

// Map OpenSky state vector to our simplified flight shape
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

// Simple "likely helicopter" heuristic (dev only)
function likelyHeli(f) {
  const altOk = f.altitude == null || f.altitude < 9000; // <~ 9k ft
  const spdOk = f.speed == null || f.speed < 160;        // <~ 160 kt
  return altOk && spdOk;
}

app.get("/api/heli/live", async (req, res) => {
  try {
    const bbox = (req.query.bbox || DEFAULT_BBOX.join(",")).split(",").map(Number);
    const [south, north, west, east] = bbox;

    const qs = new URLSearchParams({
      lamin: String(south),
      lamax: String(north),
      lomin: String(west),
      lomax: String(east),
    });

    const url = `https://opensky-network.org/api/states/all?${qs}`;

    // Optional OpenSky Basic Auth for slightly better limits
    const u = process.env.OPEN_SKY_USERNAME;
    const p = process.env.OPEN_SKY_PASSWORD;

    const headers = {
      "User-Agent": "CrewSynq/Dev",
      ...(u && p ? { Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") } : {}),
    };

    // Node 18+ has a global fetch; no node-fetch needed
    const r = await fetch(url, { headers });
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: "upstream", status: r.status });
    }

    const json = await r.json();
    const states = Array.isArray(json.states) ? json.states : [];

    const flights = states
      .map(toFlight)
      .filter((f) => Number.isFinite(f.latitude) && Number.isFinite(f.longitude))
      .map((f) => ({ ...f, likelyHeli: likelyHeli(f) }));

    res.json({ ok: true, count: flights.length, bbox, flights });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CrewSynq dev ADS-B proxy on http://0.0.0.0:${PORT}`);
});
