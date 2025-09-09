const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const adsbAdapter = require("./adsbAdapter");

dotenv.config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4000;

// Dynamic Regional Caching Logic
// This cache will store data for different geographic regions as users make requests.
const REGIONAL_CACHE = new Map();
const CACHE_TTL_MS = 30000; // 30 seconds

function getRegionalBbox(centerLat, centerLon) {
  const radiusKm = 50; // Fetch data in a 50km radius (100km wide box)
  const latOffset = radiusKm / 111.0; // Simple approximation for latitude degrees
  const lonOffset = radiusKm / (111.32 * Math.cos(centerLat * (Math.PI / 180)));

  return {
    lamin: centerLat - latOffset,
    lamax: centerLat + latOffset,
    lomin: centerLon - lonOffset,
    lomax: centerLon + lonOffset,
  };
}


// API Routes 

app.get("/api/version", (req, res) => {
  const version = process.env.APP_VERSION || "1.0.0";
  res.json({ version });
});

app.get("/api/heli/live", async (req, res) => {
  try {
    // 1. Get the user's specific bounding box from the request
    const south = parseFloat(req.query.lamin) || parseFloat(req.query.bbox?.split(',')[0]) || 51.04;
    const north = parseFloat(req.query.lamax) || parseFloat(req.query.bbox?.split(',')[1]) || 51.05;
    const west = parseFloat(req.query.lomin) || parseFloat(req.query.bbox?.split(',')[2]) || -114.07;
    const east = parseFloat(req.query.lomax) || parseFloat(req.query.bbox?.split(',')[3]) || -114.08;

    // 2. Create a regional cache key by rounding the center of the user's view.
    const centerLat = (south + north) / 2;
    const centerLon = (west + east) / 2;
    const regionalKey = `${centerLat.toFixed(1)},${centerLon.toFixed(1)}`;

    // 3. Check if we have fresh data for this region.
    const now = Date.now();
    const cached = REGIONAL_CACHE.get(regionalKey);
    let regionalFlights = [];

    if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
      // Use the cached data for this region.
      regionalFlights = cached.flights;
    } else {
      // If no fresh data, fetch it for the entire region.
      console.log(`Cache miss for region ${regionalKey}. Fetching new data...`);
      const regionalBbox = getRegionalBbox(centerLat, centerLon);
      const { flights } = await adsbAdapter.fetchFlightStates(regionalBbox);
      REGIONAL_CACHE.set(regionalKey, { timestamp: now, flights });
      regionalFlights = flights;
      console.log(`Cached ${flights.length} flights for region ${regionalKey}.`);
    }

    // 4. Filter the regional data to what's in the user's specific viewport.
    const visibleFlights = regionalFlights.filter(f => 
      f.latitude >= south && f.latitude <= north &&
      f.longitude >= west && f.longitude <= east
    );

    const payload = {
      ok: true,
      time: Math.floor((cached?.timestamp || now) / 1000),
      count: visibleFlights.length,
      bbox: [south, north, west, east],
      flights: visibleFlights,
    };
    
    res.json(payload);

  } catch (e) {
    console.error("ADS-B route error:", e?.message || e);
    res.status(500).json({
      ok: false,
      error: "internal_server_error",
      detail: String(e?.message || e),
    });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CrewSynq ADS-B proxy (adsb.fi) on http://0.0.0.0:${PORT}`);
  console.log(`Dynamic regional cache enabled. TTL: ${CACHE_TTL_MS / 1000} seconds.`);
});

