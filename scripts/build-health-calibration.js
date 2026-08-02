#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { forEachCsvRow } = require("./lib/csv.js");

const ROOT = path.resolve(__dirname, "..");
const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const DEFAULT_SEASONS = [2020, 2021, 2022, 2023, 2024, 2025];
const MODEL_VERSION = "oracle-health-calibration-2026.1";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}
function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(finite(value, 0) * factor) / factor;
}
function mean(values) {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : 0;
}
function standardDeviation(values) {
  const rows = values.filter(Number.isFinite);
  if (rows.length < 2) return 0;
  const average = mean(rows);
  return Math.sqrt(mean(rows.map((value) => (value - average) ** 2)));
}
function parseArgs(argv) {
  const args = {
    seasons: [...DEFAULT_SEASONS],
    statsRoot: path.join(ROOT, "data", "historical", "raw"),
    cacheRoot: path.join(ROOT, "data", "health", "raw"),
    out: path.join(ROOT, "data", "health-calibration-2026.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--seasons") args.seasons = argv[++index].split(",").map(Number);
    else if (value === "--stats-root") args.statsRoot = path.resolve(argv[++index]);
    else if (value === "--cache-root") args.cacheRoot = path.resolve(argv[++index]);
    else if (value === "--out") args.out = path.resolve(argv[++index]);
    else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}
function printHelp() {
  console.log("Build historical injury availability and recovery calibration.\n\n" +
    "Usage: node scripts/build-health-calibration.js [--stats-root DIR] [--cache-root DIR]");
}
function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}
function injuryFamily(...values) {
  const text = values.map(normalizeText).filter(Boolean).join(" ");
  if (/acl|anterior cruciate/.test(text)) return "acl";
  if (/achilles/.test(text)) return "achilles";
  if (/concussion|head/.test(text)) return "concussion";
  if (/hamstring/.test(text)) return "hamstring";
  if (/high ankle|ankle/.test(text)) return "ankle";
  if (/lisfranc|foot|toe/.test(text)) return "foot";
  if (/meniscus|patellar|knee/.test(text)) return "knee";
  if (/shoulder|clavicle/.test(text)) return "shoulder";
  if (/back|spine/.test(text)) return "back";
  if (/groin|adductor/.test(text)) return "groin";
  if (/calf/.test(text)) return "calf";
  if (/quadriceps|quad/.test(text)) return "quadriceps";
  if (/hip/.test(text)) return "hip";
  if (/rib|chest|sternum/.test(text)) return "rib-chest";
  if (/hand|wrist|finger|thumb/.test(text)) return "hand-wrist";
  if (/illness|covid|flu/.test(text)) return "illness";
  if (/rest|not injury related|personal/.test(text)) return "non-injury";
  return text ? "other" : "unknown";
}
function reportStatus(value) {
  const text = normalizeText(value);
  if (text.includes("out")) return "out";
  if (text.includes("doubt")) return "doubtful";
  if (text.includes("question")) return "questionable";
  return text || "none";
}
function practiceStatus(value) {
  const text = normalizeText(value);
  if (/did not|dnp|no practice/.test(text)) return "dnp";
  if (/limited/.test(text)) return "limited";
  if (/full/.test(text)) return "full";
  return text || "none";
}
async function ensureInjuryFile(season, cacheRoot) {
  fs.mkdirSync(cacheRoot, { recursive: true });
  for (const extension of ["csv.gz", "csv"]) {
    const target = path.join(cacheRoot, `injuries_${season}.${extension}`);
    if (fs.existsSync(target) && fs.statSync(target).size > 1000) return target;
    const url = `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${season}.${extension}`;
    const response = await fetch(url, {
      headers: { "user-agent": "fantasy-football-oracle-health-builder/1.0" },
    });
    if (!response.ok) continue;
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(target, buffer);
    return target;
  }
  throw new Error(`Injury feed ${season} is unavailable`);
}
function statsPathForSeason(root, season) {
  const candidates = [
    path.join(root, `stats_player_week_${season}.csv`),
    path.join(root, `stats_player_week_${season}.csv.gz`),
  ];
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) throw new Error(`Missing player stats for ${season} under ${root}`);
  return match;
}
async function loadWeeklyStats(seasons, root) {
  const byKey = new Map();
  const byPlayerSeason = new Map();
  for (const season of seasons) {
    await forEachCsvRow(statsPathForSeason(root, season), (row) => {
      const position = String(row.position || "").toUpperCase();
      if (!POSITIONS.has(position) || row.season_type !== "REG") return;
      const week = Number(row.week);
      const id = String(row.player_id || row.gsis_id || "");
      if (!id || week < 1 || week > 18) return;
      const value = {
        season,
        week,
        id,
        position,
        name: String(row.player_display_name || row.player_name || ""),
        points: finite(row.fantasy_points_ppr, 0),
      };
      byKey.set(`${season}|${week}|${id}`, value);
      const playerKey = `${season}|${id}`;
      if (!byPlayerSeason.has(playerKey)) byPlayerSeason.set(playerKey, new Map());
      byPlayerSeason.get(playerKey).set(week, value);
    });
  }
  return { byKey, byPlayerSeason };
}
async function loadInjuryReports(seasons, cacheRoot) {
  const byWeek = new Map();
  for (const season of seasons) {
    const filePath = await ensureInjuryFile(season, cacheRoot);
    await forEachCsvRow(filePath, (row) => {
      const position = String(row.position || "").toUpperCase();
      const id = String(row.gsis_id || "");
      const week = Number(row.week);
      if (!POSITIONS.has(position) || !id || week < 1 || week > 18) return;
      const key = `${season}|${week}|${id}`;
      const modified = Date.parse(row.date_modified || 0) || 0;
      const current = byWeek.get(key) || {
        season,
        week,
        id,
        position,
        name: String(row.full_name || ""),
        modified: 0,
        status: "none",
        practice: "none",
        primary: "",
        secondary: "",
      };
      const nextStatus = reportStatus(row.report_status);
      const nextPractice = practiceStatus(row.practice_status);
      const primary = String(row.report_primary_injury || row.practice_primary_injury || "");
      const secondary = String(row.report_secondary_injury || row.practice_secondary_injury || "");
      if (modified >= current.modified) {
        current.modified = modified;
        if (nextStatus !== "none") current.status = nextStatus;
        if (nextPractice !== "none") current.practice = nextPractice;
        if (primary) current.primary = primary;
        if (secondary) current.secondary = secondary;
      } else {
        if (current.status === "none" && nextStatus !== "none") current.status = nextStatus;
        if (current.practice === "none" && nextPractice !== "none") current.practice = nextPractice;
        if (!current.primary && primary) current.primary = primary;
        if (!current.secondary && secondary) current.secondary = secondary;
      }
      current.family = injuryFamily(current.primary, current.secondary);
      byWeek.set(key, current);
    });
  }
  const byPlayerSeason = new Map();
  for (const row of byWeek.values()) {
    const key = `${row.season}|${row.id}`;
    if (!byPlayerSeason.has(key)) byPlayerSeason.set(key, []);
    byPlayerSeason.get(key).push(row);
  }
  for (const rows of byPlayerSeason.values()) rows.sort((a, b) => a.week - b.week);
  return { byWeek, byPlayerSeason };
}
function addGroup(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
function binarySummary(rows, selector) {
  const values = rows.map(selector).filter(Number.isFinite);
  return {
    samples: values.length,
    rate: round(mean(values), 4),
  };
}
function numericSummary(rows, selector) {
  const values = rows.map(selector).filter(Number.isFinite);
  return {
    samples: values.length,
    mean: round(mean(values), 4),
    standardDeviation: round(standardDeviation(values), 4),
  };
}
function availabilityCalibration(injuries, stats) {
  const groups = new Map();
  const rows = [];
  for (const report of injuries.byWeek.values()) {
    const played = stats.byKey.has(`${report.season}|${report.week}|${report.id}`) ? 1 : 0;
    const row = { ...report, played };
    rows.push(row);
    const keys = [
      "global",
      `status:${report.status}`,
      `practice:${report.practice}`,
      `status-practice:${report.status}|${report.practice}`,
      `position-status-practice:${report.position}|${report.status}|${report.practice}`,
      `family-status:${report.family}|${report.status}`,
    ];
    keys.forEach((key) => addGroup(groups, key, row));
  }
  return {
    rows,
    groups: Object.fromEntries([...groups].map(([key, values]) => [
      key,
      binarySummary(values, (row) => row.played),
    ])),
  };
}
function playedValues(weeks, start, end) {
  const values = [];
  for (let week = start; week <= end; week += 1) {
    const row = weeks.get(week);
    if (row) values.push(row.points);
  }
  return values;
}
function addGroup(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
function binarySummary(rows, selector) {
  const values = rows.map(selector).filter(Number.isFinite);
  return {
    samples: values.length,
    rate: round(mean(values), 4),
  };
}
function numericSummary(rows, selector) {
  const values = rows.map(selector).filter(Number.isFinite);
  return {
    samples: values.length,
    mean: round(mean(values), 4),
    standardDeviation: round(standardDeviation(values), 4),
  };
}
function availabilityCalibration(injuries, stats) {
  const groups = new Map();
  const rows = [];
  for (const report of injuries.byWeek.values()) {
    const played = stats.byKey.has(`${report.season}|${report.week}|${report.id}`) ? 1 : 0;
    const row = { ...report, played };
    rows.push(row);
    const keys = [
      "global",
      `status:${report.status}`,
      `practice:${report.practice}`,
      `status-practice:${report.status}|${report.practice}`,
      `position-status-practice:${report.position}|${report.status}|${report.practice}`,
      `family-status:${report.family}|${report.status}`,
    ];
    keys.forEach((key) => addGroup(groups, key, row));
  }
  return {
    rows,
    groups: Object.fromEntries([...groups].map(([key, values]) => [
      key,
      binarySummary(values, (row) => row.played),
    ])),
  };
}
function playedValues(weeks, start, end) {
  const values = [];
  for (let week = start; week <= end; week += 1) {
    const row = weeks.get(week);
    if (row) values.push(row.points);
  }
  return values;
}
function recoveryEpisodes(injuries, stats) {
  const episodes = [];
  for (const [playerKey, reports] of injuries.byPlayerSeason) {
    const weeks = stats.byPlayerSeason.get(playerKey);
    if (!weeks) continue;
    const missed = reports.filter((report) => !weeks.has(report.week));
    if (!missed.length) continue;
    let index = 0;
    while (index < missed.length) {
      const block = [missed[index]];
      let cursor = index + 1;
      while (
        cursor < missed.length &&
        missed[cursor].week <= block[block.length - 1].week + 1 &&
        (missed[cursor].family === block[0].family ||
          missed[cursor].family === "unknown" || block[0].family === "unknown")
      ) {
        block.push(missed[cursor]);
        cursor += 1;
      }
      index = cursor;
      const firstMiss = block[0].week;
      const lastMiss = block[block.length - 1].week;
      let returnWeek = null;
      for (let week = lastMiss + 1; week <= Math.min(18, lastMiss + 8); week += 1) {
        if (weeks.has(week)) {
          returnWeek = week;
          break;
        }
      }
      if (!returnWeek) continue;
      const pre = playedValues(weeks, Math.max(1, firstMiss - 5), firstMiss - 1).slice(-4);
      const post = playedValues(weeks, returnWeek, Math.min(18, returnWeek + 5)).slice(0, 4);
      if (pre.length < 2 || !post.length) continue;
      const baseline = mean(pre);
      if (baseline < 2) continue;
      const firstRatio = clamp(post[0] / baseline, 0, 2);
      const fourRatio = clamp(mean(post) / baseline, 0, 2);
      const recurrence = reports.some((report) => (
        report.week > returnWeek && report.week <= returnWeek + 4 &&
        report.family === block[0].family
      )) ? 1 : 0;
      episodes.push({
        season: block[0].season,
        id: block[0].id,
        name: block[0].name,
        position: block[0].position,
        family: block[0].family,
        status: block.some((row) => row.status === "out") ? "out" : block[0].status,
        weeksMissed: lastMiss - firstMiss + 1,
        returnDelay: returnWeek - lastMiss,
        baseline: round(baseline, 3),
        firstRatio,
        fourRatio,
        sameLevel: fourRatio >= 0.9 ? 1 : 0,
        recurrence,
      });
    }
  }
  return episodes;
}
function recoverySummary(rows) {
  return {
    samples: rows.length,
    firstGameRetention: numericSummary(rows, (row) => row.firstRatio).mean,
    fourGameRetention: numericSummary(rows, (row) => row.fourRatio).mean,
    sameLevelRate: binarySummary(rows, (row) => row.sameLevel).rate,
    recurrenceRate: binarySummary(rows, (row) => row.recurrence).rate,
    meanWeeksMissed: numericSummary(rows, (row) => row.weeksMissed).mean,
    meanReturnDelay: numericSummary(rows, (row) => row.returnDelay).mean,
  };
}
function blendMetric(value, samples, prior, strength = 24) {
  const weight = samples / Math.max(1, samples + strength);
  return round(prior + (value - prior) * weight, 4);
}
function shrinkRecovery(summary, prior) {
  const samples = summary.samples || 0;
  return {
    ...summary,
    firstGameRetention: blendMetric(summary.firstGameRetention, samples, prior.firstGameRetention),
    fourGameRetention: blendMetric(summary.fourGameRetention, samples, prior.fourGameRetention),
    sameLevelRate: blendMetric(summary.sameLevelRate, samples, prior.sameLevelRate),
    recurrenceRate: blendMetric(summary.recurrenceRate, samples, prior.recurrenceRate),
    meanWeeksMissed: blendMetric(summary.meanWeeksMissed, samples, prior.meanWeeksMissed),
    meanReturnDelay: blendMetric(summary.meanReturnDelay, samples, prior.meanReturnDelay),
  };
}
function recoveryCalibration(episodes) {
  const global = recoverySummary(episodes);
  const groups = new Map();
  for (const episode of episodes) {
    [
      `position:${episode.position}`,
      `family:${episode.family}`,
      `position-family:${episode.position}|${episode.family}`,
    ].forEach((key) => addGroup(groups, key, episode));
  }
  const priors = {};
  for (const [key, rows] of groups) {
    const raw = recoverySummary(rows);
    const position = key.startsWith("position-family:")
      ? key.slice("position-family:".length).split("|")[0]
      : null;
    const positionPrior = position && groups.has(`position:${position}`)
      ? recoverySummary(groups.get(`position:${position}`))
      : global;
    priors[key] = shrinkRecovery(raw, positionPrior);
  }
  return { global, priors, episodes };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const stats = await loadWeeklyStats(args.seasons, args.statsRoot);
  const injuries = await loadInjuryReports(args.seasons, args.cacheRoot);
  const availability = availabilityCalibration(injuries, stats);
  const episodes = recoveryEpisodes(injuries, stats);
  const recovery = recoveryCalibration(episodes);
  const output = {
    meta: {
      version: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      seasons: args.seasons,
      injuryReports: injuries.byWeek.size,
      recoveryEpisodes: episodes.length,
      sources: [
        "nflverse official injury and practice reports",
        "nflverse weekly player fantasy outcomes",
      ],
      leakageControls: [
        "Each injury report is joined only to the same or later weekly outcome.",
        "Recovery baselines use only games before the missed injury block.",
        "Return performance uses only games after the player resumes play.",
      ],
      limitations: [
        "A player with no recorded fantasy statistic may be treated as inactive.",
        "Official reports do not consistently encode surgical severity or exact diagnosis.",
        "Recovery episodes represent players who returned within eight weeks and may underrepresent season-ending injuries.",
      ],
    },
    availability: {
      samples: availability.rows.length,
      groups: availability.groups,
    },
    recovery: {
      global: recovery.global,
      priors: recovery.priors,
    },
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(output)}\n`, "utf8");
  console.log(JSON.stringify({
    output: args.out,
    bytes: fs.statSync(args.out).size,
    injuryReports: output.meta.injuryReports,
    availabilitySamples: output.availability.samples,
    recoveryEpisodes: output.meta.recoveryEpisodes,
    globalRecovery: output.recovery.global,
  }, null, 2));
}

module.exports = {
  MODEL_VERSION,
  availabilityCalibration,
  injuryFamily,
  practiceStatus,
  recoveryCalibration,
  recoveryEpisodes,
  reportStatus,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
