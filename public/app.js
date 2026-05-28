const state = {
  layers: {},
  pressureVisible: true,
  refreshMs: 10 * 60 * 1000,
  nextRefresh: null
};

const map = L.map("map", { zoomControl: false }).setView([37.9, -76.2], 5);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

const els = {
  updated: document.querySelector("#last-updated"),
  refresh: document.querySelector("#refresh"),
  totalOutages: document.querySelector("#total-outages"),
  alertCount: document.querySelector("#alert-count"),
  highestRisk: document.querySelector("#highest-risk"),
  risks: document.querySelector("#risks"),
  outages: document.querySelector("#outages"),
  news: document.querySelector("#news"),
  gfs: document.querySelector("#gfs"),
  sources: document.querySelector("#sources")
};

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tabs button, .tab").forEach((node) => node.classList.remove("active"));
    button.classList.add("active");
    document.querySelector(`#${button.dataset.tab}`).classList.add("active");
  });
});

els.refresh.addEventListener("click", () => refreshAll(true));

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatTime(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function markerColor(level) {
  return { High: "#dc2626", Elevated: "#d97706", Watch: "#2563eb", Low: "#138a72" }[level] || "#607080";
}

function pressureColor(level) {
  return { High: "#dc2626", Elevated: "#7c3aed", Watch: "#2563eb", Low: "#138a72" }[level] || "#607080";
}

function clearLayer(name) {
  if (state.layers[name]) {
    map.removeLayer(state.layers[name]);
  }
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function refreshAll(manual = false) {
  els.updated.textContent = manual ? "Refreshing live feeds..." : "Loading live feeds...";
  els.refresh.disabled = true;
  try {
    const [alerts, trends, pressure, outages, news, sources] = await Promise.all([
      getJson("/api/weather/alerts"),
      getJson("/api/weather/trends"),
      getJson("/api/weather/pressure-outlook"),
      getJson("/api/outages"),
      getJson("/api/news"),
      getJson("/api/sources")
    ]);

    renderAlerts(alerts);
    renderTrends(trends);
    renderPressureOutlook(pressure);
    renderOutages(outages);
    renderNews(news);
    renderGfs(pressure);
    renderSources(sources);

    const highest = [...trends.trends].sort((a, b) => b.score - a.score)[0];
    els.totalOutages.textContent = formatNumber(outages.totalOut);
    els.alertCount.textContent = formatNumber(alerts.geojson.features.length);
    els.highestRisk.textContent = highest ? highest.level : "--";

    state.nextRefresh = Date.now() + state.refreshMs;
    els.updated.textContent = `Updated ${formatTime(new Date())}. Auto-refresh in 10 min.`;
  } catch (error) {
    els.updated.textContent = `Feed issue: ${error.message}`;
  } finally {
    els.refresh.disabled = false;
  }
}

function renderAlerts(data) {
  clearLayer("alerts");
  state.layers.alerts = L.geoJSON(data.geojson, {
    filter: (feature) => Boolean(feature.geometry),
    style: (feature) => {
      const severity = feature.properties.severity;
      const color = severity === "Extreme" || severity === "Severe" ? "#dc2626" : "#d97706";
      return { color, weight: 2, opacity: 0.85, fillColor: color, fillOpacity: 0.18 };
    },
    onEachFeature: (feature, layer) => {
      const props = feature.properties || {};
      layer.bindPopup(`
        <p class="popup-title">${props.event || "Weather alert"}</p>
        <p class="popup-meta">${props.areaDesc || ""}</p>
        <p class="popup-meta">${props.headline || "Active NWS alert"}</p>
      `);
    }
  }).addTo(map);

  const items = data.geojson.features.slice(0, 12).map((feature) => {
    const props = feature.properties || {};
    return `
      <article class="item">
        <div class="row">
          <h2>${props.event || "NWS Alert"}</h2>
          <span class="source-status">${props.severity || "Alert"}</span>
        </div>
        <p>${props.areaDesc || ""}</p>
        <p>${props.headline || ""}</p>
      </article>
    `;
  }).join("");

  if (!items) {
    els.risks.innerHTML = '<article class="item"><h2>No active Weather.gov outage-risk alerts</h2><p>The map will update automatically when NWS alerts appear for the East Coast states.</p></article>';
  } else {
    els.risks.innerHTML = `<article class="item"><h2>Weather.gov alerts</h2><p>${data.source}. Updated ${formatTime(data.updated)}.</p></article>${items}`;
  }
}

function renderTrends(data) {
  clearLayer("trends");
  const group = L.layerGroup();
  data.trends.forEach((point) => {
    const radius = Math.max(8, Math.min(24, 7 + point.score / 4));
    L.circleMarker([point.lat, point.lon], {
      radius,
      color: "#ffffff",
      weight: 2,
      fillColor: markerColor(point.level),
      fillOpacity: 0.82
    }).bindPopup(`
      <p class="popup-title">${point.city}, ${point.state}: ${point.level}</p>
      <p class="popup-meta">Outage-weather score ${point.score}/100</p>
      <p class="popup-meta">Max wind ${point.maxGust} mph, rain hours ${point.rainHours}, thunder hours ${point.thunderHours}</p>
    `).addTo(group);
  });
  state.layers.trends = group.addTo(map);

  const trendItems = [...data.trends]
    .sort((a, b) => b.score - a.score)
    .map((point) => `
      <article class="item">
        <div class="row">
          <h3>${point.city}, ${point.state}</h3>
          <span class="pill ${point.level}">${point.level}</span>
        </div>
        <p>Score ${point.score}/100. Max wind ${point.maxGust} mph; rain hours ${point.rainHours}; thunder hours ${point.thunderHours}.</p>
      </article>
    `).join("");

  els.risks.insertAdjacentHTML("beforeend", `<article class="item"><h2>48-hour forecast trend</h2><p>${data.source}</p></article>${trendItems}`);
}

function renderOutages(data) {
  clearLayer("outages");
  const group = L.layerGroup();
  data.states.forEach((place) => {
    const radius = Math.max(5, Math.min(34, 5 + Math.sqrt(place.customersOut) / 2.8));
    L.circleMarker([place.lat, place.lon], {
      radius,
      color: "#ffffff",
      weight: 2,
      fillColor: "#2563eb",
      fillOpacity: 0.72
    }).bindPopup(`
      <p class="popup-title">${place.name}</p>
      <p class="popup-meta">${formatNumber(place.customersOut)} customers out</p>
      <p class="popup-meta"><a href="${place.sourceUrl}" target="_blank" rel="noreferrer">Open outage source</a></p>
    `).addTo(group);
  });
  state.layers.outages = group.addTo(map);

  els.outages.innerHTML = `
    <article class="item">
      <h2>Current power outages</h2>
      <p>${data.source}. Updated ${formatTime(data.updated)}. ${data.sourceNote || ""}</p>
    </article>
    ${[...data.states].sort((a, b) => b.customersOut - a.customersOut).map((place) => `
      <article class="item">
        <div class="row">
          <h3>${place.name}</h3>
          <strong>${formatNumber(place.customersOut)}</strong>
        </div>
        <p><a href="${place.sourceUrl}" target="_blank" rel="noreferrer">Open state outage page</a></p>
      </article>
    `).join("")}
  `;
}

function renderPressureOutlook(data) {
  clearLayer("pressure");
  const group = L.layerGroup();
  const points = data.geojson.features.filter((feature) => feature.geometry?.type === "Point");

  points.forEach((feature) => {
    const props = feature.properties;
    const [lon, lat] = feature.geometry.coordinates;
    const color = pressureColor(props.riskLevel);
    L.circle([lat, lon], {
      radius: Math.max(45000, Math.min(150000, 38000 + props.riskScore * 1300)),
      color,
      weight: 2,
      opacity: 0.62,
      fillColor: color,
      fillOpacity: 0.17
    }).bindPopup(`
      <p class="popup-title">${props.city}, ${props.stateAbbr}: ${props.riskLevel}</p>
      <p class="popup-meta">${props.model || "Forecast model"}</p>
      <p class="popup-meta">Pressure drop ${props.pressureDropHpa} mbar over ${props.dropHours} hours</p>
      <p class="popup-meta">Starts ${formatTime(props.dropStarts)}; bottoms out ${formatTime(props.dropBottomsOut)}</p>
      <p class="popup-meta">${props.startPressureHpa} mbar to ${props.endPressureHpa} mbar</p>
      <p class="popup-meta">Max wind ${props.maxWindMph} mph; precip ${props.precipIn} in</p>
    `).addTo(group);

    L.circleMarker([lat, lon], {
      radius: Math.max(6, Math.min(13, 5 + props.pressureDropHpa)),
      color: "#ffffff",
      weight: 2,
      fillColor: pressureColor(props.riskLevel),
      fillOpacity: 0.86
    }).bindPopup(`
      <p class="popup-title">${props.city}, ${props.stateAbbr}: ${props.riskLevel}</p>
      <p class="popup-meta">${props.model || "Forecast model"}</p>
      <p class="popup-meta">Pressure drop ${props.pressureDropHpa} mbar over ${props.dropHours} hours</p>
      <p class="popup-meta">Starts ${formatTime(props.dropStarts)}; bottoms out ${formatTime(props.dropBottomsOut)}</p>
      <p class="popup-meta">Max wind ${props.maxWindMph} mph; precip ${props.precipIn} in</p>
    `).addTo(group);
  });

  state.layers.pressure = group;
  if (state.pressureVisible) group.addTo(map);
}

function renderNews(data) {
  els.news.innerHTML = `
    <article class="item">
      <h2>Local and national news scan</h2>
      <p>${data.source}. Updated ${formatTime(data.updated)}.</p>
    </article>
    ${data.items.map((item) => `
      <article class="item">
        <h3><a href="${item.link}" target="_blank" rel="noreferrer">${item.title}</a></h3>
        <p>${item.pubDate ? formatTime(item.pubDate) : ""}</p>
      </article>
    `).join("") || '<article class="item"><h3>No matching news items returned.</h3></article>'}
  `;
}

function renderSources(data) {
  els.sources.innerHTML = data.sources.map((source) => `
    <article class="item">
      <div class="row">
        <h3><a href="${source.url}" target="_blank" rel="noreferrer">${source.name}</a></h3>
        <span class="source-status">${source.status}</span>
      </div>
    </article>
  `).join("");
}

function featureCollection(name, features, source, updated) {
  return {
    type: "FeatureCollection",
    name,
    crs: {
      type: "name",
      properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" }
    },
    metadata: {
      source,
      updated,
      generatedAt: new Date().toISOString()
    },
    features
  };
}

function pointFeature(lon, lat, properties) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties
  };
}

