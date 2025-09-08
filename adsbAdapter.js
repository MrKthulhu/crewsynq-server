const API_URL = "https://opendata.adsb.fi/api/v2";
const KM_TO_NAUTICAL_MILES = 0.539957;

function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function bboxToCenterRadius(bbox) {
  const { lamin: south, lamax: north, lomin: west, lomax: east } = bbox;
  const centerLat = (south + north) / 2;
  const centerLon = (west + east) / 2;
  const radiusInKm = getHaversineDistance(centerLat, centerLon, north, east);
  const radiusInNm = Math.ceil(radiusInKm * KM_TO_NAUTICAL_MILES);
  return { lat: centerLat, lon: centerLon, dist: radiusInNm };
}

function mapAdsbFiToFlight(ac) {
  const alt = ac.alt_baro ?? ac.alt_geom;
  const lastSeenEpoch = (ac.seen_pos ?? ac.seen ?? 0) * 1000;
  return {
    callsign: (ac.flight || "").trim() || ac.hex,
    type: ac.t || "other",
    latitude: ac.lat,
    longitude: ac.lon,
    altitude: alt === "ground" ? 0 : Math.round(alt),
    speed: ac.gs ? Math.round(ac.gs) : null,
    heading: ac.track ? Math.round(ac.track) : null,
    status: alt === "ground" ? "landed" : "active",
    agency: ac.ownOp || null, 
    last_seen: new Date(lastSeenEpoch).toISOString(),
    icao24: ac.hex,
  };
}


function likelyHeli(ac) {
  // 1. Check owner/operator for law enforcement or emergency services keywords
  const owner = (ac.ownOp || "").toLowerCase();
  if (owner.includes("police") || owner.includes("sheriff") || owner.includes("air support") || owner.includes("stars")) {
    return true;
  }

  // 2. Check description for helicopter manufacturer keywords
  const desc = (ac.desc || "").toLowerCase();
  const heliKeywords = ["helicopter", "rotorcraft", "ecureuil", "aerospatiale", "eurocopter", "bell", "robinson", "sikorsky", "airbus helicopters"];
  if (heliKeywords.some(keyword => desc.includes(keyword))) {
    return true;
  }

  // 3. Check aircraft type code for known helicopter models
  const typeCode = (ac.t || "").toUpperCase();
  const heliTypeCodes = ["AS50", "AS55", "R44", "R66", "B407", "B206", "B212", "EC20", "EC30", "EC35", "H125", "H135", "H145"];
  if (heliTypeCodes.includes(typeCode)) {
    return true;
  }

  // 4. NO FALLBACK. If it cannot be positively identified, we reject it.
  return false;
}


async function fetchFlightStates(bbox, timeoutMs = 15000) {
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

    const flights = (json.aircraft || [])
      .filter(ac => ac.lat != null && ac.lon != null && likelyHeli(ac)) // The filter is now much stricter
      .map(ac => ({
        ...mapAdsbFiToFlight(ac),
        likelyHeli: true,
      }));

    return { time, flights };
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

module.exports = { fetchFlightStates };

