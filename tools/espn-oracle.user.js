// ==UserScript==
// @name         Fantasy Football Oracle ESPN Bridge
// @namespace    https://github.com/dbontr/fantasy-football-oracle
// @version      2.0.0
// @description  Sends an ESPN league snapshot directly to your configured Fantasy Football Oracle instance.
// @match        https://fantasy.espn.com/football/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "fantasyFootballOracleEspnBridge:v2";
  const LEGACY_STORAGE_KEY = "fantasyFootballOracleEspnBridge";
  const DEFAULT_ORACLE_URL = "http://localhost:8787/";
  let oracleWindow = null;
  let pollTimer = null;

  function readSaved() {
    try {
      return {
        ...JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "{}"),
        ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"),
      };
    } catch {
      return {};
    }
  }

  function saveContext(context) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(context));
  }

  function normalizeOracleUrl(value) {
    const url = new URL(String(value || DEFAULT_ORACLE_URL).trim());
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Oracle URL must use HTTP or HTTPS.");
    }
    url.hash = "";
    url.search = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  }

  function readContext() {
    const pageUrl = new URL(window.location.href);
    const saved = readSaved();
    return {
      leagueId: pageUrl.searchParams.get("leagueId") || saved.leagueId || "",
      season: Number(
        pageUrl.searchParams.get("seasonId") ||
        saved.season ||
        new Date().getFullYear()
      ),
      teamId: Number(pageUrl.searchParams.get("teamId") || saved.teamId || 1),
      oracleUrl: normalizeOracleUrl(saved.oracleUrl || DEFAULT_ORACLE_URL),
    };
  }

  function configureOracleUrl(statusNode) {
    const context = readContext();
    const value = window.prompt(
      "Fantasy Football Oracle URL",
      context.oracleUrl,
    );
    if (!value) return context;
    context.oracleUrl = normalizeOracleUrl(value);
    saveContext(context);
    statusNode.textContent = `Destination: ${new URL(context.oracleUrl).host}`;
    return context;
  }

  async function fetchLeague(context) {
    if (!context.leagueId) {
      throw new Error("Open an ESPN league page or enter a league ID.");
    }
    const endpoint = [
      "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/",
      context.season,
      "/segments/0/leagues/",
      encodeURIComponent(context.leagueId),
      "?view=mTeam&view=mRoster&view=mSettings&view=mDraftDetail",
    ].join("");
    const response = await fetch(endpoint, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status}`);
    return response.json();
  }

  function openOracle(context) {
    const url = new URL("#connect", context.oracleUrl).toString();
    if (!oracleWindow || oracleWindow.closed) {
      oracleWindow = window.open(url, "fantasy-football-oracle");
    } else {
      oracleWindow.location.href = url;
      oracleWindow.focus();
    }
    return oracleWindow;
  }

  function promptLeagueContext(context) {
    if (!context.leagueId) {
      const leagueId = window.prompt("ESPN league ID", "");
      if (!leagueId) return null;
      context.leagueId = leagueId.trim();
    }
    const teamInput = window.prompt(
      "Your ESPN team ID",
      String(context.teamId || 1),
    );
    if (teamInput) context.teamId = Number(teamInput) || 1;
    saveContext(context);
    return context;
  }

  async function sendSnapshot(statusNode) {
    const context = promptLeagueContext(readContext());
    if (!context) return;
    statusNode.textContent = "Reading ESPN league…";
    const payload = await fetchLeague(context);
    const target = openOracle(context);
    if (!target) throw new Error("Allow pop-ups for ESPN so Oracle can open.");

    const targetOrigin = new URL(context.oracleUrl).origin;
    const message = {
      type: "fantasy-football-oracle:espn",
      payload,
      teamId: context.teamId,
      sentAt: Date.now(),
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      window.setTimeout(
        () => target.postMessage(message, targetOrigin),
        700 + attempt * 450,
      );
    }
    const pickCount = payload.draftDetail?.picks?.length || 0;
    statusNode.textContent = [
      `Sent ${pickCount} picks`,
      new URL(context.oracleUrl).host,
      new Date().toLocaleTimeString(),
    ].join(" · ");
  }

  function stopSync(button, statusNode) {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    button.textContent = "Start live Oracle sync";
    button.dataset.active = "false";
    statusNode.textContent = "Sync stopped.";
  }

  async function toggleSync(button, statusNode) {
    if (pollTimer) {
      stopSync(button, statusNode);
      return;
    }
    button.textContent = "Stop live Oracle sync";
    button.dataset.active = "true";
    try {
      await sendSnapshot(statusNode);
      pollTimer = window.setInterval(() => {
        sendSnapshot(statusNode).catch((error) => {
          statusNode.textContent = error.message;
          stopSync(button, statusNode);
        });
      }, 7000);
    } catch (error) {
      statusNode.textContent = error.message;
      stopSync(button, statusNode);
    }
  }

  function mountBridge() {
    if (document.querySelector("#fantasy-oracle-espn-bridge")) return;
    const context = readContext();
    const panel = document.createElement("aside");
    panel.id = "fantasy-oracle-espn-bridge";
    panel.innerHTML = `
      <strong>Fantasy Football Oracle</strong>
      <span>Destination: ${new URL(context.oracleUrl).host}</span>
      <button type="button" data-role="sync">Start live Oracle sync</button>
      <button type="button" data-role="configure">Configure Oracle URL</button>
      <small>League data moves directly from this ESPN tab to your Oracle tab.</small>
    `;
    const syncButton = panel.querySelector('[data-role="sync"]');
    const configureButton = panel.querySelector('[data-role="configure"]');
    const statusNode = panel.querySelector("span");
    syncButton.addEventListener(
      "click",
      () => toggleSync(syncButton, statusNode),
    );
    configureButton.addEventListener(
      "click",
      () => configureOracleUrl(statusNode),
    );
    document.body.append(panel);

    const style = document.createElement("style");
    style.textContent = `
      #fantasy-oracle-espn-bridge{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:grid;gap:7px;width:265px;padding:15px;color:#f4f0e5;background:#07130f;border:1px solid rgba(255,255,255,.18);border-top:5px solid #ffb000;border-radius:12px;box-shadow:0 18px 55px rgba(0,0,0,.38);font:13px/1.35 system-ui,sans-serif}
      #fantasy-oracle-espn-bridge strong{font-size:15px}
      #fantasy-oracle-espn-bridge span,#fantasy-oracle-espn-bridge small{overflow-wrap:anywhere;color:#a7bbb2}
      #fantasy-oracle-espn-bridge button{padding:9px 11px;color:#07130f;background:#ffb000;border:0;border-radius:8px;cursor:pointer;font-weight:800}
      #fantasy-oracle-espn-bridge button[data-role="configure"]{color:#f4f0e5;background:#18372c;border:1px solid rgba(255,255,255,.16)}
      #fantasy-oracle-espn-bridge button[data-active="true"]{color:#fff;background:#d71920}
    `;
    document.head.append(style);
  }

  mountBridge();
})();
