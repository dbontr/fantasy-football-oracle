"use strict";

const state = {
  players: [],
  selected: new Set(),
  forecasts: new Map(),
  forecastResult: null,
  position: "ALL",
  search: "",
  portfolios: {
    alpha: new Set(),
    beta: new Set(),
  },
};

const elements = {};
const ids = [
  "lab-health", "evidence-count", "chain-status", "feature-count", "evidence-head",
  "week-select", "scenario-select", "risk-range", "risk-output", "seed-input",
  "run-forecast-button", "player-search", "position-tabs", "player-list",
  "selection-count", "forecast-status", "forecast-empty", "forecast-list",
  "information-list", "compare-button", "portfolio-status", "alpha-players",
  "beta-players", "alpha-count", "beta-count", "alpha-result", "beta-result",
  "decision-strip", "what-if-player", "what-if-feature", "what-if-value",
  "what-if-confidence", "what-if-button", "what-if-result", "loading-template",
];

function bindElements() {
  ids.forEach((id) => { elements[id] = document.getElementById(id); });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function points(value) {
  return number(value).toFixed(1);
}

function percent(value) {
  return `${Math.round(number(value) * 100)}%`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.message || `${url} returned HTTP ${response.status}`);
    error.status = response.status;
    error.code = body?.code || "REQUEST_FAILED";
    throw error;
  }
  return body;
}

function setHealth(mode, message) {
  elements["lab-health"].classList.toggle("is-ready", mode === "ready");
  elements["lab-health"].classList.toggle("is-error", mode === "error");
  elements["lab-health"].querySelector("span:last-child").textContent = message;
}

function setForecastStatus(message, mode = "neutral") {
  elements["forecast-status"].textContent = message;
  elements["forecast-status"].dataset.mode = mode;
}

function showError(error, target = elements["forecast-list"]) {
  target.innerHTML = `
    <div class="empty-state">
      <div><strong>Analysis interrupted</strong><p>${escapeHtml(error.message)}</p></div>
    </div>`;
  setForecastStatus(error.code || "Request failed", "error");
}

function initializeControls() {
  for (let week = 1; week <= 18; week += 1) {
    const option = document.createElement("option");
    option.value = String(week);
    option.textContent = `Week ${week}`;
    elements["week-select"].append(option);
  }
  elements["risk-range"].addEventListener("input", () => {
    elements["risk-output"].textContent = `${elements["risk-range"].value}%`;
  });
  elements["player-search"].addEventListener("input", () => {
    state.search = elements["player-search"].value.trim().toLowerCase();
    renderPlayerList();
  });
  elements["position-tabs"].addEventListener("click", (event) => {
    const button = event.target.closest("button[data-position]");
    if (!button) return;
    state.position = button.dataset.position;
    elements["position-tabs"].querySelectorAll("button").forEach((row) => {
      row.classList.toggle("is-active", row === button);
    });
    renderPlayerList();
  });
  elements["run-forecast-button"].addEventListener("click", runForecasts);
  elements["compare-button"].addEventListener("click", comparePortfolios);
  elements["what-if-button"].addEventListener("click", runWhatIf);
  elements["forecast-list"].addEventListener("click", (event) => {
    const button = event.target.closest("button[data-portfolio][data-player-id]");
    if (!button) return;
    addToPortfolio(button.dataset.portfolio, button.dataset.playerId);
  });
  ["alpha", "beta"].forEach((portfolio) => {
    elements[`${portfolio}-players`].addEventListener("click", (event) => {
      const button = event.target.closest("button[data-remove-player]");
      if (!button) return;
      state.portfolios[portfolio].delete(button.dataset.removePlayer);
      renderPortfolio(portfolio);
      updatePortfolioControls();
    });
  });
}

function playerRank(player) {
  return number(player.pprRank, number(player.rank, 9999));
}

function visiblePlayers() {
  return state.players
    .filter((player) => state.position === "ALL" || player.position === state.position)
    .filter((player) => {
      if (!state.search) return true;
      return `${player.name} ${player.team} ${player.position}`.toLowerCase().includes(state.search);
    })
    .sort((left, right) => playerRank(left) - playerRank(right))
    .slice(0, 220);
}