function buildGisLayers(alerts, trends, outages) {
  const alertFeatures = alerts.geojson.features.map((feature) => ({
    ...feature,
    properties: {
      layer: "nws_alerts",
      event: feature.properties?.event || "",
      severity: feature.properties?.severity || "",
      urgency: feature.properties?.urgency || "",
      certainty: feature.properties?.certainty || "",
      areaDesc: feature.properties?.areaDesc || "",
      headline: feature.properties?.headline || "",
      sent: feature.properties?.sent || "",
      expires: feature.properties?.expires || "",
      source: "Weather.gov"
    }
  }));

  const outageFeatures = outages.states.map((place) => pointFeature(place.lon, place.lat, {
    layer: "state_outages",
    state: place.name,
    stateAbbr: place.abbr,
    customersOut: place.customersOut,
    sourceUrl: place.sourceUrl,
    source: outages.source
  }));

  const trendFeatures = trends.trends.map((point) => pointFeature(point.lon, point.lat, {
    layer: "forecast_risk",
    city: point.city,
    stateAbbr: point.state,
    riskLevel: point.level,
    riskScore: point.score,
    maxWindMph: point.maxGust,
    rainHours: point.rainHours,
    thunderHours: point.thunderHours,
    sourceUrl: point.sourceUrl,
    source: trends.source
  }));

  const layers = {
    alerts: featureCollection("nws_alerts", alertFeatures, alerts.source, alerts.updated),
    outages: featureCollection("state_outages", outageFeatures, outages.source, outages.updated),
    trends: featureCollection("forecast_risk", trendFeatures, trends.source, trends.updated)
  };
  layers.combined = featureCollection(
    "east_coast_outage_weather_combined",
    [...alertFeatures, ...outageFeatures, ...trendFeatures],
    "Weather.gov, Outage.online, dashboard-derived forecast risk",
    new Date().toISOString()
  );
  return layers;
}

