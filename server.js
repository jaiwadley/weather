const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "public");
const USER_AGENT = "EastCoastOutageWeatherMap/1.0 (local dashboard)";

const EAST_STATES = [
  ["ME", "Maine", "maine", 45.2538, -69.4455],
  ["NH", "New Hampshire", "new-hampshire", 43.1939, -71.5724],
  ["VT", "Vermont", "vermont", 44.5588, -72.5778],
  ["MA", "Massachusetts", "massachusetts", 42.4072, -71.3824],
  ["RI", "Rhode Island", "rhode-island", 41.5801, -71.4774],
  ["CT", "Connecticut", "connecticut", 41.6032, -73.0877],
  ["NY", "New York", "new-york", 43.2994, -74.2179],
  ["NJ", "New Jersey", "new-jersey", 40.0583, -74.4057],
  ["PA", "Pennsylvania", "pennsylvania", 41.2033, -77.1945],
  ["DE", "Delaware", "delaware", 38.9108, -75.5277],
  ["MD", "Maryland", "maryland", 39.0458, -76.6413],
  ["DC", "District of Columbia", "district-of-columbia", 38.9072, -77.0369],
  ["VA", "Virginia", "virginia", 37.4316, -78.6569],
  ["NC", "North Carolina", "north-carolina", 35.7596, -79.0193],
  ["SC", "South Carolina", "south-carolina", 33.8361, -81.1637],
  ["GA", "Georgia", "georgia", 32.1656, -82.9001],
  ["FL", "Florida", "florida", 27.6648, -81.5158]
].map(([abbr, name, slug, lat, lon]) => ({ abbr, name, slug, lat, lon }));

const TREND_POINTS = [
  ["Boston", "MA", 42.3601, -71.0589],
  ["New York", "NY", 40.7128, -74.006],
  ["Philadelphia", "PA", 39.9526, -75.1652],
  ["Washington", "DC", 38.9072, -77.0369],
  ["Norfolk", "VA", 36.8508, -76.2859],
  ["Raleigh", "NC", 35.7796, -78.6382],
  ["Charleston", "SC", 32.7765, -79.9311],
  ["Savannah", "GA", 32.0809, -81.0912],
  ["Jacksonville", "FL", 30.3322, -81.6557],
  ["Miami", "FL", 25.7617, -80.1918]
].map(([city, state, lat, lon]) => ({ city, state, lat, lon }));

const PRESSURE_POINTS = [
  ["Portland", "ME", 43.6591, -70.2568],
  ["Concord", "NH", 43.2081, -71.5376],
  ["Burlington", "VT", 44.4759, -73.2121],
  ["Boston", "MA", 42.3601, -71.0589],
  ["Providence", "RI", 41.824, -71.4128],
  ["Hartford", "CT", 41.7658, -72.6734],
  ["Albany", "NY", 42.6526, -73.7562],
  ["New York", "NY", 40.7128, -74.006],
  ["Scranton", "PA", 41.409, -75.6624],
  ["Philadelphia", "PA", 39.9526, -75.1652],
  ["Atlantic City", "NJ", 39.3643, -74.4229],
  ["Dover", "DE", 39.1582, -75.5244],
  ["Baltimore", "MD", 39.2904, -76.6122],
  ["Washington", "DC", 38.9072, -77.0369],
  ["Richmond", "VA", 37.5407, -77.436],
  ["Norfolk", "VA", 36.8508, -76.2859],
  ["Raleigh", "NC", 35.7796, -78.6382],
  ["Charlotte", "NC", 35.2271, -80.8431],
  ["Wilmington", "NC", 34.2104, -77.8868],
  ["Columbia", "SC", 34.0007, -81.0348],
  ["Charleston", "SC", 32.7765, -79.9311],
  ["Atlanta", "GA", 33.749, -84.388],
  ["Savannah", "GA", 32.0809, -81.0912],
  ["Tallahassee", "FL", 30.4383, -84.2807],
  ["Jacksonville", "FL", 30.3322, -81.6557],
  ["Orlando", "FL", 28.5383, -81.3792],
  ["Tampa", "FL", 27.9506, -82.4572],
  ["Miami", "FL", 25.7617, -80.1918]
].map(([city, state, lat, lon]) => ({ city, state, lat, lon }));

