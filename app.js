(() => {
  "use strict";

  const core = window.FantasyOracleCore;
  if (!core) throw new Error("FantasyOracleCore failed to load");

  const STORAGE_KEY = "fantasy-football-oracle:v1";
  const TREND_CACHE_KEY = "fantasy-football-oracle:trends:v1";
  const PLAYER_DATA_URL = "data/players-2026.json";
  const SLEEPER_API = "https://api.sleeper.app/v1";
  const ORACLE_ORIGIN = window.location.origin;

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

  let dataset = { meta: {}, players: [] };
  let players = [];
  let playerMap = new Map();
  let sleeperPlayerMap = null;
  let sleeperLeagues = [];
  let sleeperPollTimer = null;
  let recommendationMap = new Map();
  let trendCounts = new Map();
  function defaultState() {
    const settings = core.cloneSettings();
    return {
      version: 1,
      activeView: "draft",
      settings,
      draft: core.createDraftState(settings),
      teamNames: {},
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
    return `<span class="player-avatar ${className}" aria-hidden="true">${image ? `<img src="${image}" alt="" loading="lazy" onerror="this.remove();this.parentElement.textContent='${fallback}'" />` : fallback}</span>`;
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

  function setDataStatus(text, mode = "loading") {
    $("#data-status-text").textContent = text;
    const light = $("#data-status-light");
    light.className = `status-light${mode === "ready" ? " is-ready" : mode === "error" ? " is-error" : ""}`;
  }
  async function loadBundledData(cache = "default") {
    setDataStatus("Loading 2026 player data");
    const response = await fetch(PLAYER_DATA_URL, { cache });
    if (!response.ok) throw new Error(`Player data returned HTTP ${response.status}`);
    dataset = await response.json();
    players = (dataset.players || []).map(core.normalizePlayer);
    playerMap = new Map(players.map((player) => [player.id, player]));
    const updated = dataset.meta?.generatedAt
      ? new Date(dataset.meta.generatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "bundled";
    setDataStatus(`${players.length} players ready · updated ${updated}`, "ready");
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
    $("#league-status-text").textContent = `${settings.teams}-team ${scoring} · Pick ${settings.draftPosition}`;
  }
  function draftRosterIds(teamId) {
    return state.draft.rosters?.[String(teamId)] || [];
  }

  function rosterPlayersFromIds(ids) {
    return (ids || []).map(playerById).filter(Boolean);
  }

  function computeDraftRecommendations(teamId) {
    const rows = core.recommendPlayers(
      players,
      state.draft,
      state.settings,
      teamId,
      260,
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

    container.innerHTML = `${playerAvatar(top, "player-avatar-large")}<div>
      <span class="play-call">Oracle's call · ${escapeHtml(top.position)} · score ${top.score.toFixed(1)}</span>
      <h1>${escapeHtml(top.name)}</h1>
      <p>${escapeHtml(top.reasons.join(" · "))}</p>
    </div>`;
    action.disabled = false;
    action.dataset.playerId = top.id;
    action.textContent = `Draft ${top.name}`;
  }
  function displayRank(player) {
    return Math.round(core.rankForScoring(player, state.settings.scoring));
  }

  function playerRowHtml(player, action, actionLabel = "+") {
    const recommendation = recommendationMap.get(player.id);
    const oracleScore = recommendation?.score;
    const metric = oracleScore !== undefined ? oracleScore.toFixed(1) : player.weeklyProjection.toFixed(1);
    const metricLabel = oracleScore !== undefined ? "oracle" : "weekly";
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
      const scoreA = recommendationMap.get(a.id)?.score ?? -displayRank(a);
      const scoreB = recommendationMap.get(b.id)?.score ?? -displayRank(b);
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

  function renderDraftView() {
    const summary = core.draftPickSummary(state.draft, state.settings);
    if (!state.draftOverrideTeamId) state.draftOverrideTeamId = summary.teamId;
    const recommendations = computeDraftRecommendations(Number(state.draftOverrideTeamId) || summary.teamId);
    renderDraftCommand(recommendations);
    renderDraftPlayerList(recommendations);
    renderDraftBoard();
    renderMyDraft(recommendations);
  }
  function activeRosterIds() {
    if (state.manualRosterInitialized) return state.manualRosterIds;
    return [...draftRosterIds(state.settings.draftPosition)];
  }

  function activeRosterPlayers() {
    return rosterPlayersFromIds(activeRosterIds());
  }

  function renderOptimizedLineup(roster) {
    const lineup = core.optimizeLineup(roster, state.settings);
    $("#lineup-total").textContent = `${lineup.total.toFixed(1)} pts`;
    $("#optimized-lineup").innerHTML = lineup.starters.map((row) => {
      const player = row.player;
      return `<div class="lineup-slot" style="${positionStyle(player || { position: row.slot })}">
        <span class="lineup-slot-label">${escapeHtml(row.slot)}</span>
        ${playerAvatar(player)}
        <div class="roster-item-main"><strong>${player ? escapeHtml(player.name) : "Open slot"}</strong><span>${player ? `${escapeHtml(player.team)} · ${escapeHtml(player.position)}` : "Add an eligible player"}</span></div>
        <strong>${player ? player.weeklyProjection.toFixed(1) : "—"}</strong>
      </div>`;
    }).join("");
    return lineup;
  }

  function renderManualRoster(roster, lineup) {
    const starterIds = new Set(lineup.starters.filter((row) => row.player).map((row) => row.player.id));
    $("#manual-roster-count").textContent = `${roster.length} player${roster.length === 1 ? "" : "s"}`;
    $("#manual-roster-list").innerHTML = roster.length
      ? roster.sort((a, b) => Number(starterIds.has(b.id)) - Number(starterIds.has(a.id)) || b.weeklyProjection - a.weeklyProjection)
        .map((player) => `<div class="roster-item" style="${positionStyle(player)}">
          ${playerAvatar(player)}
          <div class="roster-item-main"><strong>${escapeHtml(player.name)}</strong><span>${starterIds.has(player.id) ? "Starter" : "Bench"} · ${escapeHtml(player.position)} · ${player.weeklyProjection.toFixed(1)} weekly</span></div>
          <button class="remove-button" type="button" data-action="remove-roster-player" data-player-id="${escapeHtml(player.id)}" aria-label="Remove ${escapeHtml(player.name)}">×</button>
        </div>`).join("")
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

  function renderWaiverRecommendations(roster) {
    if (!roster.length) {
      $("#waiver-recommendations").innerHTML = `<div class="empty-state">Add a roster before running waiver analysis.</div>`;
      return;
    }
    const rosterIds = roster.map((player) => player.id);
    const candidates = freeAgentPool(rosterIds)
      .map((player) => ({
        ...player,
        trendCount: trendCounts.get(canonicalName(player.name)) || 0,
      }))
      .sort((a, b) => (b.weeklyProjection + Math.log10(b.trendCount + 1) * 0.7) - (a.weeklyProjection + Math.log10(a.trendCount + 1) * 0.7))
      .slice(0, 28);
    const suggestions = core.waiverRecommendations(roster, candidates, state.settings, 10);
    $("#waiver-recommendations").innerHTML = suggestions.length
      ? suggestions.map((row) => `<div class="waiver-item">
          ${playerAvatar(row.add)}
          <div class="waiver-main"><strong>Add ${escapeHtml(row.add.name)}</strong><span>Drop ${escapeHtml(row.drop.name)} · ${escapeHtml(row.reason)}</span></div>
          <div class="waiver-move"><strong>+${row.score.toFixed(1)}</strong><span>${row.add.trendCount ? `${row.add.trendCount} adds` : "oracle"}</span><button class="button button-small button-signal" type="button" data-action="apply-waiver" data-add-id="${escapeHtml(row.add.id)}" data-drop-id="${escapeHtml(row.drop.id)}">Apply</button></div>
        </div>`).join("")
      : `<div class="empty-state">No clear add/drop upgrade was found in the current player pool.</div>`;
  }

  function renderTeamView() {
    const roster = activeRosterPlayers();
    const lineup = renderOptimizedLineup(roster);
    renderManualRoster(roster, lineup);
    renderRosterSearch();
    renderWaiverRecommendations(roster);
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

  function renderTradeView() {
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
    const result = core.analyzeTrade({
      roster,
      give,
      receive,
      players,
      settings: state.settings,
    });
    $("#trade-grade").textContent = result.grade;
    $("#trade-verdict-title").textContent = result.verdict;
    $("#trade-verdict-summary").textContent = result.summary;
    $("#trade-lineup-gain").textContent = `${result.lineupGain >= 0 ? "+" : ""}${result.lineupGain.toFixed(1)}`;
    $("#trade-asset-gain").textContent = `${result.assetGain >= 0 ? "+" : ""}${result.assetGain.toFixed(1)}`;
    $("#trade-fairness").textContent = `${result.fairness}%`;
    $("#trade-fairness-bar").style.width = `${result.fairness}%`;
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
      const [league, rosters, users, drafts, map] = await Promise.all([
        sleeperFetch(`/league/${leagueId}`),
        sleeperFetch(`/league/${leagueId}/rosters`),
        sleeperFetch(`/league/${leagueId}/users`),
        sleeperFetch(`/league/${leagueId}/drafts`),
        getSleeperPlayerMap(),
      ]);
      const userId = String(state.connections.sleeper.userId || "");
      const ownRoster = rosters.find((roster) => String(roster.owner_id) === userId) || rosters[0];
      if (!ownRoster) throw new Error("No roster was found in this league");
      const draft = drafts[0] || null;
      const picks = draft ? await sleeperFetch(`/draft/${draft.draft_id}/picks`) : [];
      const settings = settingsFromSleeper(league, draft, ownRoster.roster_id);
      const userById = new Map(users.map((user) => [String(user.user_id), user]));
      const teamNames = {};
      rosters.forEach((roster) => {
        const user = userById.get(String(roster.owner_id));
        teamNames[String(roster.roster_id)] = user?.metadata?.team_name || user?.display_name || `Team ${roster.roster_id}`;
      });

      state.settings = settings;
      state.teamNames = teamNames;
      state.draft = buildDraftFromSleeperPicks(picks, settings, map);
      state.draftOverrideTeamId = core.draftPickSummary(state.draft, settings).teamId;
      state.manualRosterIds = mapSleeperIds(ownRoster.players || [], map);
      state.manualRosterInitialized = true;
      state.trade = { giveIds: [], receiveIds: [] };
      state.connections.sleeper = {
        ...state.connections.sleeper,
        leagueId,
        leagueName: league.name,
        draftId: draft?.draft_id || null,
        ownRosterId: ownRoster.roster_id,
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

    teams.forEach((team) => {
      espnRosterEntries(team).forEach((entry) => ensureEspnPlayer(espnEntryPlayer(entry)));
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
    state.teamNames = teamNames;
    state.draft = draftState;
    state.draftOverrideTeamId = core.draftPickSummary(draftState, settings).teamId;
    state.manualRosterIds = [...new Set(rosterIds)];
    state.manualRosterInitialized = true;
    state.trade = { giveIds: [], receiveIds: [] };
    state.connections.espn = {
      ...state.connections.espn,
      leagueId: String(payload.id || state.connections.espn.leagueId || ""),
      leagueName: leagueSettings.name || payload.name || "ESPN league",
      season: Number(payload.seasonId || state.connections.espn.season || 2026),
      teamId,
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
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${encodeURIComponent(leagueId)}?view=mTeam&view=mRoster&view=mSettings&view=mDraftDetail`;
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

  function normalizeEspnFeedPlayer(wrapper, season) {
    const raw = wrapper?.player || {};
    const position = POSITION_BY_ESPN_ID[Number(raw.defaultPositionId)];
    if (!position) return null;
    const projection = espnSeasonTotal(raw.stats, season, 1);
    const previous = espnSeasonTotal(raw.stats, season - 1, 0);
    const rank = (type) => Number(raw.draftRanksByRankType?.[type]?.rank || 0) || null;
    const ownership = raw.ownership || {};
    const team = TEAM_BY_ESPN_ID[Number(raw.proTeamId)] || "FA";
    return core.normalizePlayer({
      id: String(raw.id || wrapper.id),
      name: raw.fullName,
      position,
      team,
      projectedPoints: projection || previous * 0.92,
      weeklyProjection: (projection || previous * 0.92) / 17,
      previousPoints: previous,
      adp: Number(ownership.averageDraftPosition || 0) || null,
      auctionValue: Number(ownership.auctionValueAverage || 0),
      percentOwned: Number(ownership.percentOwned || 0),
      pprRank: rank("PPR"),
      standardRank: rank("STANDARD"),
      superflexRank: rank("SUPERFLEX"),
      injuryStatus: raw.injuryStatus || "ACTIVE",
      injuryRisk: raw.injured ? 0.45 : 0.08,
      image: position === "DST"
        ? `https://a.espncdn.com/i/teamlogos/nfl/500/${team.toLowerCase()}.png`
        : `https://a.espncdn.com/i/headshots/nfl/players/full/${raw.id}.png`,
    });
  }

  async function refreshEspnPlayerData() {
    const status = $("#player-refresh-status");
    const season = Number(dataset.meta?.season || 2026);
    status.textContent = "Requesting the current ESPN player feed…";
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/1?view=kona_player_info`;
    const filter = { players: { limit: 700, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { "x-fantasy-filter": JSON.stringify(filter) },
      });
      if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status}`);
      const payload = await response.json();
      const refreshed = (payload.players || []).map((row) => normalizeEspnFeedPlayer(row, season)).filter(Boolean);
      players = refreshed;
      playerMap = new Map(players.map((player) => [player.id, player]));
      dataset.meta.generatedAt = new Date().toISOString();
      status.textContent = `Loaded ${players.length} current ESPN players into this browser session.`;
      setDataStatus(`${players.length} players ready · live refresh`, "ready");
      renderAll();
      toast("Player projections refreshed from ESPN.");
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
  }

  function bindInput(selector, stateKey, render) {
    $(selector).addEventListener("input", (event) => {
      state.filters[stateKey] = event.target.value;
      persistState();
      render();
    });
  }

  function bindEvents() {
    document.addEventListener("click", handleDelegatedClick);
    $$("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
    $("#open-setup-button").addEventListener("click", openSetupDialog);
    $("#export-state-button").addEventListener("click", exportState);
    $("#import-state-file").addEventListener("change", (event) => importStateFile(event.target.files?.[0]));
    $("#refresh-trends-button").addEventListener("click", () => refreshSleeperTrends(true));
    $("#refresh-player-data-button").addEventListener("click", refreshEspnPlayerData);

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
    $("#optimize-lineup-button").addEventListener("click", () => {
      renderTeamView();
      toast("Lineup optimized for projected weekly points.");
    });
    bindInput("#roster-player-search", "rosterQuery", renderRosterSearch);

    bindInput("#trade-give-search", "tradeGiveQuery", renderTradeView);
    bindInput("#trade-receive-search", "tradeReceiveQuery", renderTradeView);
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
    window.addEventListener("beforeunload", persistState);
  }

  async function init() {
    bindEvents();
    $("#draft-player-search").value = state.filters.draftQuery || "";
    $("#draft-position-filter").value = state.filters.draftPosition || "ALL";
    $("#draft-sort-select").value = state.filters.draftSort || "oracle";
    $("#roster-player-search").value = state.filters.rosterQuery || "";
    $("#trade-give-search").value = state.filters.tradeGiveQuery || "";
    $("#trade-receive-search").value = state.filters.tradeReceiveQuery || "";
    const requestedView = location.hash.slice(1) || state.activeView || "draft";
    setView(requestedView, false);
    loadTrendCache();

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