function geojsonUrl(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/geo+json" });
  return URL.createObjectURL(blob);
}

function downloadLink(label, filename, data) {
  return `<a class="download-link" href="${geojsonUrl(data)}" download="${filename}">${label}<span>${formatNumber(data.features.length)} features</span></a>`;
}

function renderGfs(data) {
  const areas = data.areas || [];
  const topAreas = [...areas].sort((a, b) => b.score - a.score).slice(0, 8);
  els.gfs.innerHTML = `
    <article class="item">
      <h2>Two-week pressure-drop areas</h2>
      <p>${data.source} Updated ${formatTime(data.updated)}.</p>
      <div class="source-actions">
        ${(data.modelLinks || []).map((link) => `<a href="${link.url}" target="_blank" rel="noreferrer">${link.name}</a>`).join("")}
      </div>
      <label class="layer-toggle">
        <span>Show pressure-drop areas</span>
        <input id="pressure-layer-toggle" type="checkbox" ${state.pressureVisible ? "checked" : ""}>
      </label>
      <div class="pressure-key">
        <span class="High">High</span>
        <span class="Elevated">Elevated</span>
        <span class="Watch">Watch</span>
        <span class="Low">Low</span>
      </div>
    </article>
    <article class="item">
      <h2>Largest forecast pressure drops</h2>
      ${topAreas.map((area) => `
        <div class="item">
          <div class="row">
            <h3>${area.point.city}, ${area.point.state}</h3>
            <span class="pill ${area.level}">${area.level}</span>
          </div>
          <p>${area.model}. ${area.pressureDrop} mbar drop from ${formatTime(area.startTime)} to ${formatTime(area.endTime)}. ${area.startPressure} mbar to ${area.endPressure} mbar; max wind ${area.maxWind} mph; precip ${area.precipTotal} in.</p>
        </div>
      `).join("")}
    </article>
    <article class="item">
      <h2>How to read this layer</h2>
      <p>The circles show sampled areas where pressure is forecast to move from higher to lower values during the next two weeks. Larger, warmer circles indicate sharper drops combined with lower pressure, wind, or precipitation, which can support cloud formation and storms.</p>
    </article>
  `;

  const toggle = document.querySelector("#pressure-layer-toggle");
  if (toggle) {
    toggle.addEventListener("change", () => {
      state.pressureVisible = toggle.checked;
      if (!state.layers.pressure) return;
      if (state.pressureVisible) {
        state.layers.pressure.addTo(map);
      } else {
        map.removeLayer(state.layers.pressure);
      }
    });
  }
}

setInterval(() => {
  if (state.nextRefresh && Date.now() >= state.nextRefresh) refreshAll();
}, 1000);

refreshAll();
