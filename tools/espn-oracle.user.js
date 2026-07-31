// ==UserScript==
// @name         Fantasy Football Oracle ESPN Bridge
// @namespace    https://github.com/dbontr/fantasy-football-oracle
// @version      1.0.0
// @description  Sends the ESPN league and live draft snapshot to Fantasy Football Oracle without exposing ESPN cookies.
// @match        https://fantasy.espn.com/football/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const ORACLE_URL = "https://dbontr.github.io/fantasy-football-oracle/";
  const ORACLE_ORIGIN = "https://dbontr.github.io";
  const STORAGE_KEY = "fantasyFootballOracleEspnBridge";
  let oracleWindow = null;
  let pollTimer = null;

  function readContext() {
    const url = new URL(window.location.href);
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    const leagueId = url.searchParams.get("leagueId") || saved.leagueId || "";
    const season = Number(url.searchParams.get("seasonId") || saved.season || new Date().getFullYear());
    const teamId = Number(url.searchParams.get("teamId") || saved.teamId || 1);
    return { leagueId, season, teamId };
  }

  function saveContext(context) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(context));
  }
  async function fetchLeague(context) {
    if (!context.leagueId) throw new Error("Open an ESPN league page or enter a league ID.");
    const endpoint = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${context.season}/segments/0/leagues/${encodeURIComponent(context.leagueId)}?view=mTeam&view=mRoster&view=mSettings&view=mDraftDetail`;
    const response = await fetch(endpoint, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status}`);
    return response.json();
  }

  function openOracle() {
    if (!oracleWindow || oracleWindow.closed) {
      oracleWindow = window.open(`${ORACLE_URL}#connect`, "fantasy-football-oracle");
    }
    return oracleWindow;
  }

  async function sendSnapshot(statusNode) {
    const context = readContext();
    if (!context.leagueId) {
      const leagueId = window.prompt("ESPN league ID", "");
      if (!leagueId) return;
      context.leagueId = leagueId.trim();
    }
    const teamInput = window.prompt("Your ESPN team ID", String(context.teamId || 1));
    if (teamInput) context.teamId = Number(teamInput) || 1;
    saveContext(context);
    statusNode.textContent = "Reading ESPN league…";
    const payload = await fetchLeague(context);
    const target = openOracle();
    if (!target) throw new Error("Allow pop-ups for ESPN so Oracle can open.");

    const message = {
      type: "fantasy-football-oracle:espn",
      payload,
      teamId: context.teamId,
      sentAt: Date.now(),
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      window.setTimeout(() => target.postMessage(message, ORACLE_ORIGIN), 700 + attempt * 450);
    }
    statusNode.textContent = `Sent ${payload.draftDetail?.picks?.length || 0} picks · ${new Date().toLocaleTimeString()}`;
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
    const panel = document.createElement("aside");
    panel.id = "fantasy-oracle-espn-bridge";
    panel.innerHTML = `
      <strong>Fantasy Football Oracle</strong>
      <span>Private ESPN bridge</span>
      <button type="button">Start live Oracle sync</button>
      <small>League data goes directly from this ESPN tab to your Oracle tab.</small>
    `;
    const button = panel.querySelector("button");
    const statusNode = panel.querySelector("span");
    button.addEventListener("click", () => toggleSync(button, statusNode));
    document.body.append(panel);

    const style = document.createElement("style");
    style.textContent = `
      #fantasy-oracle-espn-bridge{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:grid;gap:7px;width:245px;padding:15px;color:#f4f0e5;background:#07130f;border:1px solid rgba(255,255,255,.18);border-top:5px solid #ffb000;border-radius:12px;box-shadow:0 18px 55px rgba(0,0,0,.38);font:13px/1.35 system-ui,sans-serif}
      #fantasy-oracle-espn-bridge strong{font-size:15px}
      #fantasy-oracle-espn-bridge span,#fantasy-oracle-espn-bridge small{color:#a7bbb2}
      #fantasy-oracle-espn-bridge button{padding:9px 11px;color:#07130f;background:#ffb000;border:0;border-radius:8px;cursor:pointer;font-weight:800}
      #fantasy-oracle-espn-bridge button[data-active="true"]{color:#fff;background:#d71920}
    `;
    document.head.append(style);
  }

  mountBridge();
})();