let cache = {};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/geo+json, application/json, text/html, */*"
        },
        timeout: timeoutMs
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`${res.statusCode} from ${url}`));
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout after ${timeoutMs}ms from ${url}`)));
    req.on("error", reject);
  });
}

async function cached(key, ttlMs, fn) {
  const now = Date.now();
  if (cache[key] && now - cache[key].time < ttlMs) return cache[key].value;
  const value = await fn();
  cache[key] = { time: now, value };
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function numberFrom(text) {
  const clean = String(text || "").replace(/[^\d]/g, "");
  return clean ? Number(clean) : 0;
}

async function getWeatherAlerts() {
  return cached("alerts", 2 * 60 * 1000, async () => {
    const areas = EAST_STATES.map((state) => state.abbr).join(",");
    const url = `https://api.weather.gov/alerts/active?area=${areas}`;
    const geojson = JSON.parse(await fetchText(url));
    geojson.features = (geojson.features || []).filter((feature) => {
      const props = feature.properties || {};
      return props.status === "Actual" && props.event !== "Test Message";
    });
    return {
      source: "Weather.gov / National Weather Service",
      url,
      updated: geojson.updated || new Date().toISOString(),
      geojson
    };
  });
}

async function getOutages() {
  return cached("outages", 5 * 60 * 1000, async () => {
    const html = await fetchText("https://outage.online/");
    const updated = html.match(/Last updated:\s*<strong>(.*?)<\/strong>/i)?.[1] ||
      html.match(/dateModified":"([^"]+)/)?.[1] ||
      new Date().toISOString();
    const states = EAST_STATES.map((state) => {
      const re = new RegExp(`<a class="chip" href="/${state.slug}/">[\\s\\S]*?<span class="chip-metric">([\\d,]+)</span>`, "i");
      const out = numberFrom(html.match(re)?.[1]);
      return { ...state, customersOut: out, sourceUrl: `https://outage.online/${state.slug}/` };
    });
    return {
      source: "Outage.online current state totals",
      sourceNote: "PowerOutage.us is linked for manual verification; direct automated access was blocked by Cloudflare in this environment.",
      updated,
      states,
      totalOut: states.reduce((sum, state) => sum + state.customersOut, 0)
    };
  });
}

function maxWindMph(text) {
  const values = String(text || "").match(/\d+/g) || [];
  return Math.max(0, ...values.map(Number));
}

function riskFromPeriods(periods) {
  const next48 = (periods || []).slice(0, 48);
  const maxGust = Math.max(0, ...next48.map((period) => maxWindMph(period.windSpeed)));
  const thunderHours = next48.filter((period) => /thunder|t-storm|storm/i.test(period.shortForecast || "")).length;
  const rainHours = next48.filter((period) => /rain|showers|drizzle|flood/i.test(period.shortForecast || "")).length;
  let score = 0;
  score += Math.min(50, maxGust * 1.2);
  score += Math.min(30, rainHours * 3);
  score += Math.min(20, thunderHours * 6);
  const level = score >= 70 ? "High" : score >= 42 ? "Elevated" : score >= 22 ? "Watch" : "Low";
  return { score: Math.round(score), level, maxGust: Math.round(maxGust), rainHours, thunderHours };
}

async function getTrends() {
  return cached("trends", 15 * 60 * 1000, async () => {
    const trends = await Promise.all(
      TREND_POINTS.map(async (point) => {
        const pointUrl = `https://api.weather.gov/points/${point.lat},${point.lon}`;
        const pointData = JSON.parse(await fetchText(pointUrl));
        const forecastUrl = pointData.properties.forecastHourly;
        const forecast = JSON.parse(await fetchText(forecastUrl));
        return { ...point, ...riskFromPeriods(forecast.properties.periods), sourceUrl: forecastUrl };
      })
    );
    return {
      source: "Weather.gov hourly forecast, summarized for wind, rain, and thunderstorm outage risk.",
      updated: new Date().toISOString(),
      trends
    };
  });
}

function pressureLevel(dropMbarPer24h) {
  if (dropMbarPer24h >= 12) return "High";
  if (dropMbarPer24h >= 9) return "Elevated";
  if (dropMbarPer24h >= 6) return "Watch";
  if (dropMbarPer24h >= 3) return "Low";
  return "Minimal";
}

function summarizePressureDropPoint(point, hourly) {
  const times = hourly.time || [];
  const pressure = hourly.pressure_msl || [];
  const wind = hourly.wind_speed_10m || [];
  const precip = hourly.precipitation || [];
  let best = null;

  for (let start = 0; start < pressure.length; start += 1) {
    const startPressure = Number(pressure[start]);
    if (!Number.isFinite(startPressure)) continue;
    const endLimit = Math.min(pressure.length - 1, start + 96);
    for (let end = start + 6; end <= endLimit; end += 1) {
      const endPressure = Number(pressure[end]);
      if (!Number.isFinite(endPressure)) continue;
      const drop = startPressure - endPressure;
      if (drop <= 0) continue;
      if (!best || drop > best.pressureDrop) {
        best = { start, end, startPressure, endPressure, pressureDrop: drop };
      }
    }
  }

  if (!best) {
    return {
      point,
      valid: false,
      startTime: null,
      endTime: null,
      startPressure: null,
      endPressure: null,
      pressureDrop: 0,
      dropHours: 0,
      maxWind: 0,
      precipTotal: 0,
      score: 0,
      dropMbarPer24h: 0,
      level: "Minimal"
    };
  }

  const windowWind = wind.slice(best.start, best.end + 1).map(Number).filter(Number.isFinite);
  const windowPrecip = precip.slice(best.start, best.end + 1).map(Number).filter(Number.isFinite);
  const maxWind = Math.max(0, ...windowWind);
  const precipTotal = windowPrecip.reduce((sum, value) => sum + value, 0);
  const dropHours = Math.max(1, best.end - best.start);
  const dropMbarPer24h = best.pressureDrop / dropHours * 24;
  const score = Math.max(0, Math.min(100, Math.round(dropMbarPer24h / 12 * 100)));

  return {
    point,
    valid: true,
    startTime: times[best.start] || null,
    endTime: times[best.end] || null,
    startPressure: Number(best.startPressure.toFixed(1)),
    endPressure: Number(best.endPressure.toFixed(1)),
    pressureDrop: Number(best.pressureDrop.toFixed(1)),
    dropHours,
    dropMbarPer24h: Number(dropMbarPer24h.toFixed(1)),
    maxWind: Math.round(maxWind),
    precipTotal: Number(precipTotal.toFixed(2)),
    score,
    level: pressureLevel(dropMbarPer24h)
  };
}

async function getPressureOutlook() {
  return cached("pressure-outlook", 30 * 60 * 1000, async () => {
    try {
      return await buildPressureOutlook();
    } catch (error) {
      const stale = cache["pressure-outlook"]?.value;
      if (stale?.areas?.length) {
        return {
          ...stale,
          status: "stale",
          warning: `Live GFS refresh failed; showing last successful pressure outlook. ${error.message}`,
          updated: stale.updated
        };
      }
      return emptyPressureOutlook(error);
    }
  });
}

async function buildPressureOutlook() {
  let forecastSet;
  let source;
  let model;
  const gfsErrorMessages = [];

  try {
    forecastSet = await fetchPressureForecastChunks("gfs", 7);
    source = "NOAA GFS 14-day hourly pressure, wind, and precipitation forecast via Open-Meteo GFS API. Pivotal Weather GFS is linked as the model-map comparison view.";
    model = "NOAA GFS";
  } catch (error) {
    gfsErrorMessages.push(error.message);
    forecastSet = await fetchNwsPressureForecasts();
    source = "NWS gridpoint pressure forecast used as a fallback because the GFS endpoint is temporarily unavailable. Pivotal Weather GFS remains linked for comparison.";
    model = "NWS gridpoint fallback";
  }

  const areas = forecastSet.map(({ point, forecast }) => {
      return {
        ...summarizePressureDropPoint(point, forecast.hourly || {}),
        model
      };
    }).filter((area) => area.valid).sort((a, b) => b.score - a.score);

  if (!areas.length) {
    throw new Error(`${model} returned no usable pressure values`);
  }

  const features = areas.map((area) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [area.point.lon, area.point.lat] },
      properties: {
        layer: "pressure_drop_area",
        model: area.model,
        city: area.point.city,
        stateAbbr: area.point.state,
        dropStarts: area.startTime,
        dropBottomsOut: area.endTime,
        startPressureHpa: area.startPressure,
        endPressureHpa: area.endPressure,
        pressureDropHpa: area.pressureDrop,
        dropHours: area.dropHours,
        dropMbarPer24h: area.dropMbarPer24h,
        riskLevel: area.level,
        riskScore: area.score,
        maxWindMph: area.maxWind,
        precipIn: area.precipTotal
      }
    }));

  return {
      status: model === "NOAA GFS" ? "live" : "fallback",
      warning: gfsErrorMessages.length ? `GFS endpoint failed: ${gfsErrorMessages.join("; ")}` : null,
      source,
      model,
      modelLinks: [
        { name: "Pivotal Weather GFS", url: "https://www.pivotalweather.com/model.php?m=gfs" },
        { name: "Open-Meteo GFS API", url: "https://open-meteo.com/en/docs/gfs-api" },
        { name: "NWS gridpoint API", url: "https://www.weather.gov/documentation/services-web-api" },
        { name: "NOAA GFS overview", url: "https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast" }
      ],
      updated: new Date().toISOString(),
      areas,
      geojson: {
        type: "FeatureCollection",
        name: "two_week_pressure_drop_outlook",
        features
      }
    };
}

async function fetchPressureForecastChunks(endpoint, chunkSize) {
  const results = [];
  const failures = [];
  for (const pointChunk of chunks(PRESSURE_POINTS, chunkSize)) {
    const latitudes = pointChunk.map((point) => point.lat).join(",");
    const longitudes = pointChunk.map((point) => point.lon).join(",");
    const url = `https://api.open-meteo.com/v1/${endpoint}?latitude=${latitudes}&longitude=${longitudes}&hourly=pressure_msl,wind_speed_10m,precipitation&forecast_days=14&timezone=America%2FNew_York&wind_speed_unit=mph&precipitation_unit=inch`;
    try {
      const data = JSON.parse(await fetchText(url, 4000));
      const forecasts = Array.isArray(data) ? data : [data];
      forecasts.forEach((forecast, index) => {
        if (pointChunk[index]) results.push({ point: pointChunk[index], forecast });
      });
    } catch (error) {
      failures.push(error.message);
      if (!results.length) break;
    }
    await sleep(350);
  }
  if (!results.length) {
    throw new Error(`${endpoint} pressure forecast unavailable: ${failures.join("; ")}`);
  }
  return results;
}

async function fetchNwsPressureForecasts() {
  const tasks = PRESSURE_POINTS.map(async (point) => {
    const pointUrl = `https://api.weather.gov/points/${point.lat},${point.lon}`;
    const pointData = JSON.parse(await fetchText(pointUrl, 4500));
    const gridUrl = pointData.properties?.forecastGridData;
    if (!gridUrl) throw new Error(`No NWS grid URL for ${point.city}`);
    const gridData = JSON.parse(await fetchText(gridUrl, 6500));
    return { point, forecast: nwsGridToHourlyForecast(gridData.properties || {}) };
  });
  const settled = await Promise.allSettled(tasks);
  const results = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
  if (!results.length) {
    const failures = settled.filter((item) => item.status === "rejected").map((item) => item.reason?.message || String(item.reason));
    throw new Error(`NWS pressure forecast unavailable: ${failures.join("; ")}`);
  }
  return results;
}

function nwsGridToHourlyForecast(properties) {
  return {
    hourly: {
      time: expandNwsValues(properties.pressure?.values || [], (value) => value).map((row) => row.time),
      pressure_msl: expandNwsValues(properties.pressure?.values || [], normalizePressureValue).map((row) => row.value),
      wind_speed_10m: expandNwsValues(properties.windSpeed?.values || [], normalizeWindValue).map((row) => row.value),
      precipitation: expandNwsValues(properties.quantitativePrecipitation?.values || [], normalizePrecipValue).map((row) => row.value)
    }
  };
}

function expandNwsValues(values, normalize) {
  const rows = [];
  values.forEach((entry) => {
    const [startText, durationText = "PT1H"] = String(entry.validTime || "").split("/");
    const start = new Date(startText);
    if (Number.isNaN(start.valueOf())) return;
    const hours = Math.max(1, durationHours(durationText));
    const value = normalize(entry.value);
    for (let offset = 0; offset < hours; offset += 1) {
      rows.push({ time: new Date(start.getTime() + offset * 60 * 60 * 1000).toISOString(), value });
    }
  });
  return rows;
}

function durationHours(durationText) {
  const days = Number(durationText.match(/P(\d+)D/)?.[1] || 0);
  const hours = Number(durationText.match(/T(\d+)H/)?.[1] || 0);
  return days * 24 + hours || 1;
}

function normalizePressureValue(value) {
  const number = Number(value) || 0;
  if (number > 20 && number < 40) return number * 33.8639;
  return number > 2000 ? number / 100 : number;
}

function normalizeWindValue(value) {
  const number = Number(value) || 0;
  return number * 0.621371;
}

function normalizePrecipValue(value) {
  const number = Number(value) || 0;
  return number / 25.4;
}

function emptyPressureOutlook(error) {
  return {
    status: "unavailable",
    warning: `Pressure outlook temporarily unavailable: ${error.message}`,
    source: "NOAA GFS pressure outlook is temporarily unavailable from the upstream provider.",
    model: "NOAA GFS",
    modelLinks: [
      { name: "Pivotal Weather GFS", url: "https://www.pivotalweather.com/model.php?m=gfs" },
      { name: "Open-Meteo GFS API", url: "https://open-meteo.com/en/docs/gfs-api" },
      { name: "NOAA GFS overview", url: "https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast" }
    ],
    updated: new Date().toISOString(),
    areas: [],
    geojson: {
      type: "FeatureCollection",
      name: "two_week_pressure_drop_outlook",
      features: []
    }
  };
}

async function getNews() {
  return cached("news", 10 * 60 * 1000, async () => {
    const url = "https://news.google.com/rss/search?q=east%20coast%20weather%20power%20outage%20OR%20utility%20storm&hl=en-US&gl=US&ceid=US:en";
    const xml = await fetchText(url);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map((match) => {
      const item = match[1];
      return {
        title: decodeXml(item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/)?.[1] || item.match(/<title>(.*?)<\/title>/)?.[1] || ""),
        link: decodeXml(item.match(/<link>(.*?)<\/link>/)?.[1] || ""),
        pubDate: decodeXml(item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "")
      };
    });
    return { source: "Google News RSS search across local and national outlets", updated: new Date().toISOString(), items };
  });
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function serveStatic(req, res) {
  const safePath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const requested = safePath === "/" ? "/index.html" : safePath;
  const filePath = path.normalize(path.join(ROOT, requested));
  if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    }[ext] || "application/octet-stream";
    send(res, 200, data, type);
  });
}

async function handleApi(pathname, res) {
  try {
    if (pathname === "/api/weather/alerts") return send(res, 200, await getWeatherAlerts());
    if (pathname === "/api/weather/trends") return send(res, 200, await getTrends());
    if (pathname === "/api/weather/pressure-outlook") return send(res, 200, await getPressureOutlook());
    if (pathname === "/api/outages") return send(res, 200, await getOutages());
    if (pathname === "/api/news") return send(res, 200, await getNews());
    if (pathname === "/api/sources") {
      return send(res, 200, {
        updated: new Date().toISOString(),
        sources: [
          { name: "Weather.gov", status: "live", url: "https://api.weather.gov/alerts/active" },
          { name: "NOAA GFS via Open-Meteo", status: "live pressure-drop model layer", url: "https://open-meteo.com/en/docs/gfs-api" },
          { name: "Pivotal Weather GFS", status: "manual model-map comparison", url: "https://www.pivotalweather.com/model.php?m=gfs" },
          { name: "Outage.online", status: "live", url: "https://outage.online/" },
          { name: "PowerOutage.us", status: "manual link / blocked here", url: "https://poweroutage.us/" },
          { name: "Windy", status: "manual link / API key required for embeds", url: "https://www.windy.com/" },
          { name: "Wunderground", status: "manual link / no open browser API", url: "https://www.wunderground.com/" },
          { name: "Facebook", status: "manual link / login and permissions required", url: "https://www.facebook.com/search/top?q=east%20coast%20power%20outage%20weather" },
          { name: "Local and national news", status: "live RSS search", url: "https://news.google.com/" }
        ]
      });
    }
    send(res, 404, { error: "Unknown API route" });
  } catch (error) {
    send(res, 502, { error: error.message });
  }
}

http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname.startsWith("/api/")) return handleApi(pathname, res);
  serveStatic(req, res);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`East Coast outage weather map: http://localhost:${PORT}`);
});
