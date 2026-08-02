(() => {
  "use strict";

  const core = window.FantasyOracleCore;
  if (!core) throw new Error("FantasyOracleCore failed to load");

  const STORAGE_KEY = "fantasy-football-oracle:v1";
  const TREND_CACHE_KEY = "fantasy-football-oracle:trends:v1";
  const PLAYER_DATA_URL = "data/players-2026.json";
  const SLEEPER_API = "https://api.sleeper.app/v1";
  const ORACLE_ORIGIN = window.location.origin;
  const API_ROOT = "/api";

  const POSITION_BY_ESPN_ID = {
    1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST",
  };
  const TEAM_BY_ESPN_ID = {
    0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE",
    6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND",
    12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE",
    18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT",
    24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR",
    30: "JAX", 33: "BAL", 34: "HOU",
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  let dataset = { meta: {}, schedule: {}, players: [] };
  let schedule = {};
  let players = [];
  let playerMap = new Map();
  let sleeperPlayerMap = null;
  let sleeperLeagues = [];
  let sleeperPollTimer = null;
  let recommendationMap = new Map();
  let trendCounts = new Map();
  let simulationWorker = null;
  let simulationResult = null;
  let simulationRequestId = 0;
  let simulationKey = "";
  let nativeRecommendationRows = null;
  let nativeRecommendationKey = "";
  const simulationRequestKeys = new Map();
  let simulationTimer = null;
  let generatedTradeProposals = [];
  let installPrompt = null;
  let backend = { available: false, health: null };
  let basePlayerIds = new Set();
  let nativeTeamSnapshot = null;
  let nativeTeamRequestId = 0;
  let nativeTradeAnalysis = null;
  let nativeTradeRequestId = 0;
  let platformStatus = null;
  let championshipResult = null;
  let championshipRequestId = 0;
  function defaultState() {
    const settings = core.cloneSettings();
    return {
      version: 3,
      activeView: "draft",
      selectedWeek: 1,
      tradeWeek: 1,
      settings,
      draft: core.createDraftState(settings),
      teamNames: {},
      leagueRosters: {},
      leagueContext: {
        leagueId: "local-league",
        userTeamId: "",
        standings: {},
        schedule: [],
        settings: {},
        source: { provider: "manual", fetchedAt: null },
      },
      tradeOpponentTeamId: "",
      manualRosterIds: [],
      manualRosterInitialized: false,
      draftOverrideTeamId: 1,
      filters: {
        draftQuery: "",
        draftPosition: "ALL",
        draftSort: "oracle",
        rosterQuery: "",
        tradeGiveQuery: "",
        tradeReceiveQuery: "",
      },
      trade: { giveIds: [], receiveIds: [] },
      connections: {
        sleeper: {},
        espn: {},
      },
    };
  }

  function hydrateState(raw) {
    const fallback = defaultState();
    if (!raw || typeof raw !== "object") return fallback;
    const settings = core.cloneSettings(raw.settings || fallback.settings);
    const draft = raw.draft?.picks && raw.draft?.rosters
      ? raw.draft
      : core.createDraftState(settings);
    return {
      ...fallback,
      ...raw,
      settings,
      draft,
      filters: { ...fallback.filters, ...(raw.filters || {}) },
      selectedWeek: Math.min(18, Math.max(1, Number(raw.selectedWeek || fallback.selectedWeek))),
      tradeWeek: Math.min(18, Math.max(1, Number(raw.tradeWeek || fallback.tradeWeek))),
      leagueRosters: { ...(raw.leagueRosters || {}) },
      leagueContext: raw.leagueContext && typeof raw.leagueContext === "object"
        ? {
            leagueId: String(raw.leagueContext.leagueId || "local-league"),
            userTeamId: String(raw.leagueContext.userTeamId || ""),
            standings: { ...(raw.leagueContext.standings || {}) },
            schedule: Array.isArray(raw.leagueContext.schedule) ? raw.leagueContext.schedule : [],
            settings: { ...(raw.leagueContext.settings || {}) },
            source: { ...(raw.leagueContext.source || { provider: "manual", fetchedAt: null }) },
          }
        : fallback.leagueContext,
      tradeOpponentTeamId: String(raw.tradeOpponentTeamId || ""),
      trade: { ...fallback.trade, ...(raw.trade || {}) },
      connections: {
        sleeper: { ...(raw.connections?.sleeper || {}) },
        espn: { ...(raw.connections?.espn || {}) },
      },
    };
  }

  function loadState() {
    try {
      return hydrateState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
    } catch {
      return defaultState();
    }
  }

  let state = loadState();

  function persistState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function canonicalName(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function teamName(teamId) {
    const id = String(teamId);
    if (Number(teamId) === Number(state.settings.draftPosition)) {
      return state.teamNames[id] || "My Team";
    }
    return state.teamNames[id] || `Team ${teamId}`;
  }

  function playerById(id) {
    return playerMap.get(String(id));
  }

  function playerAvatar(player, className = "") {
    if (!player) return `<span class="player-avatar ${className}" aria-hidden="true"></span>`;
    const image = escapeHtml(player.image || "");
    const fallback = escapeHtml((player.name || "?").split(/\s+/).map((part) => part[0]).slice(0, 2).join(""));
    return `<span class="player-avatar ${className}" aria-hidden="true">${image ? `<img src="${image}" alt="" loading="lazy" data-avatar-fallback="${fallback}" />` : fallback}</span>`;
  }

  function positionStyle(player) {
    return `--position-color:${core.positionColor(player?.position)}`;
  }

  function toast(message, isError = false) {
    const region = $("#toast-region");
    const item = document.createElement("div");
    item.className = `toast${isError ? " is-error" : ""}`;
    item.textContent = message;
    region.append(item);
    window.setTimeout(() => item.remove(), 4200);
  }

  async function apiRequest(endpoint, options = {}, timeoutMs = 60_000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(API_ROOT + endpoint, {
        ...options,
        headers: {
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || `Oracle server returned HTTP ${response.status}`);
      }
      return response.json();
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function initializeBackend() {
    try {
      const health = await apiRequest("/health", { cache: "no-store" }, 3500);
      backend = { available: health.status === "ok", health };
      platformStatus = health.platform || null;
      const simulations = Number(health.compute?.defaultSimulations || 15000);
      const button = $("#run-simulation-button");
      if (button) button.textContent = `Run ${simulations.toLocaleString()} paths`;
      return backend.available;
    } catch {
      backend = { available: false, health: null };
      platformStatus = null;
      return false;
    }
  }

  function playerOverridesForServer() {
    return players.filter((player) => !basePlayerIds.has(player.id)).slice(0, 120);
  }

  function setDataStatus(text, mode = "loading") {
    $("#data-status-text").textContent = text;
    const light = $("#data-status-light");
    light.className = `status-light${mode === "ready" ? " is-ready" : mode === "error" ? " is-error" : ""}`;
  }
  async function loadBundledData(cache = "default") {
    setDataStatus("Loading 2026 player model");
    let source = "bundled";
    let payload = null;
    if (backend.available) {
      try {
        payload = await apiRequest("/data/players", { cache: "no-store" }, 20_000);
        source = "server";
      } catch (error) {
        console.warn("Oracle server data unavailable", error);
        backend.available = false;
      }
    }
    if (!payload) {
      const response = await fetch(PLAYER_DATA_URL, { cache });
      if (!response.ok) throw new Error(`Player data returned HTTP ${response.status}`);
      payload = await response.json();
    }
    dataset = payload;
    schedule = dataset.schedule || {};
    players = (dataset.players || []).map(core.normalizePlayer);
    playerMap = new Map(players.map((player) => [player.id, player]));
    basePlayerIds = new Set(players.map((player) => player.id));
    const updated = dataset.meta?.modelGeneratedAt || dataset.meta?.generatedAt;
    const updatedLabel = updated
      ? new Date(updated).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "bundled";
    const modelLabel = source === "server"
      ? `server ensemble · ${dataset.meta?.modelVersion || "modeled"}`
      : "offline snapshot";
    setDataStatus(`${players.length} players · ${modelLabel} · ${updatedLabel}`, "ready");
  }

  function setView(view, updateHash = true) {
    const target = ["draft", "team", "trade", "connect"].includes(view) ? view : "draft";
    state.activeView = target;
    $$("[data-view-panel]").forEach((panel) => {
      const active = panel.dataset.viewPanel === target;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    });
    $$("[data-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === target);
      button.setAttribute("aria-current", button.dataset.view === target ? "page" : "false");
    });
    if (updateHash) history.replaceState(null, "", `#${target}`);
    persistState();
    renderActiveView();
  }

  function renderActiveView() {
    renderGlobalStatus();
    if (!players.length) return;
    if (state.activeView === "draft") renderDraftView();
    if (state.activeView === "team") renderTeamView();
    if (state.activeView === "trade") renderTradeView();
    if (state.activeView === "connect") renderConnectView();
  }

  function renderAll() {
    renderGlobalStatus();
    if (!players.length) return;
    renderDraftView();
    renderTeamView();
    renderTradeView();
    renderConnectView();
  }

  function renderGlobalStatus() {
    const settings = state.settings;
    const scoring = settings.scoring === "half"
      ? "Half PPR"
      : settings.scoring === "superflex"
        ? "Superflex"
        : settings.scoring.toUpperCase();
    const nativeMode = backend.health?.compute?.mode === "native-cpp-primary";
    const compute = backend.available ? (nativeMode ? "native C++" : "server compute") : "browser fallback";
    const historical = backend.health?.historical?.ready
      ? " · " + Number(backend.health.historical.draftReplays || 0).toLocaleString() + " historical replays"
      : "";
    $("#league-status-text").textContent = `${settings.teams}-team ${scoring} · Pick ${settings.draftPosition} · ${compute}${historical}`;
  }
  function draftRosterIds(teamId) {
    return state.draft.rosters?.[String(teamId)] || [];
  }

  function rosterPlayersFromIds(ids) {
    return (ids || []).map(playerById).filter(Boolean);
  }

  function weekOptions(selectedWeek) {
    return Array.from({ length: 18 }, (_, index) => {
      const week = index + 1;
      return '<option value="' + week + '"' + (week === Number(selectedWeek) ? ' selected' : '') + '>Week ' + week + '</option>';
    }).join("");
  }

  function playerGame(player, week = state.selectedWeek) {
    const selectedWeek = Math.min(18, Math.max(1, Number(week || 1)));
    if (!player || Number(player.byeWeek) === selectedWeek) {
      return { bye: true, opponent: "BYE", home: false, detail: "Bye week", indoor: false };
    }
    const game = schedule?.[player.team]?.weeks?.[selectedWeek - 1];
    return game ? { ...game, bye: false } : { bye: false, opponent: "TBD", home: false, detail: "Schedule TBD", indoor: false };
  }

  function draftSimulationSignature(targetTeamId) {
    const picks = (state.draft.picks || []).map((pick) => pick.playerId + ':' + pick.teamId).join('|');
    const settings = state.settings;
    return [
      targetTeamId,
      picks,
      settings.teams,
      settings.rounds,
      settings.scoring,
      JSON.stringify(settings.slots),
    ].join('::');
  }

  function setSimulationStatus(message, running = false) {
    const element = $("#simulation-status");
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("is-running", running);
  }

  function initializeSimulationWorker() {
    if (simulationWorker || typeof Worker === "undefined") return;
    try {
      simulationWorker = new Worker("simulation-worker.js");
      simulationWorker.addEventListener("message", (event) => {
        const message = event.data || {};
        if (!String(message.type || "").startsWith("draft-window-")) return;
        const key = simulationRequestKeys.get(message.requestId);
        simulationRequestKeys.delete(message.requestId);
        if (message.type === "draft-window-error") {
          setSimulationStatus(message.error || "Simulation failed");
          return;
        }
        if (!key || key !== draftSimulationSignature(message.result?.targetTeamId)) return;
        simulationResult = message.result;
        simulationKey = key;
        setSimulationStatus(message.result.simulations.toLocaleString() + " paths complete");
        if (state.activeView === "draft") renderDraftView(false);
      });
      simulationWorker.addEventListener("error", () => {
        setSimulationStatus("Worker unavailable · analytical estimates active");
        simulationWorker?.terminate();
        simulationWorker = null;
      });
    } catch {
      simulationWorker = null;
    }
  }

  function runBrowserDraftSimulation(options, requestId, key) {
    const localOptions = {
      ...options,
      simulations: Math.min(1000, Number(options.simulations || 700)),
    };
    initializeSimulationWorker();
    if (simulationWorker) {
      simulationRequestKeys.set(requestId, key);
      simulationWorker.postMessage({
        type: "simulate-draft-window",
        requestId,
        options: localOptions,
      });
      return;
    }
    window.setTimeout(() => {
      try {
        simulationResult = core.simulatePickWindow({
          ...localOptions,
          simulations: Math.min(350, localOptions.simulations),
        });
        simulationKey = key;
        setSimulationStatus(simulationResult.simulations.toLocaleString() + " browser paths complete");
        if (state.activeView === "draft") renderDraftView(false);
      } catch (error) {
        setSimulationStatus(error.message || "Simulation failed");
      }
    }, 0);
  }

  function requestDraftSimulation(simulations = 700, immediate = false) {
    if (!players.length) return;
    const summary = core.draftPickSummary(state.draft, state.settings);
    const targetTeamId = Number(state.draftOverrideTeamId) || summary.teamId;
    const key = draftSimulationSignature(targetTeamId);
    if (!immediate && simulationKey === key && simulationResult) return;
    if (simulationTimer) window.clearTimeout(simulationTimer);
    const execute = async () => {
      const requestId = ++simulationRequestId;
      const serverDefault = Number(backend.health?.compute?.defaultSimulations || 15000);
      const serverMaximum = Number(backend.health?.compute?.maxSimulations || 50000);
      const desired = backend.available
        ? Math.min(serverMaximum, immediate ? serverDefault * 2 : serverDefault)
        : simulations;
      const options = {
        players,
        state: state.draft,
        settings: state.settings,
        targetTeamId,
        simulations: desired,
        seed: state.draft.picks.length * 104729 + targetTeamId * 7919 + Number(dataset.meta?.season || 2026),
        trackLimit: backend.available ? 260 : 180,
      };
      if (backend.available) {
        setSimulationStatus("Native C++ simulating " + desired.toLocaleString() + " draft paths…", true);
        try {
          const response = await apiRequest("/draft/recommendations", {
            method: "POST",
            body: JSON.stringify({
              state: state.draft,
              settings: state.settings,
              targetTeamId,
              simulations: desired,
              seed: options.seed,
              limit: 260,
              playerOverrides: playerOverridesForServer(),
            }),
          }, 100_000);
          if (requestId !== simulationRequestId || key !== draftSimulationSignature(targetTeamId)) return;
          simulationResult = response.data.simulation;
          simulationKey = key;
          nativeRecommendationRows = response.data.recommendations;
          nativeRecommendationKey = key;
          setSimulationStatus(
            response.data.simulation.simulations.toLocaleString() + " native C++ paths · " + response.computeMs.toFixed(0) + " ms",
          );
          if (state.activeView === "draft") renderDraftView(false);
          return;
        } catch (error) {
          console.warn("Server draft simulation failed", error);
          setSimulationStatus("Server compute unavailable · browser fallback", true);
        }
      } else {
        setSimulationStatus("Browser simulating " + Number(simulations).toLocaleString() + " paths…", true);
      }
      runBrowserDraftSimulation(options, requestId, key);
    };
    if (immediate) execute();
    else simulationTimer = window.setTimeout(execute, 180);
  }

  function computeDraftRecommendations(teamId) {
    const currentKey = draftSimulationSignature(teamId);
    if (nativeRecommendationKey === currentKey && nativeRecommendationRows?.length) {
      const rows = nativeRecommendationRows.map(core.normalizePlayer);
      recommendationMap = new Map(rows.map((player) => [player.id, player]));
      return rows;
    }
    const activeSimulation = simulationKey === currentKey ? simulationResult : null;
    const rows = core.advancedDraftRecommendations(
      players,
      state.draft,
      state.settings,
      teamId,
      260,
      activeSimulation,
    );
    recommendationMap = new Map(rows.map((player) => [player.id, player]));
    return rows;
  }

  function renderDraftCommand(recommendations) {
    const summary = core.draftPickSummary(state.draft, state.settings);
    const selectedTeam = Number(state.draftOverrideTeamId) || summary.teamId;
    $("#draft-clock-label").textContent = summary.isUserPick ? "Your pick" : "On the clock";
    $("#draft-clock-value").textContent = `Round ${summary.round} · Pick ${summary.pickNumber}`;
    $("#draft-clock-team").textContent = teamName(summary.teamId);

    const select = $("#draft-team-override");
    select.innerHTML = Array.from({ length: state.settings.teams }, (_, index) => {
      const teamId = index + 1;
      return `<option value="${teamId}">${escapeHtml(teamName(teamId))}</option>`;
    }).join("");
    select.value = String(selectedTeam);

    const top = recommendations[0];
    const container = $("#top-recommendation");
    const action = $("#draft-top-player-button");
    if (!top) {
      container.innerHTML = `<div><span class="play-call">Draft complete</span><h1>No players remain</h1><p>Reset the board or change the league settings.</p></div>`;
      action.disabled = true;
      action.dataset.playerId = "";
      return;
    }

    const policyLabel = Number.isFinite(top.policyRank)
      ? `policy rank ${top.policyRank.toFixed(1)}`
      : `score ${top.score.toFixed(1)}`;
    container.innerHTML = `${playerAvatar(top, "player-avatar-large")}<div>
      <span class="play-call">${escapeHtml(top.decision || "Oracle's call")} · ${escapeHtml(top.position)} · ${policyLabel}</span>
      <h1>${escapeHtml(top.name)}</h1>
      <p>${escapeHtml([
        ...(top.reasons || []),
        top.coachingContext
          ? `${top.coachingContext.offensivePlayCaller} · ${top.coachingContext.scheme} · ${((top.coachingContext.meanFactor - 1) * 100).toFixed(1)}% coaching context`
          : null,
        top.decisionIntelligence
          ? `${top.decisionIntelligence.archetype} · ${top.decisionIntelligence.opportunity.index}/100 opportunity · ${Math.round(top.decisionIntelligence.consensus.conviction * 100)}% conviction`
          : null,
      ].filter(Boolean).join(" · "))}</p>
    </div>`;
    action.disabled = false;
    action.dataset.playerId = top.id;
    action.textContent = `Draft ${top.name}`;
  }
  function renderDecisionHorizon(recommendations) {
    const top = recommendations[0];
    const summary = core.draftPickSummary(state.draft, state.settings);
    if (!top) {
      $("#decision-return-chance").textContent = "—";
      $("#decision-vona").textContent = "—";
      $("#decision-urgency").textContent = "—";
      $("#decision-next-pick").textContent = "—";
      $("#decision-picks-away").textContent = "Draft complete";
      $("#draft-horizon-list").innerHTML = '<div class="empty-state">No remaining draft decisions.</div>';
      return;
    }
    const picksAway = Math.max(0, Number(top.nextTeamPick || summary.pickNumber) - summary.pickNumber);
    $("#decision-return-chance").textContent = Math.round(top.returnChance * 100) + "%";
    $("#decision-vona").textContent = (top.vona >= 0 ? "+" : "") + top.vona.toFixed(1);
    $("#decision-urgency").textContent = top.urgency.toFixed(0);
    $("#decision-next-pick").textContent = "#" + top.nextTeamPick;
    $("#decision-picks-away").textContent = picksAway + " selection" + (picksAway === 1 ? "" : "s") + " away";
    const currentKey = draftSimulationSignature(Number(state.draftOverrideTeamId) || summary.teamId);
    if (simulationKey !== currentKey && !$("#simulation-status").classList.contains("is-running")) {
      setSimulationStatus("Analytical estimate · simulation queued");
    }
    $("#draft-horizon-list").innerHTML = recommendations.slice(0, 5).map((player, index) =>
      '<div class="horizon-player' + (index === 0 ? ' is-top' : '') + '" style="' + positionStyle(player) + '">' +
        '<span class="horizon-player-rank">' + (index + 1) + '</span>' +
        '<span class="horizon-player-main"><strong>' + escapeHtml(player.name) + '</strong><span>' +
          escapeHtml(player.decision) + ' \u00b7 VONA ' + (player.vona >= 0 ? '+' : '') + player.vona.toFixed(1) +
          (Number.isFinite(player.rosterNeedFit) ? '\u00b7 need ' + player.rosterNeedFit.toFixed(0) + '/100' : '') +
          (player.historicalValue?.samples ? '\u00b7 hist ' + Math.round(player.historicalValue.hitRate * 100) + '% hit' : '') +
        '</span></span>' +
        '<span class="return-chip">' + Math.round(player.returnChance * 100) + '%<small>returns</small></span>' +
      '</div>'
    ).join("");
  }

  function displayRank(player) {
    return Math.round(core.rankForScoring(player, state.settings.scoring));
  }

  function playerRowHtml(player, action, actionLabel = "+") {
    const recommendation = recommendationMap.get(player.id);
    const policyRank = recommendation?.policyRank;
    const oracleScore = recommendation?.score;
    const metric = Number.isFinite(policyRank)
      ? policyRank.toFixed(1)
      : oracleScore !== undefined
        ? oracleScore.toFixed(1)
        : player.weeklyProjection.toFixed(1);
    const metricLabel = Number.isFinite(policyRank)
      ? "policy rank"
      : oracleScore !== undefined
        ? "oracle"
        : "weekly";
    return `<div class="player-row" role="listitem" style="${positionStyle(player)}" data-player-id="${escapeHtml(player.id)}">
      <span class="player-rank">${displayRank(player)}</span>
      <span class="player-name-block"><strong>${escapeHtml(player.name)}</strong><span>${escapeHtml(player.team)} · ${escapeHtml(player.injuryStatus)}</span></span>
      <span class="player-position">${escapeHtml(player.position)}</span>
      <span class="player-metric"><strong>${metric}</strong><span>${metricLabel}</span></span>
      <button class="player-action" type="button" data-action="${action}" data-player-id="${escapeHtml(player.id)}" aria-label="${escapeHtml(actionLabel)} ${escapeHtml(player.name)}">${escapeHtml(actionLabel)}</button>
    </div>`;
  }

  function renderDraftPlayerList(recommendations) {
    const drafted = new Set((state.draft.picks || []).map((pick) => String(pick.playerId)));
    const query = canonicalName(state.filters.draftQuery);
    const position = state.filters.draftPosition;
    let rows = players.filter((player) => !drafted.has(player.id));
    if (position !== "ALL") rows = rows.filter((player) => player.position === position);
    if (query) {
      rows = rows.filter((player) => canonicalName(`${player.name} ${player.team} ${player.position}`).includes(query));
    }

    const sort = state.filters.draftSort;
    rows.sort((a, b) => {
      if (sort === "projection") return b.projectedPoints - a.projectedPoints;
      if (sort === "adp") return (a.adp || 9999) - (b.adp || 9999);
      if (sort === "rank") return displayRank(a) - displayRank(b);
      const recommendationA = recommendationMap.get(a.id);
      const recommendationB = recommendationMap.get(b.id);
      if (Number.isFinite(recommendationA?.policyRank) || Number.isFinite(recommendationB?.policyRank)) {
        return (recommendationA?.policyRank ?? 9999) - (recommendationB?.policyRank ?? 9999);
      }
      const scoreA = recommendationA?.score ?? -displayRank(a);
      const scoreB = recommendationB?.score ?? -displayRank(b);
      return scoreB - scoreA;
    });

    $("#available-player-count").textContent = `${rows.length} available`;
    const visible = rows.slice(0, 140);
    $("#draft-player-list").innerHTML = visible.length
      ? visible.map((player) => playerRowHtml(player, "draft-player", "Draft")).join("")
      : `<div class="empty-state">No available players match these filters.</div>`;
  }
  function pickNumberForRoundTeam(round, teamId, teamCount) {
    const withinRound = round % 2 === 1 ? teamId : teamCount - teamId + 1;
    return (round - 1) * teamCount + withinRound;
  }

  function renderDraftBoard() {
    const teams = state.settings.teams;
    const rounds = state.settings.rounds;
    const currentPick = state.draft.picks.length + 1;
    const pickMap = new Map((state.draft.picks || []).map((pick) => [Number(pick.pick), pick]));
    const board = $("#draft-board");
    board.style.gridTemplateColumns = `58px repeat(${teams}, minmax(96px, 1fr))`;
    const html = [`<div class="draft-round-header">RD</div>`];

    for (let teamId = 1; teamId <= teams; teamId += 1) {
      html.push(`<div class="draft-team-header">${escapeHtml(teamName(teamId))}</div>`);
    }

    for (let round = 1; round <= rounds; round += 1) {
      html.push(`<div class="draft-round-header">${round}</div>`);
      for (let teamId = 1; teamId <= teams; teamId += 1) {
        const pickNumber = pickNumberForRoundTeam(round, teamId, teams);
        const pick = pickMap.get(pickNumber);
        const player = pick ? playerById(pick.playerId) : null;
        const originalTeamId = core.snakeTeamForPick(pickNumber, teams);
        const ownerLabel = pick && Number(pick.teamId) !== originalTeamId ? teamName(pick.teamId) : "";
        const classes = ["draft-cell"];
        if (ownerLabel) classes.push("is-traded");
        if (teamId === state.settings.draftPosition) classes.push("is-user-team");
        if (pickNumber === currentPick) classes.push("is-current");
        if (player) classes.push("is-filled");
        html.push(`<div class="${classes.join(" ")}" style="${positionStyle(player)}">
          <span class="draft-cell-pick">${pickNumber}</span>
          <strong>${player ? escapeHtml(player.name) : pickNumber === currentPick ? "ON CLOCK" : ""}</strong>
          <span>${player ? `${ownerLabel ? `${escapeHtml(ownerLabel)} · ` : ""}${escapeHtml(player.position)} · ${escapeHtml(player.team)}` : escapeHtml(teamName(teamId))}</span>
        </div>`);
      }
    }
    board.innerHTML = html.join("");

    const distance = core.picksUntilTeam(state.draft, state.settings, state.settings.draftPosition);
    $("#next-user-pick-text").textContent = distance === 0
      ? "You are on the clock."
      : distance === null
        ? "Your draft is complete."
        : `Your next pick is in ${distance} selection${distance === 1 ? "" : "s"}.`;
    $("#draft-progress-text").textContent = `${state.draft.picks.length} of ${teams * rounds} picks`;
  }
  function renderMyDraft(recommendations) {
    const teamId = state.settings.draftPosition;
    const roster = rosterPlayersFromIds(draftRosterIds(teamId));
    const counts = roster.reduce((acc, player) => {
      acc[player.position] = (acc[player.position] || 0) + 1;
      return acc;
    }, {});
    $("#my-draft-team-chip").textContent = teamName(teamId);

    const directPositions = ["QB", "RB", "WR", "TE", "DST", "K"];
    const needs = directPositions.map((position) => {
      const target = Number(state.settings.slots[position] || 0);
      const current = Number(counts[position] || 0);
      const open = Math.max(0, target - current);
      return `<span class="need-pill${open ? " is-open" : ""}">${position}<strong>${open ? `${open} open` : `${current}/${target}`}</strong></span>`;
    });
    const skillCount = ["RB", "WR", "TE"].reduce((sum, position) => sum + Number(counts[position] || 0), 0);
    const directSkillTarget = ["RB", "WR", "TE"].reduce((sum, position) => sum + Number(state.settings.slots[position] || 0), 0);
    if (state.settings.slots.FLEX > 0) {
      const extraSkillPlayers = Math.max(0, skillCount - directSkillTarget);
      const flexOpen = Math.max(0, Number(state.settings.slots.FLEX) - extraSkillPlayers);
      needs.splice(4, 0, `<span class="need-pill${flexOpen ? " is-open" : ""}">FLEX<strong>${flexOpen ? `${flexOpen} open` : "covered"}</strong></span>`);
    }
    $("#draft-roster-needs").innerHTML = needs.join("");

    $("#my-draft-roster").innerHTML = roster.length
      ? roster.map((player, index) => `<div class="roster-item" style="${positionStyle(player)}">
          ${playerAvatar(player)}
          <div class="roster-item-main"><strong>${escapeHtml(player.name)}</strong><span>Pick ${index + 1} · ${escapeHtml(player.position)} · ${escapeHtml(player.team)}</span></div>
          <strong class="player-position">${escapeHtml(player.position)}</strong>
        </div>`).join("")
      : `<div class="empty-state">Your drafted players will collect here.</div>`;

    const note = $("#draft-strategy-note");
    if (!roster.length) {
      note.innerHTML = `<strong>Build signal</strong><p>Stay flexible early. Draft value, then use tier cliffs to fill positional needs.</p>`;
    } else {
      const next = recommendations[0];
      const weakestNeed = directPositions.find((position) => Number(counts[position] || 0) < Number(state.settings.slots[position] || 0));
      note.innerHTML = `<strong>${weakestNeed ? `${weakestNeed} remains open` : "Starters are taking shape"}</strong><p>${next ? `${escapeHtml(next.name)} is the best current blend of value and construction.` : "Review your bench depth and injury exposure."}</p>`;
    }
  }

  function renderDraftView(scheduleSimulation = true) {
    const summary = core.draftPickSummary(state.draft, state.settings);
    if (!state.draftOverrideTeamId) state.draftOverrideTeamId = summary.teamId;
    const recommendations = computeDraftRecommendations(Number(state.draftOverrideTeamId) || summary.teamId);
    renderDraftCommand(recommendations);
    renderDecisionHorizon(recommendations);
    renderDraftPlayerList(recommendations);
    renderDraftBoard();
    renderMyDraft(recommendations);
    if (scheduleSimulation) requestDraftSimulation(700, false);
  }
  function activeRosterIds() {
    if (state.manualRosterInitialized) return state.manualRosterIds;
    return [...draftRosterIds(state.settings.draftPosition)];
  }

  function activeRosterPlayers() {
    return rosterPlayersFromIds(activeRosterIds());
  }

  function renderOptimizedLineup(
    roster,
    week = state.selectedWeek,
    providedLineup = null,
    confidenceById = null,
    regretById = null,
  ) {
    const lineup = providedLineup || core.optimizeWeeklyLineup(roster, state.settings, week);
    $("#lineup-total").textContent = lineup.total.toFixed(1) + " pts";
    $("#optimized-lineup").innerHTML = lineup.starters.map((row) => {
      const player = row.player;
      const game = playerGame(player, week);
      const gameLabel = !player ? "Add an eligible player" : game.bye
        ? "BYE · unavailable"
        : (game.home ? "vs " : "@ ") + game.opponent + " · " + game.detail;
      const projection = player
        ? Number.isFinite(Number(player.weekProjection))
          ? Number(player.weekProjection)
          : core.playerWeekProjection(player, week)
        : 0;
      const confidence = player && confidenceById?.get(player.id);
      const confidenceLabel = Number.isFinite(confidence)
        ? " · " + Math.round(confidence * 100) + "% start confidence"
        : "";
      const regret = player && regretById?.get(player.id);
      const intelligenceLabel = Number.isFinite(regret) && regret > 0.05
        ? regret.toFixed(1) + " expected-regret pts"
        : player?.decisionIntelligence?.archetype || "";
      return '<div class="lineup-slot" style="' + positionStyle(player || { position: row.slot }) + '">' +
        '<span class="lineup-slot-label">' + escapeHtml(row.slot) + '</span>' +
        playerAvatar(player) +
        '<div class="roster-item-main"><strong>' + (player ? escapeHtml(player.name) : 'Open slot') + '</strong>' +
        '<span>' + (player ? escapeHtml(player.team + ' · ' + player.position + confidenceLabel) : 'Add an eligible player') + '</span>' +
        '<span class="lineup-opponent">' + escapeHtml(gameLabel) + '</span>' +
        (intelligenceLabel ? '<span class="lineup-intelligence">' + escapeHtml(intelligenceLabel) + '</span>' : '') + '</div>' +
        '<strong>' + (player ? projection.toFixed(1) : '—') + '</strong>' +
      '</div>';
    }).join("");
    return lineup;
  }

  function renderRosterHealth(analysis, roster) {
    if (!roster.length) {
      $("#roster-health-grade").textContent = "—";
      $("#roster-health-score").textContent = "Build a roster to analyze it.";
      $("#roster-health-projection").textContent = "—";
      $("#roster-health-range").textContent = "—";
      $("#roster-health-season").textContent = "—";
      $("#roster-health-reliability").textContent = "—";
      $("#roster-health-notes").innerHTML = '<div class="health-note">Import, draft, or manually add players.</div>';
      $("#position-grades").innerHTML = "";
      return;
    }
    $("#roster-health-grade").textContent = analysis.grade;
    $("#roster-health-score").textContent = analysis.strengthScore.toFixed(0) + "/100 for Week " + analysis.week;
    $("#roster-health-projection").textContent = analysis.lineup.total.toFixed(1) + " pts";
    $("#roster-health-range").textContent = analysis.floor.toFixed(1) + "–" + analysis.ceiling.toFixed(1);
    $("#roster-health-season").textContent = analysis.seasonProjection.toFixed(0) + " pts";
    $("#roster-health-reliability").textContent = Math.round(analysis.reliability * 100) + "%";
    const notes = [];
    if (analysis.byePlayers.length) {
      notes.push('<div class="health-note is-danger">Week ' + analysis.week + ' byes: ' + analysis.byePlayers.map((player) => escapeHtml(player.name)).join(', ') + '</div>');
    }
    if (analysis.injuryPlayers.length) {
      notes.push('<div class="health-note is-warning">Injury monitor: ' + analysis.injuryPlayers.slice(0, 4).map((player) => escapeHtml(player.name + ' (' + player.injuryStatus + ')')).join(', ') + '</div>');
    }
    if (analysis.byeConflicts.length) {
      const worst = [...analysis.byeConflicts].sort((a, b) => b.players.length - a.players.length)[0];
      notes.push('<div class="health-note is-warning">Largest bye collision: Week ' + worst.week + ' with ' + worst.players.length + ' players.</div>');
    }
    if (analysis.seasonSimulation) {
      const simulation = analysis.seasonSimulation;
      notes.push('<div class="health-note">Native season model: ' +
        simulation.p10.toFixed(0) + '–' + simulation.p90.toFixed(0) +
        ' point 80% range · downside CVaR ' + simulation.cvar10.toFixed(0) + '.</div>');
    }
    if (analysis.leagueOdds) {
      const odds = analysis.leagueOdds;
      notes.push('<div class="health-note">League outlook: ' +
        odds.expectedWins.toFixed(1) + ' expected wins · ' +
        Math.round(odds.playoffProbability * 100) + '% playoffs · ' +
        Math.round(odds.championshipProbability * 100) + '% championship · ' +
        Math.round(odds.allPlayWinPct * 100) + '% all-play strength.</div>');
    }
    if (analysis.rosterUtility) {
      const utility = analysis.rosterUtility;
      const needs = (utility.worstNeeds || []).slice(0, 3)
        .map((row) => row.position + ' ' + Number(row.need || 0).toFixed(0) + '/100')
        .join(' · ');
      const historical = utility.historical?.coverage > 0
        ? ' · historical cohort coverage ' + Math.round(utility.historical.coverage * 100) + '%'
        : '';
      notes.push('<div class="health-note">Multi-week roster utility ' +
        Number(utility.total || 0).toFixed(1) + ' · need pressure ' +
        Number(utility.needPressure || 0).toFixed(0) + '/100 · ' +
        escapeHtml(needs || 'no urgent positional gap') + historical + '.</div>');
    }
    if (analysis.decisionRegret) {
      const regret = analysis.decisionRegret;
      const highest = regret.highestRegret;
      const detail = highest?.starter && highest?.alternative
        ? ' Highest counterfactual: ' + escapeHtml(highest.starter.name) + ' over ' + escapeHtml(highest.alternative.name) + '.'
        : '';
      notes.push('<div class="health-note' + (regret.fragileDecisions ? ' is-warning' : '') + '">Lineup uncertainty: ' +
        Number(regret.totalExpectedRegret || 0).toFixed(1) + ' expected-regret points across ' +
        Number(regret.fragileDecisions || 0) + ' fragile decisions.' + detail + '</div>');
    }
    notes.push('<div class="health-note">Priority positions: ' + analysis.weakestPositions.join(' and ') + ' · bench depth ' + analysis.benchProjection.toFixed(1) + '.</div>');
    $("#roster-health-notes").innerHTML = notes.join("");
    $("#position-grades").innerHTML = analysis.positions.map((row) =>
      '<div class="position-grade" style="--position-color:' + core.positionColor(row.position) + '">' +
        '<span>' + escapeHtml(row.position) + '</span><span>' + row.points.toFixed(1) + ' pts</span><strong>' + row.grade + '</strong>' +
      '</div>'
    ).join("");
  }

  function renderManualRoster(roster, lineup) {
    const starterIds = new Set(lineup.starters.filter((row) => row.player).map((row) => row.player.id));
    $("#manual-roster-count").textContent = `${roster.length} player${roster.length === 1 ? "" : "s"}`;
    $("#manual-roster-list").innerHTML = roster.length
      ? roster.sort((a, b) => Number(starterIds.has(b.id)) - Number(starterIds.has(a.id)) || b.weeklyProjection - a.weeklyProjection)
        .map((player) => {
          const game = playerGame(player, state.selectedWeek);
          const projection = core.playerWeekProjection(player, state.selectedWeek);
          const opponent = game.bye ? "BYE" : `${game.home ? "vs" : "@"} ${game.opponent}`;
          const intelligence = player.decisionIntelligence;
          const signal = intelligence
            ? `${intelligence.archetype} · ${intelligence.opportunity.index}/100 opportunity`
            : "base projection";
          return `<div class="roster-item" style="${positionStyle(player)}">
          ${playerAvatar(player)}
          <div class="roster-item-main"><strong>${escapeHtml(player.name)}</strong><span>${starterIds.has(player.id) ? "Starter" : "Bench"} · ${escapeHtml(player.position)} · ${projection.toFixed(1)} · ${escapeHtml(opponent)}</span><span class="lineup-intelligence">${escapeHtml(signal)}</span></div>
          <button class="remove-button" type="button" data-action="remove-roster-player" data-player-id="${escapeHtml(player.id)}" aria-label="Remove ${escapeHtml(player.name)}">×</button>
        </div>`;
        }).join("")
      : `<div class="empty-state">Add players manually, use your draft roster, or connect a league.</div>`;
  }

  function renderRosterSearch() {
    const query = canonicalName(state.filters.rosterQuery);
    const rosterIds = new Set(activeRosterIds().map(String));
    const results = query
      ? players.filter((player) => !rosterIds.has(player.id) && canonicalName(`${player.name} ${player.team} ${player.position}`).includes(query)).slice(0, 10)
      : [];
    $("#roster-search-results").innerHTML = results.map((player) => `<button class="search-result-item" type="button" data-action="add-roster-player" data-player-id="${escapeHtml(player.id)}">
      ${playerAvatar(player)}<span class="roster-item-main"><strong>${escapeHtml(player.name)}</strong><span>${escapeHtml(player.position)} · ${escapeHtml(player.team)} · ${player.weeklyProjection.toFixed(1)} weekly</span></span>
    </button>`).join("");
  }
  function freeAgentPool(rosterIds) {
    const unavailable = new Set((state.draft.picks || []).map((pick) => String(pick.playerId)));
    rosterIds.forEach((id) => unavailable.add(String(id)));
    const useDraftAvailability = state.draft.picks.length > 0;
    return players.filter((player) => {
      if (rosterIds.includes(player.id)) return false;
      return useDraftAvailability ? !unavailable.has(player.id) : true;
    });
  }

  function renderWaiverRecommendations(roster, providedSuggestions = null) {
    if (!roster.length) {
      $("#waiver-recommendations").innerHTML = `<div class="empty-state">Add a roster before running waiver analysis.</div>`;
      return;
    }
    let suggestions = providedSuggestions;
    if (!suggestions) {
      const rosterIds = roster.map((player) => player.id);
      const candidates = freeAgentPool(rosterIds)
        .map((player) => ({
          ...player,
          trendCount: trendCounts.get(canonicalName(player.name)) || 0,
          selectedWeekProjection: core.playerWeekProjection(player, state.selectedWeek),
        }))
        .sort((a, b) => (b.selectedWeekProjection + Math.log10(b.trendCount + 1) * 0.7) - (a.selectedWeekProjection + Math.log10(a.trendCount + 1) * 0.7))
        .slice(0, 28);
      suggestions = core.waiverRecommendations(roster, candidates, state.settings, 10, state.selectedWeek);
    }
    $("#waiver-recommendations").innerHTML = suggestions.length
      ? suggestions.map((row) => {
          const trendCount = trendCounts.get(canonicalName(row.add.name)) || row.add.trendCount || 0;
          const faab = row.faab?.target > 0
            ? `Bid $${row.faab.target} · range $${row.faab.floor}–$${row.faab.ceiling}`
            : trendCount ? `${trendCount} adds` : "oracle";
          const intelligence = row.add.decisionIntelligence;
          const signal = intelligence
            ? `${intelligence.opportunity.index}/100 opportunity · ${Math.round(intelligence.risk.breakoutProbability * 100)}% upside`
            : "";
          return `<div class="waiver-item">
          ${playerAvatar(row.add)}
          <div class="waiver-main"><strong>Add ${escapeHtml(row.add.name)}</strong><span>Drop ${escapeHtml(row.drop.name)} · ${escapeHtml(row.reason)}</span></div>
          <div class="waiver-move"><strong>+${row.score.toFixed(1)}</strong><span>${escapeHtml([faab, signal].filter(Boolean).join(" · "))}</span><button class="button button-small button-signal" type="button" data-action="apply-waiver" data-add-id="${escapeHtml(row.add.id)}" data-drop-id="${escapeHtml(row.drop.id)}">Apply</button></div>
        </div>`;
        }).join("")
      : `<div class="empty-state">No clear add/drop upgrade was found in the current player pool.</div>`;
  }

  function renderCoachingIntelligence(roster, lineup) {
    const contexts = roster.filter((player) => player.coachingContext)
      .map((player) => ({ player, context: player.coachingContext }));
    const ids = ["coach-projection-edge", "coach-role-confidence", "coach-volatility-edge", "coach-change-exposure"];
    if (!contexts.length) {
      ids.forEach((id) => { $("#" + id).textContent = "—"; });
      $("#coach-model-status").textContent = backend.available ? "Coach data unavailable" : "Server model required";
      $("#coach-staff-exposure").innerHTML = '<div class="empty-state">Load the server-modeled player dataset to analyze coaching context.</div>';
      $("#coach-player-edges").innerHTML = "";
      return;
    }
    const starterIds = new Set((lineup?.starters || []).filter((row) => row.player).map((row) => row.player.id));
    const weighted = contexts.map((row) => ({ ...row, weight: starterIds.has(row.player.id) ? 1.5 : .7 }));
    const totalWeight = weighted.reduce((sum, row) => sum + row.weight, 0) || 1;
    const average = (selector) => weighted.reduce((sum, row) => sum + selector(row.context) * row.weight, 0) / totalWeight;
    const meanEdge = average((context) => context.meanFactor) - 1;
    const roleConfidence = average((context) => (context.effective.roleClarity + context.effective.leadership + context.effective.continuity) / 3);
    const volatility = average((context) => context.volatilityFactor) - 1;
    const newStaff = weighted.reduce((sum, row) => sum + (row.context.newStaff ? row.weight : 0), 0) / totalWeight;
    const signed = (value) => (value >= 0 ? "+" : "") + (value * 100).toFixed(1) + "%";
    $("#coach-projection-edge").textContent = signed(meanEdge);
    $("#coach-role-confidence").textContent = Math.round(roleConfidence * 100) + "%";
    $("#coach-volatility-edge").textContent = signed(volatility);
    $("#coach-change-exposure").textContent = Math.round(newStaff * 100) + "%";
    $("#coach-projection-detail").textContent = "Bayesian-shrunk mean effect across the active roster";
    $("#coach-model-status").textContent = dataset.meta?.coachingVersion || "Coach model active";
    const teamGroups = new Map();
    for (const row of contexts) {
      const key = row.context.team;
      const group = teamGroups.get(key) || { context: row.context, players: 0, starters: 0 };
      group.players += 1;
      if (starterIds.has(row.player.id)) group.starters += 1;
      teamGroups.set(key, group);
    }
    const staffRows = [...teamGroups.values()].sort((a, b) => b.starters - a.starters || b.players - a.players).slice(0, 5);
    $("#coach-staff-exposure").innerHTML = `<strong>Staff exposure</strong>` + staffRows.map((row) => `
      <div class="coach-detail-row"><span><strong>${escapeHtml(row.context.team)}</strong> · ${escapeHtml(row.context.headCoach)} / ${escapeHtml(row.context.offensivePlayCaller)}</span>
      <small>${row.starters} starters · ${row.players} rostered · ${escapeHtml(row.context.scheme)}</small></div>`).join("");
    const playerRows = [...contexts].sort((a, b) => Math.abs(b.context.meanFactor - 1) - Math.abs(a.context.meanFactor - 1)).slice(0, 5);
    $("#coach-player-edges").innerHTML = `<strong>Largest player effects</strong>` + playerRows.map((row) => {
      const edge = signed(row.context.meanFactor - 1);
      const driver = row.context.drivers?.[0]?.label || "staff context";
      return `<div class="coach-detail-row"><span><strong>${escapeHtml(row.player.name)}</strong> · ${escapeHtml(row.context.team)}</span><small>${edge} mean · ${escapeHtml(driver)}</small></div>`;
    }).join("");
  }
  function renderDecisionIntelligence(roster, lineup, startSit = null) {
    const cardIds = ["intel-opportunity", "intel-active-availability", "intel-return-level", "intel-recovery-exposure", "intel-health-confidence", "intel-historical-share", "intel-volume-stability", "intel-regression-signal", "intel-holdout-skill", "intel-ecosystem", "intel-matchup", "intel-fragility", "intel-regret"];
    const rows = roster
      .filter((player) => player.decisionIntelligence)
      .map((player) => ({ player, intelligence: player.decisionIntelligence }));
    if (!rows.length) {
      cardIds.forEach((id) => { $("#" + id).textContent = "—"; });
      $("#intelligence-model-status").textContent = backend.available ? "Signals unavailable" : "Server model required";
      $("#intel-opportunity-list").innerHTML = "";
      $("#intel-health-list").innerHTML = "";
      $("#intel-conviction-list").innerHTML = '<div class="empty-state">Load the server intelligence model to decompose roster decisions.</div>';
      $("#intel-upside-list").innerHTML = "";
      $("#intel-fragile-list").innerHTML = "";
      return;
    }
    const starterIds = new Set((lineup?.starters || []).filter((row) => row.player).map((row) => row.player.id));
    const weighted = rows.map((row) => ({ ...row, weight: starterIds.has(row.player.id) ? 1.5 : .65 }));
    const weightedAverage = (selector) => {
      const selected = weighted.map((row) => ({ value: Number(selector(row)), weight: row.weight }))
        .filter((row) => Number.isFinite(row.value));
      const total = selected.reduce((sum, row) => sum + row.weight, 0) || 1;
      return selected.reduce((sum, row) => sum + row.value * row.weight, 0) / total;
    };
    const opportunityRows = weighted.filter((row) => row.player.opportunityContext);
    const healthRows = weighted.filter((row) => row.player.healthContext);
    const recoveryHealthRows = healthRows.filter((row) => row.player.healthContext.severity !== "none" || row.player.healthContext.status !== "active");
    const affectedHealthRows = healthRows.filter((row) => recoveryHealthRows.includes(row) || row.player.healthContext.news?.articles?.length);
    const opportunity = weightedAverage((row) => row.intelligence.opportunity.index);
    const historicalAverage = (selector) => {
      const selected = opportunityRows.map((row) => ({ value: Number(selector(row.player.opportunityContext)), weight: row.weight })).filter((row) => Number.isFinite(row.value));
      const total = selected.reduce((sum, row) => sum + row.weight, 0) || 1;
      return selected.reduce((sum, row) => sum + row.value * row.weight, 0) / total;
    };
    const healthAverage = (selectedRows, selector, fallback = 0) => {
      const selected = selectedRows.map((row) => ({ value: Number(selector(row.player.healthContext)), weight: row.weight })).filter((row) => Number.isFinite(row.value));
      if (!selected.length) return fallback;
      const total = selected.reduce((sum, row) => sum + row.weight, 0) || 1;
      return selected.reduce((sum, row) => sum + row.value * row.weight, 0) / total;
    };
    const totalHealthWeight = healthRows.reduce((sum, row) => sum + row.weight, 0) || 1;
    const recoveryHealthWeight = recoveryHealthRows.reduce((sum, row) => sum + row.weight, 0);
    const activeAvailability = healthAverage(healthRows, (context) => context.currentAvailability, 1) * 100;
    const returnLevel = healthAverage(recoveryHealthRows, (context) => context.returnToPriorLevelProbability, 1) * 100;
    const recoveryExposure = recoveryHealthWeight / totalHealthWeight * 100;
    const healthConfidence = healthAverage(recoveryHealthRows, (context) => context.confidence, 1) * 100;
    const historicalShare = historicalAverage((context) => context.teamOpportunityShare) * 100;
    const volumeStability = historicalAverage((context) => context.volumeStability) * 100;
    const regressionSignal = historicalAverage((context) => context.meanFactor - 1) * 100;
    const holdoutSkill = historicalAverage((context) => context.holdout?.rmseImprovement) * 100;
    const ecosystem = weightedAverage((row) => 50 + row.intelligence.ecosystem.index * 50);
    const matchup = weightedAverage((row) => row.intelligence.matchup.weekly?.[state.selectedWeek - 1]?.grade);
    const fragility = weightedAverage((row) => row.intelligence.risk.fragility) * 100;
    const regretAvailable = Boolean(startSit?.regret);
    const regret = Number(startSit?.regret?.totalExpectedRegret || 0);
    $("#intel-opportunity").textContent = Math.round(opportunity) + "/100";
    $("#intel-active-availability").textContent = Math.round(activeAvailability) + "%";
    $("#intel-return-level").textContent = Math.round(returnLevel) + "%";
    $("#intel-recovery-exposure").textContent = Math.round(recoveryExposure) + "%";
    $("#intel-health-confidence").textContent = Math.round(healthConfidence) + "%";
    $("#intel-historical-share").textContent = opportunityRows.length ? historicalShare.toFixed(1) + "%" : "—";
    $("#intel-volume-stability").textContent = opportunityRows.length ? Math.round(volumeStability) + "%" : "—";
    $("#intel-regression-signal").textContent = opportunityRows.length ? (regressionSignal >= 0 ? "+" : "") + regressionSignal.toFixed(1) + "%" : "—";
    $("#intel-holdout-skill").textContent = opportunityRows.length ? holdoutSkill.toFixed(1) + "%" : "—";
    $("#intel-ecosystem").textContent = Math.round(ecosystem) + "/100";
    $("#intel-matchup").textContent = Number.isFinite(matchup) ? Math.round(matchup) + "/100" : "BYE mix";
    $("#intel-fragility").textContent = Math.round(fragility) + "%";
    $("#intel-regret").textContent = regretAvailable ? regret.toFixed(1) + " pts" : "—";
    $("#intelligence-model-status").textContent = dataset.meta?.healthVersion
      ? `${dataset.meta.healthVersion} · ${dataset.meta.opportunityVersion} · ${dataset.meta.contextVersion}`
      : dataset.meta?.opportunityVersion
        ? `${dataset.meta.opportunityVersion} · ${dataset.meta.contextVersion}`
      : dataset.meta?.contextVersion || "Context model active";

    const rowHtml = (row, detail) => `<div class="intelligence-detail-row"><span><strong>${escapeHtml(row.player.name)}</strong> · ${escapeHtml(row.player.team)} ${escapeHtml(row.player.position)}</span><small>${escapeHtml(detail)}</small></div>`;
    const healthPriority = { major: 4, moderate: 3, minor: 2, none: 1 };
    const displayedHealthRows = [...affectedHealthRows]
      .sort((left, right) => (healthPriority[right.player.healthContext.severity] - healthPriority[left.player.healthContext.severity]) || right.player.healthContext.uncertainty - left.player.healthContext.uncertainty)
      .slice(0, 6);
    $("#intel-health-list").innerHTML = "<strong>Health, recovery, and news</strong>" + (displayedHealthRows.length ? displayedHealthRows.map((row) => {
      const health = row.player.healthContext;
      const facts = health.reportedFacts || {};
      const body = facts.injuryBodyPart ? ` · ${facts.injuryBodyPart}` : "";
      const practice = facts.practiceParticipation ? ` · ${facts.practiceParticipation}` : "";
      const window = health.returnWindow ? `likely W${health.returnWindow.likelyWeek}, W${health.returnWindow.earliestWeek}–${health.returnWindow.latestWeek}` : "timetable unknown";
      const focusedNews = health.news?.articles?.find((article) => article.focused);
      const taggedNews = health.news?.articles?.[0];
      const news = focusedNews ? `focused news: ${focusedNews.headline}` : taggedNews ? `tagged only, no model effect: ${taggedNews.headline}` : "no focused article";
      const modelDetail = recoveryHealthRows.includes(row) ? `${window}, ${Math.round(health.returnToPriorLevelProbability * 100)}% prior-level, ${Math.round(health.recurrenceRisk * 100)}% recurrence` : "no active recovery penalty";
      return rowHtml(row, `reported: ${facts.injuryStatus || health.status}${body}${practice} · modeled: ${modelDetail} · ${news}`);
    }).join("") : '<div class="empty-state">No active health or player-news exposure on this roster.</div>');

    const historicalRows = [...opportunityRows]
      .sort((left, right) => Math.abs(right.player.opportunityContext.meanFactor - 1) - Math.abs(left.player.opportunityContext.meanFactor - 1))
      .slice(0, 5);
    $("#intel-opportunity-list").innerHTML = "<strong>Historical usage and regression</strong>" + historicalRows.map((row) => {
      const context = row.player.opportunityContext;
      const edge = (context.meanFactor - 1) * 100;
      const comparable = context.analogs?.comparables?.[0];
      const analog = comparable
        ? ` · comp ${comparable.name} ${comparable.sourceSeason} (${comparable.sourcePpg.toFixed(1)}→${comparable.nextPpg.toFixed(1)})`
        : "";
      return rowHtml(row, `${context.archetype} · ${context.weightedOpportunityPerGame.toFixed(1)} weighted opp/g · ${(context.teamOpportunityShare * 100).toFixed(1)}% share · ${edge >= 0 ? "+" : ""}${edge.toFixed(1)}% model${analog}`);
    }).join("");

    const convictionRows = [...rows]
      .sort((left, right) => right.intelligence.consensus.conviction - left.intelligence.consensus.conviction)
      .slice(0, 5);
    $("#intel-conviction-list").innerHTML = "<strong>Highest conviction</strong>" + convictionRows.map((row) => rowHtml(
      row,
      Math.round(row.intelligence.consensus.conviction * 100) + "% conviction · " +
        row.intelligence.opportunity.index + "/100 opportunity",
    )).join("");

    const upsideRows = [...rows]
      .sort((left, right) => (
        right.intelligence.risk.breakoutProbability * right.intelligence.risk.upsideDownsideRatio -
        left.intelligence.risk.breakoutProbability * left.intelligence.risk.upsideDownsideRatio
      ))
      .slice(0, 5);
    $("#intel-upside-list").innerHTML = "<strong>Asymmetric upside</strong>" + upsideRows.map((row) => rowHtml(
      row,
      Math.round(row.intelligence.risk.breakoutProbability * 100) + "% 20%+ outcome · " +
        row.intelligence.risk.upsideDownsideRatio.toFixed(2) + "x upside/downside",
    )).join("");

    const fragileRows = [...rows]
      .sort((left, right) => right.intelligence.risk.fragility - left.intelligence.risk.fragility)
      .slice(0, 4);
    const highestRegret = startSit?.regret?.highestRegret;
    const regretRow = highestRegret?.starter && highestRegret?.alternative
      ? `<div class="intelligence-detail-row"><span><strong>${escapeHtml(highestRegret.starter.name)} vs ${escapeHtml(highestRegret.alternative.name)}</strong></span><small>${Number(highestRegret.expectedRegret).toFixed(1)} regret · ${Math.round(Number(highestRegret.alternativeOutscoresProbability) * 100)}% alternative wins</small></div>`
      : "";
    $("#intel-fragile-list").innerHTML = "<strong>Fragility and counterfactuals</strong>" + regretRow + fragileRows.map((row) => {
      const uncertainty = Object.entries(row.intelligence.risk.uncertainty || {})
        .sort((left, right) => right[1] - left[1])[0]?.[0] || "baseline";
      return rowHtml(
        row,
        Math.round(row.intelligence.risk.fragility * 100) + "% fragile · primary uncertainty: " + uncertainty,
      );
    }).join("");
  }
  function nativeTeamSignature(roster) {
    const leagueRosters = Object.fromEntries(
      Object.entries(state.leagueRosters || {})
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
        .map(([teamId, ids]) => [teamId, [...(ids || [])].map(String).sort()]),
    );
    return JSON.stringify({
      week: state.selectedWeek,
      roster: roster.map((player) => player.id).sort(),
      leagueRosters,
      settings: state.settings,
      dataVersion: dataset.meta?.modelGeneratedAt || dataset.meta?.generatedAt || "bundled",
    });
  }

  async function requestNativeTeamSnapshot(roster, signature) {
    if (!backend.available || !roster.length) return;
    const requestId = ++nativeTeamRequestId;
    const rosterIds = roster.map((player) => player.id);
    const unavailable = new Set((state.draft.picks || []).map((pick) => String(pick.playerId)));
    Object.values(state.leagueRosters || {}).flat().forEach((id) => unavailable.add(String(id)));
    rosterIds.forEach((id) => unavailable.add(String(id)));
    const freeAgentIds = players
      .filter((player) => !unavailable.has(player.id))
      .sort((left, right) => (
        core.playerWeekProjection(right, state.selectedWeek) -
        core.playerWeekProjection(left, state.selectedWeek)
      ))
      .slice(0, 220)
      .map((player) => player.id);
    const common = {
      rosterIds,
      settings: state.settings,
      playerOverrides: playerOverridesForServer(),
    };
    const leagueTeams = Object.entries(state.leagueRosters || {})
      .map(([teamId, ids]) => ({
        teamId,
        name: teamName(teamId),
        rosterIds: ids,
      }))
      .filter((team) => team.rosterIds?.length);
    const leagueRequest = leagueTeams.length >= 2
      ? apiRequest("/league/simulate", {
          method: "POST",
          body: JSON.stringify({
            settings: state.settings,
            teams: leagueTeams,
            startWeek: state.selectedWeek,
            regularSeasonEnd: 14,
            championshipWeek: 17,
            playoffTeams: Math.min(6, leagueTeams.length),
            simulations: 3_000,
            seed: state.selectedWeek * 65537 + leagueTeams.length * 4099,
            playerOverrides: playerOverridesForServer(),
          }),
        }, 120_000)
      : Promise.resolve(null);
    const requests = await Promise.allSettled([
      apiRequest("/roster/analyze", {
        method: "POST",
        body: JSON.stringify({ ...common, week: state.selectedWeek }),
      }),
      apiRequest("/lineup/start-sit", {
        method: "POST",
        body: JSON.stringify({ ...common, week: state.selectedWeek }),
      }),
      apiRequest("/waivers/recommend", {
        method: "POST",
        body: JSON.stringify({
          ...common,
          freeAgentIds,
          unavailableIds: [...unavailable],
          week: state.selectedWeek,
          limit: 12,
          budgetRemaining: 100,
          weeksRemaining: Math.max(1, 18 - state.selectedWeek),
          aggressiveness: state.settings.riskTolerance,
        }),
      }),
      apiRequest("/season/simulate", {
        method: "POST",
        body: JSON.stringify({
          ...common,
          startWeek: state.selectedWeek,
          endWeek: 17,
          simulations: 5_000,
          seed: state.selectedWeek * 104729 + rosterIds.length * 7919,
        }),
      }, 90_000),
      leagueRequest,
    ]);
    if (requestId !== nativeTeamRequestId || signature !== nativeTeamSignature(activeRosterPlayers())) return;
    const value = (index) => requests[index].status === "fulfilled" ? requests[index].value : null;
    nativeTeamSnapshot = {
      signature,
      analysis: value(0)?.data || null,
      startSit: value(1)?.data || null,
      waivers: value(2)?.data || null,
      season: value(3)?.data || null,
      league: value(4)?.data || null,
      engine: value(1)?.engine || value(0)?.engine || null,
    };
    if (state.activeView === "team") renderTeamView(false);
  }

  function championshipLeagueState() {
    const context = state.leagueContext || {};
    const rosterEntries = Object.entries(state.leagueRosters || {});
    const standings = context.standings || {};
    const teams = rosterEntries.map(([teamId, rosterIds], index) => ({
      teamId: String(teamId),
      name: teamName(teamId),
      rosterIds: [...new Set((rosterIds || []).map(String))],
      wins: Number(standings[teamId]?.wins || 0),
      losses: Number(standings[teamId]?.losses || 0),
      ties: Number(standings[teamId]?.ties || 0),
      pointsFor: Number(standings[teamId]?.pointsFor || 0),
      pointsAgainst: Number(standings[teamId]?.pointsAgainst || 0),
      faabRemaining: Number(standings[teamId]?.faabRemaining ?? context.settings?.faabBudget ?? 100),
      waiverPriority: Number(standings[teamId]?.waiverPriority || index + 1),
    }));
    const leagueRules = context.settings || {};
    return {
      leagueId: String(context.leagueId || "local-league"),
      season: Number(state.connections.sleeper?.season || new Date().getUTCFullYear()),
      week: Number(state.selectedWeek || 1),
      userTeamId: String(context.userTeamId || state.connections.sleeper?.ownRosterId || state.settings.draftPosition),
      settings: {
        ...state.settings,
        regularSeasonEnd: Number(leagueRules.regularSeasonEnd || 14),
        championshipWeek: Number(leagueRules.championshipWeek || 17),
        playoffTeams: Number(leagueRules.playoffTeams || Math.min(6, teams.length)),
        playoffByes: Number(leagueRules.playoffByes || 0),
        medianGame: Boolean(leagueRules.medianGame),
        waiverType: String(leagueRules.waiverType || "faab"),
        faabBudget: Number(leagueRules.faabBudget || 100),
        tradeDeadlineWeek: Number(leagueRules.tradeDeadlineWeek || 11),
      },
      teams,
      schedule: Array.isArray(context.schedule) ? context.schedule : [],
      source: context.source || { provider: "manual", fetchedAt: null },
    };
  }

  function championshipReadiness(leagueState = championshipLeagueState()) {
    const problems = [];
    const warnings = [];
    if (!backend.available) problems.push("Server control plane is unavailable.");
    if (leagueState.teams.length < 2) problems.push("Connect a complete league with at least two teams.");
    const emptyTeams = leagueState.teams.filter((team) => !team.rosterIds.length);
    if (emptyTeams.length) problems.push(emptyTeams.length + " teams have no mapped roster.");
    const standingCount = Object.keys(state.leagueContext?.standings || {}).length;
    if (standingCount !== leagueState.teams.length) problems.push("Current standings are incomplete.");
    if (leagueState.week <= leagueState.settings.regularSeasonEnd && !leagueState.schedule.length) {
      problems.push("Future regular-season matchups are missing.");
    }
    if (!leagueState.teams.some((team) => team.teamId === leagueState.userTeamId)) {
      problems.push("The connected user team cannot be identified.");
    }
    if (!platformStatus?.artifacts?.valid) warnings.push("Committed artifact integrity is not verified.");
    if (!platformStatus?.backup?.verified || platformStatus?.backup?.stale) {
      warnings.push("No current verified recovery package is recorded.");
    }
    if (["stale", "unsafe"].includes(platformStatus?.state)) {
      warnings.push("The platform reports " + platformStatus.state + " inputs or services.");
    }
    const checks = 5;
    const passed = checks - Math.min(checks, problems.length);
    return {
      ready: problems.length === 0,
      completeness: Math.round(passed / checks * 100),
      problems,
      warnings,
      leagueState,
    };
  }

  function championshipCandidateActions() {
    const actions = [];
    const seen = new Set();
    const add = (action) => {
      const key = JSON.stringify(action);
      if (seen.has(key)) return;
      seen.add(key);
      actions.push(action);
    };
    (nativeTeamSnapshot?.waivers || []).slice(0, 4).forEach((row, index) => {
      if (!row?.add?.id || !row?.drop?.id) return;
      add({
        id: "waiver-" + index + "-" + row.add.id,
        label: "Add " + row.add.name + ", drop " + row.drop.name,
        type: "add-drop",
        teamId: String(state.leagueContext?.userTeamId || state.settings.draftPosition),
        addPlayerId: String(row.add.id),
        dropPlayerId: String(row.drop.id),
        faabBid: Number(row.faab?.target || 0),
      });
    });
    generatedTradeProposals.slice(0, 4).forEach((proposal, index) => {
      const sendPlayerIds = (proposal.give || []).map((player) => String(player.id)).filter(Boolean);
      const receivePlayerIds = (proposal.receive || []).map((player) => String(player.id)).filter(Boolean);
      const opponentTeamId = String(proposal.opponentTeamId || state.tradeOpponentTeamId || "");
      if (!opponentTeamId || !sendPlayerIds.length || !receivePlayerIds.length) return;
      add({
        id: "trade-" + index + "-" + opponentTeamId,
        label: "Trade " + proposal.give.map((player) => player.name).join(" + ") +
          " for " + proposal.receive.map((player) => player.name).join(" + "),
        type: "trade",
        fromTeamId: String(state.leagueContext?.userTeamId || state.settings.draftPosition),
        toTeamId: opponentTeamId,
        sendPlayerIds,
        receivePlayerIds,
      });
    });
    return actions.slice(0, 8);
  }

  function platformComponent(name) {
    return platformStatus?.health?.components?.find((row) => row.name === name) || null;
  }

  function formatPlatformAge(ageMs) {
    const milliseconds = Number(ageMs);
    if (!Number.isFinite(milliseconds)) return "Unknown";
    const minutes = Math.max(0, Math.round(milliseconds / 60000));
    if (minutes < 60) return minutes + "m";
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours + "h";
    return Math.round(hours / 24) + "d";
  }

  function renderChampionshipControl() {
    const readiness = championshipReadiness();
    const artifactValid = Boolean(platformStatus?.artifacts?.valid);
    const backup = platformStatus?.backup || {};
    const freshness = platformComponent("player-data");
    const title = championshipResult?.baseline?.outcome?.championshipProbability;
    $("#champ-platform-state").textContent = platformStatus?.state || (backend.available ? "Unknown" : "Offline");
    $("#champ-artifact-state").textContent = artifactValid ? "Verified" : "Unverified";
    $("#champ-backup-state").textContent = backup.verified && !backup.stale
      ? "Verified" : backup.configured ? "Stale" : "Missing";
    $("#champ-freshness-state").textContent = freshness?.state === "stale"
      ? "Stale " + formatPlatformAge(freshness.ageMs)
      : freshness?.ageMs !== undefined ? formatPlatformAge(freshness.ageMs) : "Unknown";
    $("#champ-league-state").textContent = readiness.completeness + "%";
    $("#champ-title-equity").textContent = Number.isFinite(Number(title))
      ? (Number(title) * 100).toFixed(1) + "%" : "Not run";
    const status = $("#championship-status");
    status.textContent = championshipResult
      ? championshipResult.actions.length + " paired actions · " + championshipResult.simulations.toLocaleString() + " paths"
      : readiness.ready ? "Ready for paired title simulation" : "League state incomplete";
    status.classList.toggle("is-warning", !readiness.ready || !artifactValid || backup.stale);
    $("#run-championship-button").disabled = !readiness.ready || !backend.available;

    const readinessRows = [
      ["Exact league state", readiness.ready ? "Ready" : readiness.problems.join(" ")],
      ["Source", state.leagueContext?.source?.provider || "Manual"],
      ["Model governance", platformStatus?.models?.domains?.projection?.champion || "Unknown"],
      ["Drift state", platformStatus?.drift?.state || "Unknown"],
      ["Native compute", platformComponent("native-compute")?.state || "Unknown"],
      ["Feed health", platformComponent("source-feeds")?.state || "Unknown"],
      ...readiness.warnings.map((warning) => ["Warning", warning]),
    ];
    $("#championship-readiness").innerHTML = readinessRows.map(([label, value]) => (
      '<div class="championship-readiness-row"><span>' + escapeHtml(label) +
      '</span><strong>' + escapeHtml(value) + '</strong></div>'
    )).join("");

    const actions = championshipResult?.actions || [];
    $("#championship-action-list").innerHTML = actions.length
      ? actions.map((row) => {
          const outcome = row.outcome || {};
          const delta = row.delta || {};
          const titleDelta = Number(delta.championshipProbability || 0) * 100;
          const playoffDelta = Number(delta.playoffProbability || 0) * 100;
          return '<div class="championship-action-row' + (row.id === championshipResult.preferredActionId ? ' is-preferred' : '') + '">' +
            '<span>#' + row.rank + ' · ' + escapeHtml(row.recommendation) + '</span>' +
            '<strong>' + escapeHtml(row.label) + '</strong>' +
            '<div class="championship-action-metrics">' +
              '<span>Title ' + (Number(outcome.championshipProbability || 0) * 100).toFixed(1) + '% (' + (titleDelta >= 0 ? '+' : '') + titleDelta.toFixed(1) + ' pp)</span>' +
              '<span>Playoffs ' + (Number(outcome.playoffProbability || 0) * 100).toFixed(1) + '% (' + (playoffDelta >= 0 ? '+' : '') + playoffDelta.toFixed(1) + ' pp)</span>' +
              '<span>Confidence ' + Math.round(Number(row.confidence || 0) * 100) + '%</span>' +
            '</div>' +
            '<small>' + escapeHtml(row.reversal?.description || '') + '</small>' +
          '</div>';
        }).join("")
      : '<div class="empty-state">Connect an exact league, then evaluate the current roster against waiver and trade candidates.</div>';
  }

  async function runChampionshipEvaluation() {
    const readiness = championshipReadiness();
    if (!readiness.ready) {
      toast(readiness.problems[0] || "Exact league state is required.", true);
      renderChampionshipControl();
      return;
    }
    const requestId = ++championshipRequestId;
    const button = $("#run-championship-button");
    button.disabled = true;
    $("#championship-status").textContent = "Simulating paired championship paths…";
    try {
      const result = await apiRequest("/championship/evaluate", {
        method: "POST",
        body: JSON.stringify({
          leagueState: readiness.leagueState,
          actions: championshipCandidateActions(),
          simulations: Number(backend.health?.compute?.defaultSimulations || 15000),
          seed: 20260801 + Number(state.selectedWeek || 1),
        }),
      }, 240000);
      if (requestId !== championshipRequestId) return;
      championshipResult = result;
      renderChampionshipControl();
      const preferred = result.actions?.find((row) => row.id === result.preferredActionId);
      toast(preferred
        ? "Championship evaluation complete: " + preferred.label
        : "Championship evaluation complete.");
    } catch (error) {
      if (requestId !== championshipRequestId) return;
      championshipResult = null;
      $("#championship-status").textContent = "Championship evaluation failed";
      toast(error.message || "Championship evaluation failed.", true);
      renderChampionshipControl();
    } finally {
      if (requestId === championshipRequestId) button.disabled = !championshipReadiness().ready;
    }
  }

  function renderTeamView(scheduleNative = true) {
    $("#team-week-select").innerHTML = weekOptions(state.selectedWeek);
    const roster = activeRosterPlayers();
    const signature = nativeTeamSignature(roster);
    const snapshot = nativeTeamSnapshot?.signature === signature ? nativeTeamSnapshot : null;
    const analysis = snapshot?.analysis || core.analyzeRoster({
      roster,
      players,
      settings: state.settings,
      week: state.selectedWeek,
    });
    if (snapshot?.season) {
      analysis.seasonProjection = snapshot.season.expectedPoints;
      analysis.seasonSimulation = snapshot.season;
    }
    if (snapshot?.startSit?.regret) analysis.decisionRegret = snapshot.startSit.regret;
    if (snapshot?.league) {
      analysis.leagueOdds = snapshot.league.teams.find((team) => (
        String(team.teamId) === String(state.settings.draftPosition)
      )) || null;
    }
    const decisions = snapshot?.startSit?.decisions || [];
    const confidence = new Map(decisions
      .filter((row) => row.starter)
      .map((row) => [row.starter.id, Number(row.confidence)]));
    const regret = new Map(decisions
      .filter((row) => row.starter)
      .map((row) => [row.starter.id, Number(row.expectedRegret || 0)]));
    const nativeLineup = snapshot?.startSit?.recommended || snapshot?.analysis?.lineup || null;
    const lineup = renderOptimizedLineup(roster, state.selectedWeek, nativeLineup, confidence, regret);
    renderRosterHealth(analysis, roster);
    renderManualRoster(roster, lineup);
    renderRosterSearch();
    renderWaiverRecommendations(roster, snapshot?.waivers || null);
    renderCoachingIntelligence(roster, lineup);
    renderDecisionIntelligence(roster, lineup, snapshot?.startSit || null);
    renderChampionshipControl();
    const waiverPolicy = snapshot?.waivers?.[0]?.historicalCalibration ||
      backend.health?.historical?.waiverPolicy;
    $("#trending-status").textContent = waiverPolicy
      ? `Native C++ \u00b7 ${waiverPolicy.utilityRerank ? "utility rerank" : "need-aware holdout winner"}`
      : snapshot
        ? "Native C++ \u00b7 FAAB modeled"
        : backend.available ? "Loading native analysis" : "Browser fallback";
    if (scheduleNative && backend.available && roster.length && !snapshot) {
      requestNativeTeamSnapshot(roster, signature).catch((error) => {
        console.warn("Native team analysis unavailable", error);
      });
    }
  }
  function tradePlayers(ids) {
    return rosterPlayersFromIds(ids || []);
  }

  function tradeSearchResults(query, source, selectedIds, action) {
    const canonical = canonicalName(query);
    if (!canonical) return "";
    const selected = new Set(selectedIds.map(String));
    return source
      .filter((player) => !selected.has(player.id) && canonicalName(`${player.name} ${player.team} ${player.position}`).includes(canonical))
      .slice(0, 10)
      .map((player) => `<button class="search-result-item" type="button" data-action="${action}" data-player-id="${escapeHtml(player.id)}">
        ${playerAvatar(player)}<span class="roster-item-main"><strong>${escapeHtml(player.name)}</strong><span>${escapeHtml(player.position)} · ${escapeHtml(player.team)} · ${player.weeklyProjection.toFixed(1)} weekly</span></span>
      </button>`).join("");
  }

  function tradeSelectionHtml(ids, removeAction) {
    const selected = tradePlayers(ids);
    return selected.length
      ? selected.map((player) => `<div class="trade-chip" style="${positionStyle(player)}">
          ${playerAvatar(player)}
          <div class="roster-item-main"><strong>${escapeHtml(player.name)}</strong><span>${escapeHtml(player.position)} · ${player.projectedPoints.toFixed(0)} season pts</span></div>
          <button class="remove-button" type="button" data-action="${removeAction}" data-player-id="${escapeHtml(player.id)}" aria-label="Remove ${escapeHtml(player.name)}">×</button>
        </div>`).join("")
      : `<div class="empty-state">No players selected.</div>`;
  }

  function leagueRosterPlayers(teamId) {
    return rosterPlayersFromIds(state.leagueRosters?.[String(teamId)] || []);
  }

  function renderTradeOpponentOptions() {
    const select = $("#trade-opponent-select");
    const ownTeamId = String(state.settings.draftPosition);
    const opponents = Object.keys(state.leagueRosters || {})
      .filter((teamId) => teamId !== ownTeamId && leagueRosterPlayers(teamId).length)
      .sort((a, b) => Number(a) - Number(b));
    if (state.tradeOpponentTeamId && !opponents.includes(String(state.tradeOpponentTeamId))) {
      state.tradeOpponentTeamId = "";
    }
    select.innerHTML = opponents.length
      ? '<option value="">Select opponent</option>' + opponents.map((teamId) =>
          '<option value="' + escapeHtml(teamId) + '">' + escapeHtml(teamName(teamId)) + ' · ' + leagueRosterPlayers(teamId).length + ' players</option>'
        ).join("")
      : '<option value="">Connect a league</option>';
    select.value = String(state.tradeOpponentTeamId || "");
    $("#generate-trades-button").disabled = !opponents.length;
  }

  function renderGeneratedTradeProposals() {
    const status = $("#trade-proposal-status");
    const list = $("#trade-proposal-list");
    if (!generatedTradeProposals.length) {
      status.textContent = state.tradeOpponentTeamId ? "No proposals generated" : "Choose an opponent";
      list.innerHTML = '<div class="empty-state">Import a league with opponent rosters to generate plausible two-sided offers.</div>';
      return;
    }
    status.textContent = generatedTradeProposals.length + " plausible proposal" + (generatedTradeProposals.length === 1 ? "" : "s");
    list.innerHTML = generatedTradeProposals.map((proposal, index) => {
      const giveNames = proposal.give.map((player) => escapeHtml(player.name)).join(' + ');
      const receiveNames = proposal.receive.map((player) => escapeHtml(player.name)).join(' + ');
      const userGain = proposal.userAnalysis.lineupGain;
      const opponentGain = proposal.opponentAnalysis.lineupGain;
      const userUtility = proposal.userAnalysis.rosterUtility?.delta;
      const utilityLabel = userUtility
        ? " · ROS " + (userUtility.total >= 0 ? "+" : "") + userUtility.total.toFixed(1) +
          " · need " + userUtility.needReduction.toFixed(1)
        : "";
      return '<article class="trade-proposal">' +
        '<div class="trade-package"><span>You send</span><strong>' + giveNames + '</strong></div>' +
        '<div class="trade-proposal-verdict"><strong>' + proposal.fairness + '%</strong><span>fair</span></div>' +
        '<div class="trade-package"><span>You receive</span><strong>' + receiveNames + '</strong></div>' +
        '<div class="trade-proposal-footer"><span>You ' + (userGain >= 0 ? '+' : '') + userGain.toFixed(1) + ' · Opponent ' + (opponentGain >= 0 ? '+' : '') + opponentGain.toFixed(1) + utilityLabel + '</span>' +
        '<button class="button button-small button-signal" type="button" data-action="load-trade-proposal" data-proposal-index="' + index + '">Analyze</button></div>' +
      '</article>';
    }).join("");
  }

  async function generateTradeIdeas() {
    const opponentId = String(state.tradeOpponentTeamId || "");
    const opponentRoster = leagueRosterPlayers(opponentId);
    const userRoster = activeRosterPlayers();
    if (!opponentId || !opponentRoster.length) {
      toast("Choose an imported opponent roster first.", true);
      return;
    }
    $("#trade-proposal-status").textContent = backend.available
      ? "Server searching deep trade combinations…"
      : "Browser searching roster-fit combinations…";
    $("#generate-trades-button").disabled = true;
    let computeLabel = "browser";
    try {
      if (backend.available) {
        const response = await apiRequest("/trades/generate", {
          method: "POST",
          body: JSON.stringify({
            userRosterIds: userRoster.map((player) => player.id),
            opponentRosterIds: opponentRoster.map((player) => player.id),
            settings: state.settings,
            week: state.tradeWeek,
            limit: 24,
            assetLimit: 14,
            includeTwoForTwo: true,
            playerOverrides: playerOverridesForServer(),
          }),
        }, 120_000);
        generatedTradeProposals = response.data;
        computeLabel = "server · " + response.computeMs.toFixed(0) + " ms";
      } else {
        generatedTradeProposals = core.generateTradeProposals({
          userRoster,
          opponentRoster,
          players,
          settings: state.settings,
          week: state.tradeWeek,
          limit: 12,
          assetLimit: 9,
          includeTwoForTwo: false,
        });
      }
    } catch (error) {
      console.warn("Server trade search failed", error);
      generatedTradeProposals = core.generateTradeProposals({
        userRoster,
        opponentRoster,
        players,
        settings: state.settings,
        week: state.tradeWeek,
        limit: 12,
      });
      computeLabel = "browser fallback";
    } finally {
      $("#generate-trades-button").disabled = false;
    }
    renderGeneratedTradeProposals();
    $("#trade-proposal-status").textContent = generatedTradeProposals.length
      ? generatedTradeProposals.length + " proposals · " + computeLabel
      : "No proposal cleared thresholds · " + computeLabel;
    toast(generatedTradeProposals.length
      ? generatedTradeProposals.length + " trade ideas generated."
      : "No mutually plausible trade cleared the current thresholds.");
  }

  function loadTradeProposal(index) {
    const proposal = generatedTradeProposals[Number(index)];
    if (!proposal) return;
    state.trade = {
      giveIds: proposal.give.map((player) => player.id),
      receiveIds: proposal.receive.map((player) => player.id),
    };
    persistState();
    renderTradeView();
    document.querySelector("#trade-grade")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function tradeAnalysisSignature(roster, give, receive) {
    return JSON.stringify({
      week: state.tradeWeek,
      roster: roster.map((player) => player.id).sort(),
      give: give.map((player) => player.id).sort(),
      receive: receive.map((player) => player.id).sort(),
      settings: state.settings,
      dataVersion: dataset.meta?.modelGeneratedAt || dataset.meta?.generatedAt || "bundled",
    });
  }

  async function requestNativeTradeAnalysis(roster, give, receive, signature) {
    const requestId = ++nativeTradeRequestId;
    const response = await apiRequest("/trades/analyze", {
      method: "POST",
      body: JSON.stringify({
        rosterIds: roster.map((player) => player.id),
        giveIds: give.map((player) => player.id),
        receiveIds: receive.map((player) => player.id),
        settings: state.settings,
        week: state.tradeWeek,
        playerOverrides: playerOverridesForServer(),
      }),
    }, 90_000);
    if (requestId !== nativeTradeRequestId) return;
    const current = tradeAnalysisSignature(
      activeRosterPlayers(),
      tradePlayers(state.trade.giveIds),
      tradePlayers(state.trade.receiveIds),
    );
    if (current !== signature) return;
    nativeTradeAnalysis = { signature, data: response.data, engine: response.engine };
    if (state.activeView === "trade") renderTradeView(false);
  }

  function renderTradeView(scheduleNative = true) {
    $("#trade-week-select").innerHTML = weekOptions(state.tradeWeek);
    renderTradeOpponentOptions();
    renderGeneratedTradeProposals();
    const roster = activeRosterPlayers();
    $("#trade-give-results").innerHTML = tradeSearchResults(
      state.filters.tradeGiveQuery,
      roster,
      state.trade.giveIds,
      "add-trade-give",
    );
    $("#trade-receive-results").innerHTML = tradeSearchResults(
      state.filters.tradeReceiveQuery,
      players,
      state.trade.receiveIds,
      "add-trade-receive",
    );
    $("#trade-give-selection").innerHTML = tradeSelectionHtml(state.trade.giveIds, "remove-trade-give");
    $("#trade-receive-selection").innerHTML = tradeSelectionHtml(state.trade.receiveIds, "remove-trade-receive");

    const give = tradePlayers(state.trade.giveIds);
    const receive = tradePlayers(state.trade.receiveIds);
    if (!give.length || !receive.length) {
      $("#trade-grade").textContent = "—";
      $("#trade-verdict-title").textContent = "Choose both sides";
      $("#trade-verdict-summary").textContent = "Add players to calculate lineup impact and trade value.";
      $("#trade-lineup-gain").textContent = "—";
      $("#trade-asset-gain").textContent = "—";
      $("#trade-fairness").textContent = "—";
      $("#trade-fairness-bar").style.width = "0%";
      return;
    }
    const signature = tradeAnalysisSignature(roster, give, receive);
    const snapshot = nativeTradeAnalysis?.signature === signature ? nativeTradeAnalysis : null;
    const result = snapshot?.data || core.analyzeTrade({
      roster,
      give,
      receive,
      players,
      settings: state.settings,
      week: state.tradeWeek,
    });
    const utility = result.rosterUtility?.delta;
    const utilitySummary = utility
      ? " Rest-of-season utility " + (utility.total >= 0 ? "+" : "") + utility.total.toFixed(1) +
        "; playoff " + (utility.playoffPoints >= 0 ? "+" : "") + utility.playoffPoints.toFixed(1) +
        "; need reduction " + utility.needReduction.toFixed(1) + "."
      : "";
    const calibration = result.historicalCalibration;
    const calibrationSummary = Number.isFinite(result.decisionScore) && calibration?.version
      ? " Historical decision signal " + (result.decisionScore >= 0 ? "+" : "") +
        result.decisionScore.toFixed(2) + " versus " +
        (Number(calibration.scoreThreshold) >= 0 ? "+" : "") +
        Number(calibration.scoreThreshold || 0).toFixed(2) + " threshold; " +
        Math.round(Number(calibration.confidence || 0) * 100) + "% holdout correlation; " +
        Math.round(Number(calibration.thresholdPrecision || 0) * 100) + "% positive precision."
      : "";
    $("#trade-grade").textContent = result.grade;
    $("#trade-verdict-title").textContent = result.verdict;
    $("#trade-verdict-summary").textContent = (result.summary || "") + utilitySummary + calibrationSummary;
    $("#trade-lineup-gain").textContent = `${result.lineupGain >= 0 ? "+" : ""}${result.lineupGain.toFixed(1)}`;
    $("#trade-asset-gain").textContent = `${result.assetGain >= 0 ? "+" : ""}${result.assetGain.toFixed(1)}`;
    $("#trade-fairness").textContent = `${result.fairness}%`;
    $("#trade-fairness-bar").style.width = `${result.fairness}%`;
    if (scheduleNative && backend.available && !snapshot) {
      requestNativeTradeAnalysis(roster, give, receive, signature).catch((error) => {
        console.warn("Native trade analysis unavailable", error);
      });
    }
  }

  function renderConnectView() {
    const sleeper = state.connections.sleeper || {};
    const espn = state.connections.espn || {};
    if (!$("#sleeper-username").matches(":focus")) {
      $("#sleeper-username").value = sleeper.username || "";
    }
    $("#sleeper-season").value = sleeper.season || dataset.meta?.season || 2026;
    $("#espn-league-id").value = espn.leagueId || "";
    $("#espn-season").value = espn.season || dataset.meta?.season || 2026;
    $("#espn-team-id").value = espn.teamId || 1;
    if (sleeper.leagueName) {
      $("#sleeper-status").textContent = `Connected to ${sleeper.leagueName}${sleeper.liveSync ? " · live draft sync active" : ""}.`;
    }
    if (espn.leagueName) {
      $("#espn-status").textContent = `Imported ${espn.leagueName} for team ${espn.teamId}.`;
    }
  }
  function draftPlayer(playerId) {
    const player = playerById(playerId);
    if (!player) return;
    const teamId = Number($("#draft-team-override").value) || core.draftPickSummary(state.draft, state.settings).teamId;
    state.draft = core.applyDraftPick(state.draft, player.id, state.settings, teamId);
    const next = core.draftPickSummary(state.draft, state.settings);
    state.draftOverrideTeamId = next.teamId;
    persistState();
    renderAll();
    toast(`${player.name} drafted by ${teamName(teamId)}.`);
  }

  function resetDraft() {
    if (state.draft.picks.length && !window.confirm("Reset every pick on this draft board?")) return;
    state.draft = core.createDraftState(state.settings);
    state.draftOverrideTeamId = 1;
    persistState();
    renderAll();
    toast("Draft board reset.");
  }

  function addRosterPlayer(playerId) {
    const id = String(playerId);
    state.manualRosterInitialized = true;
    if (!state.manualRosterIds.includes(id)) state.manualRosterIds.push(id);
    state.filters.rosterQuery = "";
    $("#roster-player-search").value = "";
    persistState();
    renderTeamView();
  }

  function removeRosterPlayer(playerId) {
    state.manualRosterInitialized = true;
    state.manualRosterIds = state.manualRosterIds.filter((id) => String(id) !== String(playerId));
    state.trade.giveIds = state.trade.giveIds.filter((id) => String(id) !== String(playerId));
    persistState();
    renderAll();
  }

  function applyWaiver(addId, dropId) {
    const current = activeRosterIds();
    state.manualRosterInitialized = true;
    state.manualRosterIds = [
      ...current.filter((id) => String(id) !== String(dropId)),
      String(addId),
    ];
    persistState();
    renderTeamView();
    toast(`Added ${playerById(addId)?.name || "player"}; dropped ${playerById(dropId)?.name || "player"}.`);
  }

  function addTradePlayer(side, playerId) {
    const key = side === "give" ? "giveIds" : "receiveIds";
    const id = String(playerId);
    if (!state.trade[key].includes(id)) state.trade[key].push(id);
    state.filters[side === "give" ? "tradeGiveQuery" : "tradeReceiveQuery"] = "";
    $(side === "give" ? "#trade-give-search" : "#trade-receive-search").value = "";
    persistState();
    renderTradeView();
  }

  function removeTradePlayer(side, playerId) {
    const key = side === "give" ? "giveIds" : "receiveIds";
    state.trade[key] = state.trade[key].filter((id) => String(id) !== String(playerId));
    persistState();
    renderTradeView();
  }
  function riskLabel(value) {
    const risk = Number(value);
    if (risk <= 0.2) return "Conservative";
    if (risk <= 0.42) return "Cautious";
    if (risk <= 0.62) return "Balanced";
    if (risk <= 0.82) return "Aggressive";
    return "Upside hunting";
  }

  function openSetupDialog() {
    const dialog = $("#setup-dialog");
    const form = $("#setup-form");
    const settings = state.settings;
    form.elements.teams.value = settings.teams;
    form.elements.rounds.value = settings.rounds;
    form.elements.draftPosition.value = settings.draftPosition;
    form.elements.scoring.value = settings.scoring;
    Object.keys(settings.slots).forEach((slot) => {
      if (form.elements[slot]) form.elements[slot].value = settings.slots[slot];
    });
    form.elements.riskTolerance.value = settings.riskTolerance;
    $("#risk-output").textContent = riskLabel(settings.riskTolerance);
    $("#setup-reset-warning").hidden = !state.draft.picks.length;
    dialog.showModal();
  }

  function applySetup(form) {
    const data = new FormData(form);
    const next = core.cloneSettings({
      teams: Number(data.get("teams")),
      rounds: Number(data.get("rounds")),
      draftPosition: Number(data.get("draftPosition")),
      scoring: String(data.get("scoring")),
      riskTolerance: Number(data.get("riskTolerance")),
      slots: Object.fromEntries(
        ["QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "DST", "K", "BN"]
          .map((slot) => [slot, Number(data.get(slot) || 0)]),
      ),
    });
    const structureChanged = next.teams !== state.settings.teams || next.rounds !== state.settings.rounds;
    if (structureChanged && state.draft.picks.length && !window.confirm("Changing team count or rounds will reset the draft. Continue?")) {
      return false;
    }
    state.settings = next;
    if (structureChanged) {
      state.draft = core.createDraftState(next);
      state.teamNames = {};
    } else {
      const current = core.createDraftState(next);
      Object.keys(current.rosters).forEach((teamId) => {
        current.rosters[teamId] = [...(state.draft.rosters[teamId] || [])];
      });
      current.picks = [...state.draft.picks];
      state.draft = current;
    }
    state.draftOverrideTeamId = core.draftPickSummary(state.draft, next).teamId;
    simulationResult = null;
    simulationKey = "";
    generatedTradeProposals = [];
    persistState();
    renderAll();
    toast("League settings applied.");
    return true;
  }
  function exportState() {
    const payload = {
      app: "fantasy-football-oracle",
      exportedAt: new Date().toISOString(),
      dataSeason: dataset.meta?.season || 2026,
      state,
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fantasy-football-oracle-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast("Oracle state exported.");
  }

  async function importStateFile(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.app === "fantasy-football-oracle" && parsed.state) {
        state = hydrateState(parsed.state);
        persistState();
        renderAll();
        setView(state.activeView || "draft");
        toast("Oracle state restored.");
        return;
      }
      if (parsed?.teams || parsed?.settings) {
        importEspnPayload(parsed, Number($("#espn-team-id").value || 1));
        return;
      }
      throw new Error("This JSON file is not a recognized Oracle or ESPN snapshot.");
    } catch (error) {
      toast(error.message || "Could not import that file.", true);
    } finally {
      $("#import-state-file").value = "";
    }
  }
  async function sleeperFetch(path) {
    const response = await fetch(`${SLEEPER_API}${path}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Sleeper returned HTTP ${response.status}`);
    return response.json();
  }

  async function getSleeperPlayerMap() {
    if (sleeperPlayerMap) return sleeperPlayerMap;
    sleeperPlayerMap = await sleeperFetch("/players/nfl?active=true");
    return sleeperPlayerMap;
  }

  function ensureSleeperPlayer(sleeperId, map) {
    const sleeper = map?.[String(sleeperId)];
    if (!sleeper) return null;
    const fantasyDataId = sleeper.fantasy_data_id ? String(sleeper.fantasy_data_id) : "";
    if (fantasyDataId && playerMap.has(fantasyDataId)) return fantasyDataId;
    const name = sleeper.full_name || [sleeper.first_name, sleeper.last_name].filter(Boolean).join(" ");
    const canonical = canonicalName(name);
    const match = players.find((player) => (
      canonicalName(player.name) === canonical &&
      (!sleeper.position || player.position === sleeper.position) &&
      (!sleeper.team || player.team === sleeper.team)
    )) || players.find((player) => canonicalName(player.name) === canonical);
    if (match) return match.id;

    const fallback = core.normalizePlayer({
      id: `sleeper:${sleeperId}`,
      name: name || `Sleeper player ${sleeperId}`,
      position: sleeper.position || sleeper.fantasy_positions?.[0] || "WR",
      team: sleeper.team || "FA",
      projectedPoints: 0,
      weeklyProjection: 0,
      pprRank: 9999,
      injuryStatus: sleeper.injury_status || sleeper.status || "ACTIVE",
      injuryRisk: sleeper.injury_status ? 0.35 : 0.08,
      image: sleeper.player_id
        ? `https://sleepercdn.com/content/nfl/players/${sleeper.player_id}.jpg`
        : "",
    });
    players.push(fallback);
    playerMap.set(fallback.id, fallback);
    return fallback.id;
  }

  function mapSleeperIds(ids, map) {
    return (ids || []).map((id) => ensureSleeperPlayer(id, map)).filter(Boolean);
  }
  function sleeperSlots(rosterPositions = []) {
    const slots = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPERFLEX: 0, DST: 0, K: 0, BN: 0 };
    rosterPositions.forEach((rawSlot) => {
      const slot = String(rawSlot || "").toUpperCase();
      if (slot === "DEF") slots.DST += 1;
      else if (["FLEX", "WRRB_FLEX", "REC_FLEX"].includes(slot)) slots.FLEX += 1;
      else if (["SUPER_FLEX", "SUPERFLEX", "OP"].includes(slot)) slots.SUPERFLEX += 1;
      else if (slot === "BN") slots.BN += 1;
      else if (Object.hasOwn(slots, slot)) slots[slot] += 1;
    });
    return slots;
  }

  function settingsFromSleeper(league, draft, ownRosterId) {
    const slots = sleeperSlots(league.roster_positions || []);
    const receptionPoints = Number(league.scoring_settings?.rec || 0);
    let scoring = receptionPoints >= 0.75 ? "ppr" : receptionPoints >= 0.25 ? "half" : "standard";
    if (slots.SUPERFLEX > 0) scoring = "superflex";
    return core.cloneSettings({
      teams: Number(league.total_rosters || 12),
      rounds: Number(draft?.settings?.rounds || league.roster_positions?.length || 16),
      draftPosition: Number(ownRosterId || 1),
      scoring,
      slots,
      riskTolerance: state.settings.riskTolerance,
    });
  }

  function sleeperPoints(roster) {
    const settings = roster?.settings || {};
    return Number(settings.fpts || 0) + Number(settings.fpts_decimal || 0) / 100;
  }

  function sleeperLeagueRules(league) {
    const settings = league?.settings || {};
    const playoffTeams = Number(settings.playoff_teams || Math.min(6, league?.total_rosters || 12));
    const regularSeasonEnd = Math.max(1, Number(settings.playoff_week_start || 15) - 1);
    const rounds = Math.max(1, Math.ceil(Math.log2(Math.max(2, playoffTeams))));
    const championshipWeek = Math.min(18, regularSeasonEnd + rounds);
    const playoffByes = Math.max(0, (2 ** Math.ceil(Math.log2(playoffTeams))) - playoffTeams);
    return {
      regularSeasonEnd,
      championshipWeek,
      playoffTeams,
      playoffByes,
      medianGame: Boolean(settings.median_win),
      waiverType: String(settings.waiver_type || "faab").toLowerCase(),
      faabBudget: Number(settings.waiver_budget || 100),
      tradeDeadlineWeek: Number(settings.trade_deadline || 11),
    };
  }

  function sleeperStandings(rosters, league) {
    const budget = Number(league?.settings?.waiver_budget || 100);
    return Object.fromEntries((rosters || []).map((roster, index) => {
      const settings = roster.settings || {};
      return [String(roster.roster_id), {
        wins: Number(settings.wins || 0),
        losses: Number(settings.losses || 0),
        ties: Number(settings.ties || 0),
        pointsFor: sleeperPoints(roster),
        pointsAgainst: Number(settings.fpts_against || 0) + Number(settings.fpts_against_decimal || 0) / 100,
        faabRemaining: Math.max(0, budget - Number(settings.waiver_budget_used || 0)),
        waiverPriority: Number(settings.waiver_position || index + 1),
      }];
    }));
  }

  function sleeperScheduleRows(matchupsByWeek, currentWeek) {
    const schedule = [];
    Object.entries(matchupsByWeek || {}).forEach(([weekKey, rows]) => {
      const week = Number(weekKey);
      const groups = new Map();
      (rows || []).forEach((row) => {
        const key = String(row.matchup_id ?? ("solo-" + row.roster_id));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      });
      groups.forEach((group) => {
        if (group.length !== 2) return;
        const ordered = [...group].sort((a, b) => Number(a.roster_id) - Number(b.roster_id));
        schedule.push({
          week,
          homeTeamId: String(ordered[0].roster_id),
          awayTeamId: String(ordered[1].roster_id),
          completed: week < currentWeek,
          homeScore: week < currentWeek ? Number(ordered[0].points || 0) : null,
          awayScore: week < currentWeek ? Number(ordered[1].points || 0) : null,
        });
      });
    });
    return schedule.sort((left, right) => left.week - right.week || Number(left.homeTeamId) - Number(right.homeTeamId));
  }

  async function fetchSleeperLeagueSchedule(leagueId, startWeek, endWeek) {
    const weeks = Array.from({ length: Math.max(0, endWeek - startWeek + 1) }, (_, index) => startWeek + index);
    const results = await Promise.allSettled(weeks.map((week) => (
      sleeperFetch("/league/" + leagueId + "/matchups/" + week).then((rows) => [week, rows])
    )));
    return Object.fromEntries(results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value));
  }

  async function findSleeperLeagues() {
    const username = $("#sleeper-username").value.trim();
    const season = Number($("#sleeper-season").value || 2026);
    const status = $("#sleeper-status");
    if (!username) {
      status.textContent = "Enter a Sleeper username.";
      return;
    }
    status.textContent = "Looking up Sleeper leagues…";
    try {
      const user = await sleeperFetch(`/user/${encodeURIComponent(username)}`);
      if (!user?.user_id) throw new Error("Sleeper user not found");
      sleeperLeagues = await sleeperFetch(`/user/${user.user_id}/leagues/nfl/${season}`);
      state.connections.sleeper = { username, season, userId: user.user_id };
      const select = $("#sleeper-league-select");
      select.innerHTML = sleeperLeagues.map((league) => `<option value="${escapeHtml(league.league_id)}">${escapeHtml(league.name)} · ${escapeHtml(league.status)}</option>`).join("");
      $("#sleeper-league-field").hidden = !sleeperLeagues.length;
      $("#import-sleeper-button").hidden = !sleeperLeagues.length;
      status.textContent = sleeperLeagues.length
        ? `Found ${sleeperLeagues.length} league${sleeperLeagues.length === 1 ? "" : "s"}.`
        : "No NFL leagues were found for that season.";
      persistState();
    } catch (error) {
      status.textContent = error.message || "Sleeper lookup failed.";
    }
  }
  function buildDraftFromSleeperPicks(picks, settings, map) {
    let draftState = core.createDraftState(settings);
    [...(picks || [])]
      .sort((a, b) => Number(a.pick_no || 0) - Number(b.pick_no || 0))
      .forEach((pick) => {
        const playerId = ensureSleeperPlayer(pick.player_id, map);
        if (!playerId) return;
        const teamId = Number(pick.roster_id || pick.draft_slot || core.snakeTeamForPick(Number(pick.pick_no), settings.teams));
        draftState = core.applyDraftPick(draftState, playerId, settings, teamId);
      });
    return draftState;
  }

  async function importSleeperLeague() {
    const leagueId = $("#sleeper-league-select").value;
    const status = $("#sleeper-status");
    if (!leagueId) return;
    status.textContent = "Importing league, roster, and draft…";
    try {
      const [league, rosters, users, drafts, map, nflState] = await Promise.all([
        sleeperFetch(`/league/${leagueId}`),
        sleeperFetch(`/league/${leagueId}/rosters`),
        sleeperFetch(`/league/${leagueId}/users`),
        sleeperFetch(`/league/${leagueId}/drafts`),
        getSleeperPlayerMap(),
        sleeperFetch("/state/nfl"),
      ]);
      const userId = String(state.connections.sleeper.userId || "");
      const ownRoster = rosters.find((roster) => String(roster.owner_id) === userId) || rosters[0];
      if (!ownRoster) throw new Error("No roster was found in this league");
      const draft = drafts[0] || null;
      const picks = draft ? await sleeperFetch(`/draft/${draft.draft_id}/picks`) : [];
      const settings = settingsFromSleeper(league, draft, ownRoster.roster_id);
      const userById = new Map(users.map((user) => [String(user.user_id), user]));
      const teamNames = {};
      const leagueRosters = {};
      rosters.forEach((roster) => {
        const user = userById.get(String(roster.owner_id));
        teamNames[String(roster.roster_id)] = user?.metadata?.team_name || user?.display_name || `Team ${roster.roster_id}`;
        leagueRosters[String(roster.roster_id)] = mapSleeperIds(roster.players || [], map);
      });
      const currentWeek = Math.min(18, Math.max(1, Number(nflState?.week || state.selectedWeek || 1)));
      const leagueRules = sleeperLeagueRules(league);
      const matchupWeeks = await fetchSleeperLeagueSchedule(
        leagueId,
        currentWeek,
        leagueRules.regularSeasonEnd,
      );
      const leagueSchedule = sleeperScheduleRows(matchupWeeks, currentWeek);
      const standings = sleeperStandings(rosters, league);

      state.settings = settings;
      state.teamNames = teamNames;
      state.leagueRosters = leagueRosters;
      state.leagueContext = {
        leagueId: String(leagueId),
        userTeamId: String(ownRoster.roster_id),
        standings,
        schedule: leagueSchedule,
        settings: leagueRules,
        source: {
          provider: "Sleeper",
          fetchedAt: new Date().toISOString(),
          leagueName: String(league.name || "Sleeper league"),
          scheduleWeeksLoaded: Object.keys(matchupWeeks).length,
        },
      };
      championshipResult = null;
      state.selectedWeek = currentWeek;
      state.tradeWeek = currentWeek;
      state.tradeOpponentTeamId = Object.keys(leagueRosters).find((id) => Number(id) !== Number(ownRoster.roster_id)) || "";
      generatedTradeProposals = [];
      state.draft = buildDraftFromSleeperPicks(picks, settings, map);
      state.draftOverrideTeamId = core.draftPickSummary(state.draft, settings).teamId;
      state.manualRosterIds = [...(leagueRosters[String(ownRoster.roster_id)] || [])];
      state.manualRosterInitialized = true;
      state.trade = { giveIds: [], receiveIds: [] };
      state.connections.sleeper = {
        ...state.connections.sleeper,
        leagueId,
        leagueName: league.name,
        draftId: draft?.draft_id || null,
        ownRosterId: ownRoster.roster_id,
        currentWeek,
        liveSync: draft?.status === "drafting",
      };
      persistState();
      renderAll();
      status.textContent = `Imported ${league.name}${draft?.status === "drafting" ? " · live draft sync active" : ""}.`;
      if (draft?.status === "drafting") startSleeperDraftPolling();
      toast(`${league.name} imported from Sleeper.`);
    } catch (error) {
      status.textContent = error.message || "Sleeper import failed.";
    }
  }
  function stopSleeperDraftPolling() {
    if (sleeperPollTimer) window.clearInterval(sleeperPollTimer);
    sleeperPollTimer = null;
  }

  async function syncSleeperDraftOnce() {
    const connection = state.connections.sleeper || {};
    if (!connection.draftId) return;
    try {
      const [picks, map] = await Promise.all([
        sleeperFetch(`/draft/${connection.draftId}/picks`),
        getSleeperPlayerMap(),
      ]);
      if (picks.length !== state.draft.picks.length) {
        state.draft = buildDraftFromSleeperPicks(picks, state.settings, map);
        state.draftOverrideTeamId = core.draftPickSummary(state.draft, state.settings).teamId;
        persistState();
        renderAll();
        toast(`Sleeper draft synced · ${picks.length} picks.`);
      }
    } catch (error) {
      $("#sleeper-status").textContent = `Live sync paused: ${error.message}`;
      stopSleeperDraftPolling();
      state.connections.sleeper.liveSync = false;
      persistState();
    }
  }

  function startSleeperDraftPolling() {
    stopSleeperDraftPolling();
    if (!state.connections.sleeper?.draftId) return;
    sleeperPollTimer = window.setInterval(syncSleeperDraftOnce, 7000);
    syncSleeperDraftOnce();
  }
  function espnSlots(lineupSlotCounts = {}) {
    const slotMap = {
      0: "QB", 2: "RB", 4: "WR", 6: "TE", 7: "SUPERFLEX",
      16: "DST", 17: "K", 20: "BN", 23: "FLEX",
    };
    const slots = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPERFLEX: 0, DST: 0, K: 0, BN: 0 };
    Object.entries(lineupSlotCounts || {}).forEach(([slotId, count]) => {
      const key = slotMap[Number(slotId)];
      if (key) slots[key] += Number(count || 0);
    });
    return slots;
  }

  function espnScoring(settings, slots) {
    const reception = (settings?.scoringSettings?.scoringItems || []).find((item) => Number(item.statId) === 53);
    const points = Number(reception?.points || 0);
    if (slots.SUPERFLEX > 0) return "superflex";
    if (points >= 0.75) return "ppr";
    if (points >= 0.25) return "half";
    return "standard";
  }

  function ensureEspnPlayer(rawPlayer) {
    if (!rawPlayer) return null;
    const id = String(rawPlayer.id || "");
    if (id && playerMap.has(id)) return id;
    const position = POSITION_BY_ESPN_ID[Number(rawPlayer.defaultPositionId)] || "WR";
    const team = TEAM_BY_ESPN_ID[Number(rawPlayer.proTeamId)] || "FA";
    const name = rawPlayer.fullName || [rawPlayer.firstName, rawPlayer.lastName].filter(Boolean).join(" ") || `ESPN player ${id}`;
    const match = players.find((player) => canonicalName(player.name) === canonicalName(name));
    if (match) return match.id;
    const fallback = core.normalizePlayer({
      id: id || `espn:${canonicalName(name)}`,
      name,
      position,
      team,
      projectedPoints: 0,
      weeklyProjection: 0,
      pprRank: 9999,
      injuryStatus: rawPlayer.injuryStatus || "ACTIVE",
      injuryRisk: rawPlayer.injured ? 0.45 : 0.08,
      image: position === "DST"
        ? `https://a.espncdn.com/i/teamlogos/nfl/500/${team.toLowerCase()}.png`
        : `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`,
    });
    players.push(fallback);
    playerMap.set(fallback.id, fallback);
    return fallback.id;
  }
  function espnRosterEntries(team) {
    return team?.roster?.entries || team?.roster?.entriesByLineupSlot || [];
  }

  function espnEntryPlayer(entry) {
    return entry?.playerPoolEntry?.player || entry?.player || null;
  }

  function importEspnPayload(payload, requestedTeamId = 1) {
    const leagueSettings = payload?.settings || {};
    const teams = payload?.teams || [];
    const teamCount = Number(leagueSettings.size || teams.length || 12);
    const slots = espnSlots(leagueSettings.rosterSettings?.lineupSlotCounts || {});
    const picks = payload?.draftDetail?.picks || payload?.draft?.picks || [];
    const rounds = Number(
      leagueSettings.draftSettings?.rounds ||
      Math.ceil(picks.length / Math.max(1, teamCount)) ||
      Object.values(slots).reduce((total, value) => total + value, 0) ||
      16,
    );
    const teamId = Math.min(teamCount, Math.max(1, Number(requestedTeamId || 1)));
    const settings = core.cloneSettings({
      teams: teamCount,
      rounds,
      draftPosition: teamId,
      scoring: espnScoring(leagueSettings, slots),
      slots,
      riskTolerance: state.settings.riskTolerance,
    });

    const leagueRosters = {};
    teams.forEach((team) => {
      espnRosterEntries(team).forEach((entry) => ensureEspnPlayer(espnEntryPlayer(entry)));
      leagueRosters[String(team.id)] = espnRosterEntries(team)
        .map((entry) => ensureEspnPlayer(espnEntryPlayer(entry)))
        .filter(Boolean);
    });

    let draftState = core.createDraftState(settings);
    [...picks]
      .sort((a, b) => Number(a.overallPickNumber || a.pickNumber || 0) - Number(b.overallPickNumber || b.pickNumber || 0))
      .forEach((pick) => {
        const playerId = String(pick.playerId || pick.player?.id || "");
        if (!playerId || !playerMap.has(playerId)) return;
        const pickTeamId = Number(pick.teamId || pick.team?.id || core.snakeTeamForPick(Number(pick.overallPickNumber), teamCount));
        draftState = core.applyDraftPick(draftState, playerId, settings, pickTeamId);
      });

    const teamNames = {};
    teams.forEach((team) => {
      teamNames[String(team.id)] = team.name || [team.location, team.nickname].filter(Boolean).join(" ") || team.abbrev || `Team ${team.id}`;
    });
    const ownTeam = teams.find((team) => Number(team.id) === teamId) || teams[0];
    const rosterIds = espnRosterEntries(ownTeam)
      .map((entry) => ensureEspnPlayer(espnEntryPlayer(entry)))
      .filter(Boolean);

    state.settings = settings;
    const currentWeek = Math.min(18, Math.max(1, Number(payload.scoringPeriodId || state.selectedWeek || 1)));
    const scheduleSettings = leagueSettings.scheduleSettings || {};
    const playoffTeams = Number(scheduleSettings.playoffTeamCount || Math.min(6, teamCount));
    const regularSeasonEnd = Number(scheduleSettings.matchupPeriodCount || 14);
    const championshipWeek = Math.min(18, regularSeasonEnd + Math.max(1, Math.ceil(Math.log2(Math.max(2, playoffTeams)))));
    const standings = Object.fromEntries(teams.map((team, index) => {
      const overall = team.record?.overall || team.record || {};
      return [String(team.id), {
        wins: Number(overall.wins || 0),
        losses: Number(overall.losses || 0),
        ties: Number(overall.ties || 0),
        pointsFor: Number(overall.pointsFor || team.points || 0),
        pointsAgainst: Number(overall.pointsAgainst || 0),
        faabRemaining: Math.max(0, Number(leagueSettings.acquisitionSettings?.acquisitionBudget || 100) - Number(team.transactionCounter?.acquisitionBudgetSpent || 0)),
        waiverPriority: Number(team.waiverRank || index + 1),
      }];
    }));
    const leagueSchedule = (payload.schedule || []).map((matchup) => ({
      week: Number(matchup.matchupPeriodId || 1),
      homeTeamId: String(matchup.home?.teamId || ""),
      awayTeamId: String(matchup.away?.teamId || ""),
      completed: Boolean(matchup.winner && matchup.winner !== "UNDECIDED"),
      homeScore: matchup.home?.totalPoints === undefined ? null : Number(matchup.home.totalPoints),
      awayScore: matchup.away?.totalPoints === undefined ? null : Number(matchup.away.totalPoints),
    })).filter((matchup) => matchup.homeTeamId && matchup.awayTeamId && matchup.week >= currentWeek);
    state.teamNames = teamNames;
    state.leagueRosters = leagueRosters;
    state.leagueContext = {
      leagueId: String(payload.id || state.connections.espn.leagueId || ""),
      userTeamId: String(teamId),
      standings,
      schedule: leagueSchedule,
      settings: {
        regularSeasonEnd,
        championshipWeek,
        playoffTeams,
        playoffByes: Math.max(0, (2 ** Math.ceil(Math.log2(playoffTeams))) - playoffTeams),
        medianGame: false,
        waiverType: leagueSettings.acquisitionSettings?.isUsingAcquisitionBudget ? "faab" : "priority",
        faabBudget: Number(leagueSettings.acquisitionSettings?.acquisitionBudget || 100),
        tradeDeadlineWeek: Number(leagueSettings.tradeSettings?.deadlineDate ? currentWeek : 11),
      },
      source: {
        provider: "ESPN",
        fetchedAt: new Date().toISOString(),
        leagueName: leagueSettings.name || payload.name || "ESPN league",
        scheduleWeeksLoaded: new Set(leagueSchedule.map((row) => row.week)).size,
      },
    };
    championshipResult = null;
    state.selectedWeek = currentWeek;
    state.tradeWeek = currentWeek;
    state.tradeOpponentTeamId = Object.keys(leagueRosters).find((id) => Number(id) !== Number(teamId)) || "";
    generatedTradeProposals = [];
    state.draft = draftState;
    state.draftOverrideTeamId = core.draftPickSummary(draftState, settings).teamId;
    state.manualRosterIds = [...new Set(leagueRosters[String(teamId)] || rosterIds)];
    state.manualRosterInitialized = true;
    state.trade = { giveIds: [], receiveIds: [] };
    state.connections.espn = {
      ...state.connections.espn,
      leagueId: String(payload.id || state.connections.espn.leagueId || ""),
      leagueName: leagueSettings.name || payload.name || "ESPN league",
      season: Number(payload.seasonId || state.connections.espn.season || 2026),
      teamId,
      currentWeek,
      importedAt: new Date().toISOString(),
    };
    persistState();
    renderAll();
    $("#espn-status").textContent = `Imported ${state.connections.espn.leagueName} · ${picks.length} draft picks · ${rosterIds.length} roster players.`;
    toast(`${state.connections.espn.leagueName} imported from ESPN.`);
  }
  async function importEspnPublicLeague() {
    const leagueId = $("#espn-league-id").value.trim();
    const season = Number($("#espn-season").value || 2026);
    const teamId = Number($("#espn-team-id").value || 1);
    const status = $("#espn-status");
    if (!leagueId) {
      status.textContent = "Enter an ESPN league ID.";
      return;
    }
    status.textContent = "Requesting ESPN league data…";
    state.connections.espn = { leagueId, season, teamId };
    persistState();
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${encodeURIComponent(leagueId)}?view=mTeam&view=mRoster&view=mSettings&view=mDraftDetail&view=mMatchup`;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status}`);
      importEspnPayload(await response.json(), teamId);
    } catch (error) {
      status.textContent = `${error.message || "Direct ESPN import failed"}. For a private league, install the bridge below and start sync from ESPN.`;
    }
  }

  function handleEspnBridgeMessage(event) {
    const allowed = ["https://fantasy.espn.com", "https://www.espn.com"];
    if (!allowed.includes(event.origin)) return;
    if (event.data?.type !== "fantasy-football-oracle:espn") return;
    const payload = event.data.payload;
    const teamId = Number(event.data.teamId || $("#espn-team-id").value || 1);
    try {
      importEspnPayload(payload, teamId);
      $("#espn-status").textContent += " · live browser bridge connected";
    } catch (error) {
      $("#espn-status").textContent = `ESPN bridge data could not be imported: ${error.message}`;
    }
  }
  function loadTrendCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(TREND_CACHE_KEY) || "null");
      if (!cached?.counts || Date.now() - Number(cached.createdAt || 0) > 6 * 60 * 60 * 1000) return false;
      trendCounts = new Map(Object.entries(cached.counts));
      $("#trending-status").textContent = "Sleeper trends cached";
      return true;
    } catch {
      return false;
    }
  }

  async function refreshSleeperTrends(showMessage = true) {
    $("#trending-status").textContent = "Refreshing trends…";
    try {
      const [trending, map] = await Promise.all([
        sleeperFetch("/players/nfl/trending/add?lookback_hours=72&limit=100"),
        getSleeperPlayerMap(),
      ]);
      const counts = {};
      trending.forEach((row) => {
        const sleeper = map[String(row.player_id)];
        const name = sleeper?.full_name || [sleeper?.first_name, sleeper?.last_name].filter(Boolean).join(" ");
        if (name) counts[canonicalName(name)] = Number(row.count || 0);
      });
      trendCounts = new Map(Object.entries(counts));
      localStorage.setItem(TREND_CACHE_KEY, JSON.stringify({ createdAt: Date.now(), counts }));
      $("#trending-status").textContent = "Sleeper trends live";
      if (state.activeView === "team") renderTeamView();
      if (showMessage) toast("Sleeper waiver trends refreshed.");
    } catch (error) {
      $("#trending-status").textContent = "Trend refresh unavailable";
      if (showMessage) toast(error.message || "Could not refresh Sleeper trends.", true);
    }
  }
  function espnSeasonTotal(stats, season, sourceId) {
    const row = (stats || []).find((item) => (
      Number(item.seasonId) === Number(season) &&
      Number(item.scoringPeriodId) === 0 &&
      Number(item.statSourceId) === Number(sourceId) &&
      Number(item.statSplitTypeId) === 0
    ));
    return Number(row?.appliedTotal || 0);
  }

  function espnWeeklyProjections(stats, season) {
    const weekly = Array.from({ length: 18 }, () => 0);
    (stats || []).forEach((row) => {
      const week = Number(row.scoringPeriodId);
      if (Number(row.seasonId) === Number(season) && Number(row.statSourceId) === 1 && Number(row.statSplitTypeId) === 1 && week >= 1 && week <= 18) {
        weekly[week - 1] = Number(Number(row.appliedTotal || 0).toFixed(2));
      }
    });
    return weekly;
  }

  function normalizeEspnSchedule(payload) {
    const output = {};
    (payload?.settings?.proTeams || []).forEach((team) => {
      const abbreviation = TEAM_BY_ESPN_ID[Number(team.id)] || String(team.abbrev || "").toUpperCase();
      if (!abbreviation || abbreviation === "FA") return;
      const weeks = Array.from({ length: 18 }, () => null);
      Object.entries(team.proGamesByScoringPeriod || {}).forEach(([weekKey, rows]) => {
        const week = Number(weekKey);
        const game = Array.isArray(rows) ? rows[0] : null;
        if (!game || week < 1 || week > 18) return;
        const home = Number(game.homeProTeamId) === Number(team.id);
        const opponentId = home ? Number(game.awayProTeamId) : Number(game.homeProTeamId);
        weeks[week - 1] = {
          opponent: TEAM_BY_ESPN_ID[opponentId] || "TBD",
          home,
          date: Number(game.date || 0),
          detail: String(game.detail || "TBD"),
          indoor: Boolean(game.indoor),
        };
      });
      output[abbreviation] = {
        proTeamId: Number(team.id),
        name: [team.location, team.name].filter(Boolean).join(" "),
        byeWeek: Number(team.byeWeek || 0),
        weeks,
      };
    });
    return output;
  }

  function normalizeEspnFeedPlayer(wrapper, season) {
    const raw = wrapper?.player || {};
    const position = POSITION_BY_ESPN_ID[Number(raw.defaultPositionId)];
    if (!position) return null;
    const projection = espnSeasonTotal(raw.stats, season, 1);
    const previous = espnSeasonTotal(raw.stats, season - 1, 0);
    const rank = (type) => Number(raw.draftRanksByRankType?.[type]?.rank || 0) || null;
    const ownership = raw.ownership || {};
    const team = TEAM_BY_ESPN_ID[Number(raw.proTeamId)] || "FA";
    const seasonProjection = projection || previous * 0.92;
    const weeklyProjections = espnWeeklyProjections(raw.stats, season);
    const activeWeeks = weeklyProjections.filter((value) => value > 0);
    const weeklyMean = activeWeeks.length
      ? activeWeeks.reduce((total, value) => total + value, 0) / activeWeeks.length
      : seasonProjection / 17;
    const variance = activeWeeks.length
      ? activeWeeks.reduce((total, value) => total + ((value - weeklyMean) ** 2), 0) / activeWeeks.length
      : 0;
    const baseVolatility = { QB: 0.28, RB: 0.42, WR: 0.48, TE: 0.5, K: 0.45, DST: 0.55 }[position] || 0.45;
    const injuryStatus = raw.injuryStatus || "ACTIVE";
    const injuryRisk = String(injuryStatus).includes("OUT") ? 0.92 : raw.injured ? 0.45 : 0.08;
    const deviation = Math.max(Math.sqrt(variance), weeklyMean * baseVolatility * (0.8 + injuryRisk * 0.55));
    return core.normalizePlayer({
      id: String(raw.id || wrapper.id),
      name: raw.fullName,
      position,
      team,
      proTeamId: Number(raw.proTeamId || 0),
      projectedPoints: seasonProjection,
      weeklyProjection: weeklyMean,
      weeklyProjections,
      previousPoints: previous,
      floorProjection: Math.max(0, weeklyMean - deviation),
      ceilingProjection: weeklyMean + deviation * 1.45,
      projectionStdDev: deviation,
      reliability: Math.max(0.3, 0.94 - injuryRisk * 0.48 - (previous <= 0 ? 0.12 : 0)),
      byeWeek: Number(schedule?.[team]?.byeWeek || 0),
      adp: Number(ownership.averageDraftPosition || 0) || null,
      adpTrend: Number(ownership.averageDraftPositionPercentChange || 0),
      auctionValue: Number(ownership.auctionValueAverage || 0),
      auctionTrend: Number(ownership.auctionValueAverageChange || 0),
      activityLevel: Number(ownership.activityLevel || 0),
      percentOwned: Number(ownership.percentOwned || 0),
      percentStarted: Number(ownership.percentStarted || 0),
      pprRank: rank("PPR"),
      standardRank: rank("STANDARD"),
      superflexRank: rank("SUPERFLEX"),
      injuryStatus,
      injuryRisk,
      lastNewsDate: Number(raw.lastNewsDate || 0),
      image: position === "DST"
        ? `https://a.espncdn.com/i/teamlogos/nfl/500/${team.toLowerCase()}.png`
        : `https://a.espncdn.com/i/headshots/nfl/players/full/${raw.id}.png`,
    });
  }

  async function refreshEspnPlayerData() {
    const status = $("#player-refresh-status");
    const season = Number(dataset.meta?.season || 2026);
    if (backend.available) {
      status.textContent = "Server refreshing projections, schedules, and ensemble model…";
      try {
        const response = await apiRequest("/data/refresh", { method: "POST" }, 90_000);
        await loadBundledData("no-store");
        simulationResult = null;
        simulationKey = "";
        renderAll();
        status.textContent = response.refreshed
          ? "Server model refreshed successfully."
          : "Server model is current; refresh cooldown remains active.";
        toast(status.textContent);
        return;
      } catch (error) {
        console.warn("Server data refresh failed", error);
        status.textContent = "Server refresh failed; trying direct browser refresh…";
      }
    } else {
      status.textContent = "Requesting current ESPN projections and schedule…";
    }
    const playerUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/1?view=kona_player_info`;
    const scheduleUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}?view=proTeamSchedules`;
    const filter = { players: { limit: 700, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
    try {
      const [playerResponse, scheduleResponse] = await Promise.all([
        fetch(playerUrl, { cache: "no-store", headers: { "x-fantasy-filter": JSON.stringify(filter) } }),
        fetch(scheduleUrl, { cache: "no-store" }),
      ]);
      if (!playerResponse.ok) throw new Error(`ESPN players returned HTTP ${playerResponse.status}`);
      if (!scheduleResponse.ok) throw new Error(`ESPN schedule returned HTTP ${scheduleResponse.status}`);
      schedule = normalizeEspnSchedule(await scheduleResponse.json());
      const payload = await playerResponse.json();
      const refreshed = (payload.players || []).map((row) => normalizeEspnFeedPlayer(row, season)).filter(Boolean);
      players = refreshed;
      playerMap = new Map(players.map((player) => [player.id, player]));
      dataset = {
        ...dataset,
        schedule,
        players: refreshed,
        meta: { ...dataset.meta, generatedAt: new Date().toISOString(), version: 2 },
      };
      simulationResult = null;
      simulationKey = "";
      status.textContent = `Loaded ${players.length} players and ${Object.keys(schedule).length} team schedules into this session.`;
      setDataStatus(`${players.length} players ready · live refresh`, "ready");
      renderAll();
      toast("Projections and schedules refreshed from ESPN.");
    } catch (error) {
      status.textContent = `${error.message || "Live refresh failed"}. The bundled snapshot remains active.`;
      toast("Bundled player data remains active.", true);
    }
  }
  function handleDelegatedClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    const playerId = target.dataset.playerId;
    if (action === "draft-player") draftPlayer(playerId);
    if (action === "add-roster-player") addRosterPlayer(playerId);
    if (action === "remove-roster-player") removeRosterPlayer(playerId);
    if (action === "apply-waiver") applyWaiver(target.dataset.addId, target.dataset.dropId);
    if (action === "add-trade-give") addTradePlayer("give", playerId);
    if (action === "add-trade-receive") addTradePlayer("receive", playerId);
    if (action === "remove-trade-give") removeTradePlayer("give", playerId);
    if (action === "remove-trade-receive") removeTradePlayer("receive", playerId);
    if (action === "load-trade-proposal") loadTradeProposal(target.dataset.proposalIndex);
  }

  function bindInput(selector, stateKey, render) {
    $(selector).addEventListener("input", (event) => {
      state.filters[stateKey] = event.target.value;
      persistState();
      render();
    });
  }

  function updateOnlineState() {
    document.body.classList.toggle("is-offline", !navigator.onLine);
    const text = $("#data-status-text");
    if (text) text.classList.toggle("offline-badge", !navigator.onLine);
    if (!navigator.onLine) setSimulationStatus("Offline · bundled models active");
  }

  async function registerPwa() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("service-worker.js");
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  }

  async function installApplication() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("#install-app-button").hidden = true;
  }

  function bindEvents() {
    document.addEventListener("error", (event) => {
      const image = event.target.closest?.("img[data-avatar-fallback]");
      if (!image) return;
      const parent = image.parentElement;
      const fallback = image.dataset.avatarFallback || "?";
      image.remove();
      if (parent) parent.textContent = fallback;
    }, true);
    document.addEventListener("click", handleDelegatedClick);
    $$("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
    $("#open-setup-button").addEventListener("click", openSetupDialog);
    $("#export-state-button").addEventListener("click", exportState);
    $("#import-state-file").addEventListener("change", (event) => importStateFile(event.target.files?.[0]));
    $("#refresh-trends-button").addEventListener("click", () => refreshSleeperTrends(true));
    $("#refresh-player-data-button").addEventListener("click", refreshEspnPlayerData);
    $("#install-app-button").addEventListener("click", installApplication);
    $("#run-simulation-button").addEventListener("click", () => requestDraftSimulation(1000, true));

    $("#draft-top-player-button").addEventListener("click", (event) => draftPlayer(event.currentTarget.dataset.playerId));
    $("#draft-team-override").addEventListener("change", (event) => {
      state.draftOverrideTeamId = Number(event.target.value);
      persistState();
      renderDraftView();
    });
    $("#undo-pick-button").addEventListener("click", () => {
      state.draft = core.undoDraftPick(state.draft);
      state.draftOverrideTeamId = core.draftPickSummary(state.draft, state.settings).teamId;
      persistState();
      renderAll();
    });
    $("#reset-draft-button").addEventListener("click", resetDraft);

    bindInput("#draft-player-search", "draftQuery", () => renderDraftPlayerList([...recommendationMap.values()]));
    $("#draft-position-filter").addEventListener("change", (event) => {
      state.filters.draftPosition = event.target.value;
      persistState();
      renderDraftPlayerList([...recommendationMap.values()]);
    });
    $("#draft-sort-select").addEventListener("change", (event) => {
      state.filters.draftSort = event.target.value;
      persistState();
      renderDraftPlayerList([...recommendationMap.values()]);
    });
    $("#use-draft-roster-button").addEventListener("click", () => {
      state.manualRosterInitialized = true;
      state.manualRosterIds = [...draftRosterIds(state.settings.draftPosition)];
      persistState();
      renderTeamView();
      toast("Drafted roster copied into Team Manager.");
    });
    $("#run-championship-button").addEventListener("click", runChampionshipEvaluation);
    $("#optimize-lineup-button").addEventListener("click", () => {
      renderTeamView();
      toast("Lineup optimized for projected weekly points.");
    });
    $("#team-week-select").addEventListener("change", (event) => {
      state.selectedWeek = Number(event.target.value);
      championshipResult = null;
      persistState();
      renderTeamView();
    });
    bindInput("#roster-player-search", "rosterQuery", renderRosterSearch);

    bindInput("#trade-give-search", "tradeGiveQuery", renderTradeView);
    bindInput("#trade-receive-search", "tradeReceiveQuery", renderTradeView);
    $("#trade-week-select").addEventListener("change", (event) => {
      state.tradeWeek = Number(event.target.value);
      generatedTradeProposals = [];
      persistState();
      renderTradeView();
    });
    $("#trade-opponent-select").addEventListener("change", (event) => {
      state.tradeOpponentTeamId = String(event.target.value || "");
      generatedTradeProposals = [];
      persistState();
      renderTradeView();
    });
    $("#generate-trades-button").addEventListener("click", generateTradeIdeas);
    $("#clear-trade-button").addEventListener("click", () => {
      state.trade = { giveIds: [], receiveIds: [] };
      persistState();
      renderTradeView();
    });

    $("#find-sleeper-leagues-button").addEventListener("click", findSleeperLeagues);
    $("#import-sleeper-button").addEventListener("click", importSleeperLeague);
    $("#import-espn-public-button").addEventListener("click", importEspnPublicLeague);

    const setupForm = $("#setup-form");
    setupForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (applySetup(setupForm)) $("#setup-dialog").close();
    });
    setupForm.elements.riskTolerance.addEventListener("input", (event) => {
      $("#risk-output").textContent = riskLabel(event.target.value);
    });

    window.addEventListener("message", handleEspnBridgeMessage);
    window.addEventListener("hashchange", () => setView(location.hash.slice(1), false));
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      installPrompt = event;
      $("#install-app-button").hidden = false;
    });
    window.addEventListener("appinstalled", () => {
      installPrompt = null;
      $("#install-app-button").hidden = true;
      toast("Fantasy Football Oracle installed.");
    });
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    window.addEventListener("beforeunload", persistState);
  }

  async function init() {
    bindEvents();
    updateOnlineState();
    registerPwa();
    initializeSimulationWorker();
    $("#draft-player-search").value = state.filters.draftQuery || "";
    $("#draft-position-filter").value = state.filters.draftPosition || "ALL";
    $("#draft-sort-select").value = state.filters.draftSort || "oracle";
    $("#roster-player-search").value = state.filters.rosterQuery || "";
    $("#trade-give-search").value = state.filters.tradeGiveQuery || "";
    $("#trade-receive-search").value = state.filters.tradeReceiveQuery || "";
    const requestedView = location.hash.slice(1) || state.activeView || "draft";
    setView(requestedView, false);
    loadTrendCache();
    await initializeBackend();

    try {
      await loadBundledData("default");
      if (!state.draftOverrideTeamId) {
        state.draftOverrideTeamId = core.draftPickSummary(state.draft, state.settings).teamId;
      }
      renderAll();
      if (state.connections.sleeper?.liveSync) startSleeperDraftPolling();
      if (!trendCounts.size) window.setTimeout(() => refreshSleeperTrends(false), 500);
    } catch (error) {
      setDataStatus(error.message || "Player data failed to load", "error");
      toast("Player data could not be loaded.", true);
    }
  }

  init();
})();
