/*
 * This adapter connects to the free adsb.fi open data API.
 * It does not query by BBOX, but by a center point + radius.
 * This file contains the math helpers to convert the app's BBOX
 * into a center/radius query that the adsb.fi API understands.
 */

const API_URL = "https://opendata.adsb.fi/api/v2";

const KM_TO_NAUTICAL_MILES = 0.539957;

/**
 * Calculates the distance between two lat/lon points in KM using the Haversine formula.
 */
function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the Earth in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

/**
 * Converts the server's BBOX into a center point and radius for the API call.
 */
function bboxToCenterRadius(bbox) {
  const { lamin: south, lamax: north, lomin: west, lomax: east } = bbox;

  const centerLat = (south + north) / 2;
  const centerLon = (west + east) / 2;

  // Calculate distance from center to a corner (e.g., northeast) to get the radius
  const radiusInKm = getHaversineDistance(centerLat, centerLon, north, east);
  
  // The adsb.fi API radius distance is in Nautical Miles
  const radiusInNm = Math.ceil(radiusInKm * KM_TO_NAUTICAL_MILES);

  return { lat: centerLat, lon: centerLon, dist: radiusInNm };
}

/**
 * Maps an aircraft object from adsb.fi to your app's HelicopterFlight shape.
 * This ensures the frontend doesn't need any changes.
 */
function mapAdsbFiToFlight(ac) {
  const alt = ac.alt_baro ?? ac.alt_geom; // Barometric is standard, geom is GPS. Both are in feet.
  const speed = ac.gs; // Ground speed in knots.
  const heading = ac.track;

  // 'seen_pos' = seconds since epoch when position was last updated.
  const lastSeenEpoch = (ac.seen_pos ?? ac.seen ?? 0) * 1000;

  return {
    callsign: (ac.flight || "").trim() || ac.hex,
    type: ac.t || "other", // Aircraft type code (e.g., "B738")
    latitude: ac.lat,
    longitude: ac.lon,
    altitude: alt === "ground" ? 0 : Math.round(alt), // Already in feet
    speed: speed ? Math.round(speed) : null,         // Already in knots
    heading: heading ? Math.round(heading) : null,
    status: alt === "ground" ? "landed" : "active",
    agency: null, // This data is not available from the raw feed
    last_seen: new Date(lastSeenEpoch).toISOString(),
    icao24: ac.hex,
  };
}

/**
 * Determines if the aircraft is likely a helicopter based on adsb.fi data.
 * The most reliable filter is the ICAO category 'A5' (Rotorcraft).
 */
function likelyHeli(ac) {
  // A5 is the ICAO category for Rotorcraft. This is the most reliable filter.
  if (ac.category === "A5") {
    return true;
  }
  
  // Fallback to your original logic for aircraft with missing category data
  const alt = ac.alt_baro ?? ac.alt_geom;
  const altOk = alt == null || alt === "ground" || alt < 9000; // < 9k ft
  const spdOk = ac.gs == null || ac.gs < 160;                   // < 160 kt
  return altOk && spdOk;
}

/**
 * Public function to fetch flight states.
 * This is the only function that will be called by your server/index.js.
 */
async function fetchFlightStates(bbox, timeoutMs = 15000) {
  // 1. Convert BBOX to the format the API needs
  const { lat, lon, dist } = bboxToCenterRadius(bbox);

  const url = `${API_URL}/lat/${lat.toFixed(6)}/lon/${lon.toFixed(6)}/dist/${dist}/`;
  
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`adsb.fi API ${r.status}: ${text || r.statusText}`);
    }

    const json = await r.json();
    const time = json.now ? Math.floor(json.now / 1000) : Math.floor(Date.now() / 1000);

    // 2. Map, filter, and add the likelyHeli flag all at once
    const flights = (json.aircraft || [])
      .filter(ac => ac.lat != null && ac.lon != null) // Ensure it has a position
      .map(ac => ({
        ...mapAdsbFiToFlight(ac),
        likelyHeli: likelyHeli(ac),
      }));

    return { time, flights };
  } catch (err) {
    clearTimeout(t);
    // Re-throw the error to be caught by your route handler
    throw err;
  }
}

// Export as a CommonJS module for your server/index.js
module.exports = { fetchFlightStates };