const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const adsbAdapter = require("./adsbAdapter"); // <-- IMPORT OUR NEW ADAPTER

dotenv.config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4000;

// Calgary default bbox: south, north, west, east
// This is unchanged and still used.
const DEFAULT_BBOX = (process.env.BBOX || "50.70,51.30,-114.40,-113.70")
  .split(",")
  .map(Number);

/**
 * This helper function is unchanged. It works perfectly.
 */
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

// Routes
app.get("/api/heli/live", async (req, res) => {
  try {
    // 1. Parse bounds just like before
    const b = parseBoundsFromQuery(req.query);

    // 2. Call the adapter instead of OpenSky.
    // The adapter handles all the fetching, math, and data mapping.
    const { time, flights } = await adsbAdapter.fetchFlightStates(b);

    // 3. Send the pre-formatted response.
    res.json({
      ok: true,
      time,
      count: flights.length,
      bbox: [b.lamin, b.lamax, b.lomin, b.lomax],
      flights, // This array is already perfectly formatted by the adapter
    });
  } catch (e) {
    console.error("ADS-B route error:", e?.message || e);
    // Send the same upstream failure error as before
    res.status(502).json({
      ok: false,
      error: "upstream_failure",
      detail: String(e?.message || e),
    });
  }
});

/**
 * Health check route. Unchanged.
 */
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CrewSynq ADS-B proxy (adsb.fi) on http://0.0.0.0:${PORT}`);
});
