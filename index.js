const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const adsbAdapter = require("./adsbAdapter"); 

dotenv.config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4000;

const ADSB_CACHE = new Map();
const CACHE_TTL_MS = 30000; 

const DEFAULT_BBOX = (process.env.BBOX || "50.70,51.30,-114.40,-113.70")
  .split(",")
  .map(Number);

function parseBoundsFromQuery(q) {
  let lamin, lamax, lomin, lomax;
  const exLamin = parseFloat(q.lamin);
  const exLamax = parseFloat(q.lamax);
  const exLomin = parseFloat(q.lomin);
  const exLomax = parseFloat(q.lomax);

  if ([exLamin, exLamax, exLomin, exLomax].every(Number.isFinite)) {
    lamin = exLamin; lamax = exLamax; lomin = exLomin; lomax = exLomax;
  } else {
    const bboxStr = (q.bbox || DEFAULT_BBOX.join(",")).toString();
    [lamin, lamax, lomin, lomax] = bboxStr.split(",").map(Number);
  }
  
  const key = [lamin, lamax, lomin, lomax].map(n => n.toFixed(2)).join(',');
  return { lamin, lamax, lomin, lomax, key };
}

// --- NEW ENDPOINT FOR APP UPDATES ---
app.get("/api/version", (req, res) => {
  const version = process.env.APP_VERSION || "1.0.0";
  res.json({ version });
});

app.get("/api/heli/live", async (req, res) => {
  try {
    const b = parseBoundsFromQuery(req.query);
    const now = Date.now();
    const cached = ADSB_CACHE.get(b.key);

    if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
      return res.json(cached.payload);
    }

    const { time, flights } = await adsbAdapter.fetchFlightStates(b);
    const payload = {
      ok: true, time, count: flights.length,
      bbox: [b.lamin, b.lamax, b.lomin, b.lomax],
      flights,
    };

    ADSB_CACHE.set(b.key, { timestamp: now, payload });
    res.json(payload);

  } catch (e) {
    console.error("ADS-B route error:", e?.message || e);
    res.status(502).json({
      ok: false, error: "upstream_failure",
      detail: String(e?.message || e),
    });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CrewSynq ADS-B proxy (adsb.fi) on http://0.0.0.0:${PORT}`);
  console.log(`Cache TTL set to ${CACHE_TTL_MS / 1000} seconds.`);
});