function togglePlayer(id) {
  const key = String(id);
  if (state.selected.has(key)) {
    state.selected.delete(key);
    state.portfolios.alpha.delete(key);
    state.portfolios.beta.delete(key);
  } else if (state.selected.size < 8) {
    state.selected.add(key);
  }
  renderPlayerList();
  renderSelectionState();
  renderPortfolio("alpha");
  renderPortfolio("beta");
  updatePortfolioControls();
}

function renderPlayerList() {
  const rows = visiblePlayers();
  elements["player-list"].innerHTML = "";
  if (!rows.length) {
    elements["player-list"].innerHTML = '<p class="quiet-copy">No players match this filter.</p>';
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((player) => {
    const id = String(player.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "player-row";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(state.selected.has(id)));
    button.innerHTML = `
      <span class="position-badge">${escapeHtml(player.position)}</span>
      <span><strong>${escapeHtml(player.name)}</strong><small>${escapeHtml(player.team)} · ${points(player.weeklyProjection)} projected</small></span>
      <span class="player-rank">#${escapeHtml(playerRank(player))}</span>`;
    button.addEventListener("click", () => togglePlayer(id));
    fragment.append(button);
  });
  elements["player-list"].append(fragment);
}

function renderSelectionState() {
  elements["selection-count"].textContent = `${state.selected.size} / 8`;
  elements["run-forecast-button"].disabled = state.selected.size === 0;
  const selectedForecasts = [...state.selected].filter((id) => state.forecasts.has(id));
  elements["what-if-player"].innerHTML = selectedForecasts.length
    ? selectedForecasts.map((id) => {
      const player = state.forecasts.get(id).player;
      return `<option value="${escapeHtml(id)}">${escapeHtml(player.name)} · ${escapeHtml(player.position)}</option>`;
    }).join("")
    : '<option value="">Run forecasts first</option>';
  elements["what-if-button"].disabled = selectedForecasts.length === 0;
}

function renderLoading() {
  elements["forecast-empty"].hidden = true;
  elements["forecast-list"].innerHTML = "";
  elements["forecast-list"].append(elements["loading-template"].content.cloneNode(true));
  setForecastStatus("Resolving evidence and paired uncertainty", "loading");
}

function rangePosition(value, maximum) {
  return Math.max(0, Math.min(100, maximum > 0 ? number(value) / maximum * 100 : 0));
}

function contributionMarkup(contributions = []) {
  const rows = contributions.slice(0, 4);
  if (!rows.length) return '<span class="driver-chip">Baseline model only</span>';
  return rows.map((row) => {
    const direction = number(row.impact) > 0.02 ? "is-up" : number(row.impact) < -0.02 ? "is-down" : "";
    const sign = number(row.impact) > 0 ? "+" : "";
    return `<span class="driver-chip ${direction}">${escapeHtml(row.label)} ${sign}${points(row.impact)}</span>`;
  }).join("");
}

function forecastCard(forecast, maximum) {
  const id = String(forecast.player.id);
  const distribution = forecast.distribution;
  const p10 = rangePosition(distribution.p10, maximum);
  const p50 = rangePosition(distribution.p50, maximum);
  const p90 = rangePosition(distribution.p90, maximum);
  const average = rangePosition(distribution.mean, maximum);
  const warnings = forecast.warnings?.length || 0;
  return `
    <article class="forecast-card ${warnings ? "is-warning" : ""}" data-player-id="${escapeHtml(id)}">
      <div class="forecast-meta">
        <div class="forecast-player">
          <span class="position-badge">${escapeHtml(forecast.player.position)}</span>
          <span><strong>${escapeHtml(forecast.player.name)}</strong><small>${escapeHtml(forecast.player.team)} · Week ${forecast.week}</small></span>
        </div>
        <div class="forecast-score"><strong>${points(distribution.mean)}</strong><span>expected points</span></div>
      </div>
      <div class="range-scale" aria-label="${escapeHtml(forecast.player.name)} forecast range from ${points(distribution.p10)} to ${points(distribution.p90)}">
        <span class="range-band" style="left:${p10}%;width:${Math.max(1, p90 - p10)}%"></span>
        <span class="range-marker floor" style="left:${p10}%" title="P10 ${points(distribution.p10)}"></span>
        <span class="range-marker median" style="left:${p50}%" title="Median ${points(distribution.p50)}"></span>
        <span class="range-marker mean" style="left:${average}%" title="Mean ${points(distribution.mean)}"></span>
        <span class="range-marker ceiling" style="left:${p90}%" title="P90 ${points(distribution.p90)}"></span>
      </div>
      <div class="range-axis"><span>0</span><span>${points(maximum / 2)}</span><span>${points(maximum)}</span></div>
      <div class="forecast-telemetry">
        <div><span>Active</span><strong>${percent(forecast.availability.probability)}</strong></div>
        <div><span>Confidence</span><strong>${percent(forecast.confidence)}</strong></div>
        <div><span>Floor P10</span><strong>${points(distribution.p10)}</strong></div>
        <div><span>Ceiling P90</span><strong>${points(distribution.p90)}</strong></div>
      </div>
      <div class="driver-line">${contributionMarkup(forecast.contributions)}</div>
      <div class="forecast-actions">
        <button type="button" data-portfolio="alpha" data-player-id="${escapeHtml(id)}">Add to Slate A</button>
        <button type="button" data-portfolio="beta" data-player-id="${escapeHtml(id)}">Add to Slate B</button>
      </div>
    </article>`;
}

function renderInformationNeeds(rows = []) {
  if (!rows.length) {
    elements["information-list"].innerHTML = '<p class="quiet-copy">No material information gaps were ranked.</p>';
    return;
  }
  elements["information-list"].innerHTML = rows.slice(0, 9).map((row) => `
    <div class="information-call">
      <span class="call-rank">${row.rank}</span>
      <span><strong>${escapeHtml(row.key.replace(/^family:|^feature:/, "").replaceAll("_", " "))}</strong><small>${escapeHtml(row.reasons.join(" · "))}</small></span>
      <code>${points(row.score)}</code>
    </div>`).join("");
}

function renderForecasts(result) {
  state.forecastResult = result;
  state.forecasts = new Map(result.forecasts.map((forecast) => [String(forecast.player.id), forecast]));
  const maximum = Math.max(10, ...result.forecasts.map((forecast) => number(forecast.distribution.p90))) * 1.08;
  elements["forecast-empty"].hidden = true;
  elements["forecast-list"].innerHTML = result.forecasts
    .sort((left, right) => right.distribution.mean - left.distribution.mean)
    .map((forecast) => forecastCard(forecast, maximum))
    .join("");
  setForecastStatus(`${result.forecasts.length} distributions · ${result.digest.slice(0, 10)}`, "ready");
  elements["evidence-head"].textContent = result.evidenceHead;
  renderInformationNeeds(result.informationNeeds);
  renderSelectionState();
  updatePortfolioControls();
}

async function runForecasts() {
  if (!state.selected.size) return;
  renderLoading();
  elements["run-forecast-button"].disabled = true;
  try {
    const result = await fetchJson("/api/v5/forecast", {
      method: "POST",
      body: JSON.stringify({
        playerIds: [...state.selected],
        week: number(elements["week-select"].value, 1),
      }),
    });
    renderForecasts(result);
  } catch (error) {
    showError(error);
  } finally {
    elements["run-forecast-button"].disabled = state.selected.size === 0;
  }
}

function playerName(id) {
  return state.forecasts.get(String(id))?.player?.name
    || state.players.find((player) => String(player.id) === String(id))?.name
    || id;
}

function addToPortfolio(portfolio, id) {
  const key = String(id);
  if (!state.forecasts.has(key)) return;
  state.portfolios[portfolio].add(key);
  renderPortfolio(portfolio);
  updatePortfolioControls();
}

function renderPortfolio(portfolio) {
  const container = elements[`${portfolio}-players`];
  const ids = [...state.portfolios[portfolio]];
  elements[`${portfolio}-count`].textContent = `${ids.length} player${ids.length === 1 ? "" : "s"}`;
  if (!ids.length) {
    container.innerHTML = "<p>Add players from the forecast board.</p>";
  } else {
    container.innerHTML = ids.map((id) => `
      <span class="portfolio-chip">${escapeHtml(playerName(id))}
        <button type="button" data-remove-player="${escapeHtml(id)}" aria-label="Remove ${escapeHtml(playerName(id))}">×</button>
      </span>`).join("");
  }
  elements[`${portfolio}-result`].hidden = true;
  elements["decision-strip"].hidden = true;
}

function updatePortfolioControls() {
  const ready = state.portfolios.alpha.size > 0 && state.portfolios.beta.size > 0;
  elements["compare-button"].disabled = !ready;
  elements["portfolio-status"].textContent = ready
    ? "Ready for paired-world comparison."
    : "Assign at least one forecasted player to each slate.";
}

function portfolioResultMarkup(action, preferred) {
  return `
    <div class="result-score"><span>Robust score</span><strong>${points(action.robustScore)}</strong></div>
    <div class="result-grid">
      <div><span>Mean</span><strong>${points(action.summary.mean)}</strong></div>
      <div><span>P10</span><strong>${points(action.summary.p10)}</strong></div>
      <div><span>CVaR10</span><strong>${points(action.summary.cvar10)}</strong></div>
      <div><span>Best</span><strong>${percent(action.probabilityBest)}</strong></div>
      <div><span>P90</span><strong>${points(action.summary.p90)}</strong></div>
      <div><span>Regret</span><strong>${points(action.regret.expected)}</strong></div>
      <div><span>Target</span><strong>${percent(action.summary.targetProbability)}</strong></div>
      <div><span>Rank</span><strong>#${action.rank}${preferred ? " ✓" : ""}</strong></div>
    </div>`;
}

function renderPortfolioDecision(result) {
  const preferredId = result.decision.preferredActionId;
  ["alpha", "beta"].forEach((portfolio) => {
    const action = result.decision.actions.find((row) => row.id === portfolio);
    const target = elements[`${portfolio}-result`];
    target.hidden = false;
    target.classList.toggle("is-preferred", action.id === preferredId);
    target.innerHTML = portfolioResultMarkup(action, action.id === preferredId);
  });
  const preferred = result.decision.actions.find((row) => row.id === preferredId);
  elements["decision-strip"].hidden = false;
  elements["decision-strip"].innerHTML = `
    <strong>${preferredId === "alpha" ? "Slate A" : "Slate B"} survives best</strong>
    <p>${percent(preferred.probabilityBest)} probability of being best · ${percent(result.decision.stability)} policy stability · ${points(preferred.regret.expected)} expected regret.</p>
    <code>${escapeHtml(result.simulation.digest.slice(0, 14))}</code>`;
  elements["portfolio-status"].textContent = `${result.simulation.scenarios.toLocaleString()} paired worlds evaluated`;
}

async function comparePortfolios() {
  if (elements["compare-button"].disabled) return;
  elements["compare-button"].disabled = true;
  elements["portfolio-status"].textContent = "Running the same future worlds for both slates…";
  let completed = false;
  try {
    const result = await fetchJson("/api/v5/portfolio/evaluate", {
      method: "POST",
      body: JSON.stringify({
        portfolios: [
          { id: "alpha", label: "Slate A", playerIds: [...state.portfolios.alpha] },
          { id: "beta", label: "Slate B", playerIds: [...state.portfolios.beta] },
        ],
        week: number(elements["week-select"].value, 1),
        scenarios: number(elements["scenario-select"].value, 2000),
        seed: elements["seed-input"].value.trim() || "2026",
        riskAversion: number(elements["risk-range"].value, 40) / 100,
      }),
    });
    renderPortfolioDecision(result);
    completed = true;
  } catch (error) {
    elements["portfolio-status"].textContent = error.message;
  } finally {
    const ready = state.portfolios.alpha.size > 0 && state.portfolios.beta.size > 0;
    elements["compare-button"].disabled = !ready;
    if (!completed && ready && !elements["portfolio-status"].textContent) {
      elements["portfolio-status"].textContent = "Ready for paired-world comparison.";
    }
  }
}

function whatIfObservation(playerId) {
  return {
    entityType: "player",
    entityId: String(playerId),
    feature: elements["what-if-feature"].value,
    value: number(elements["what-if-value"].value),
    source: {
      name: "research-lab-what-if",
      reliability: number(elements["what-if-confidence"].value, 0.8),
    },
    confidence: number(elements["what-if-confidence"].value, 0.8),
    observedAt: new Date().toISOString(),
    metadata: { temporary: true, surface: "research-lab" },
  };
}

function renderWhatIf(baseline, hypothetical, observation) {
  const delta = number(hypothetical.distribution.mean) - number(baseline.distribution.mean);
  const direction = delta >= 0 ? "+" : "";
  elements["what-if-result"].hidden = false;
  elements["what-if-result"].innerHTML = `
    <div class="what-if-delta">
      <div><span>Current mean</span><strong>${points(baseline.distribution.mean)}</strong></div>
      <div class="what-if-arrow">→</div>
      <div><span>Hypothetical mean</span><strong>${points(hypothetical.distribution.mean)}</strong></div>
    </div>
    <p><strong>${direction}${points(delta)} points:</strong> ${escapeHtml(observation.feature)} = ${escapeHtml(observation.value)}. Confidence changes from ${percent(baseline.confidence)} to ${percent(hypothetical.confidence)}; P10 moves ${points(baseline.distribution.p10)} → ${points(hypothetical.distribution.p10)}.</p>`;
}

async function runWhatIf() {
  const playerId = elements["what-if-player"].value;
  const baseline = state.forecasts.get(String(playerId));
  if (!baseline) return;
  const observation = whatIfObservation(playerId);
  elements["what-if-button"].disabled = true;
  elements["what-if-result"].hidden = false;
  elements["what-if-result"].textContent = "Resolving temporary evidence…";
  try {
    const result = await fetchJson("/api/v5/what-if", {
      method: "POST",
      body: JSON.stringify({
        playerIds: [playerId],
        week: number(elements["week-select"].value, 1),
        additionalObservations: [observation],
      }),
    });
    renderWhatIf(baseline, result.forecasts[0], observation);
  } catch (error) {
    elements["what-if-result"].textContent = error.message;
  } finally {
    elements["what-if-button"].disabled = false;
  }
}

async function loadApplication() {
  setHealth("loading", "Connecting to v5 intelligence");
  const [status, dataset] = await Promise.all([
    fetchJson("/api/v5/status"),
    fetchJson("/api/data/players", { headers: { "content-type": "application/json" } }),
  ]);
  state.players = Array.isArray(dataset.players) ? dataset.players : [];
  elements["evidence-count"].textContent = number(status.evidence?.observations).toLocaleString();
  elements["chain-status"].textContent = status.evidence?.valid ? "Verified" : "Unsafe";
  elements["feature-count"].textContent = number(status.catalog?.features).toLocaleString();
  elements["evidence-head"].textContent = status.evidence?.headHash || "not available";
  setHealth(
    status.initialized && status.evidence?.valid ? "ready" : "error",
    status.initialized && status.evidence?.valid
      ? "v5 intelligence ready"
      : "Evidence integrity requires attention",
  );

  state.players
    .filter((player) => ["QB", "RB", "WR", "TE"].includes(player.position))
    .sort((left, right) => playerRank(left) - playerRank(right))
    .slice(0, 4)
    .forEach((player) => state.selected.add(String(player.id)));
  renderPlayerList();
  renderSelectionState();
}

async function initialize() {
  bindElements();
  initializeControls();
  renderPortfolio("alpha");
  renderPortfolio("beta");
  try {
    await loadApplication();
  } catch (error) {
    setHealth("error", error.message);
    showError(error, elements["player-list"]);
  }
}

document.addEventListener("DOMContentLoaded", initialize);
