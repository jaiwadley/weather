const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 4173;
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

let cache = {};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/geo+json, application/json, text/html, */*"
        },
        timeout: 15000
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
    req.on("timeout", () => req.destroy(new Error(`Timeout from ${url}`)));
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
    if (pathname === "/api/outages") return send(res, 200, await getOutages());
    if (pathname === "/api/news") return send(res, 200, await getNews());
    if (pathname === "/api/sources") {
      return send(res, 200, {
        updated: new Date().toISOString(),
        sources: [
          { name: "Weather.gov", status: "live", url: "https://api.weather.gov/alerts/active" },
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
}).listen(PORT, "127.0.0.1", () => {
  console.log(`East Coast outage weather map: http://localhost:${PORT}`);
});
