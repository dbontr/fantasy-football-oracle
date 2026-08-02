"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  injuryFamily,
  practiceStatus,
  reportStatus,
} = require("../scripts/build-health-calibration.js");

const HEALTH_MODEL_VERSION = "oracle-health-2026.1";
const CALIBRATION_PATH = path.resolve(__dirname, "..", "data", "health-calibration-2026.json");

const MAJOR_PRIORS = Object.freeze({
  acl: { returnProbability: 0.75, firstGameRetention: 0.78, fourGameRetention: 0.86, longTermSameLevelRate: 0.68, recurrenceRate: 0.12, rampWeeks: 6 },
  achilles: { returnProbability: 0.61, firstGameRetention: 0.70, fourGameRetention: 0.80, longTermSameLevelRate: 0.55, recurrenceRate: 0.15, rampWeeks: 8 },
  patellar: { returnProbability: 0.60, firstGameRetention: 0.68, fourGameRetention: 0.78, longTermSameLevelRate: 0.54, recurrenceRate: 0.16, rampWeeks: 8 },
});

let cachedCalibration = null;
function loadHealthCalibration() {
  if (!cachedCalibration) cachedCalibration = JSON.parse(fs.readFileSync(CALIBRATION_PATH, "utf8"));
  return cachedCalibration;
}
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
function normalizedText(...values) {
  return values.map((value) => String(value || "").toLowerCase()).join(" ");
}
function detailedFamily(source = {}) {
  const text = normalizedText(source.injuryBodyPart, source.injuryNotes);
  if (/patellar/.test(text)) return "patellar";
  return injuryFamily(source.injuryBodyPart, source.injuryNotes);
}
function canonicalStatus(value) {
  const text = String(value || "ACTIVE").toLowerCase();
  if (/reserve\/pup|pup/.test(text)) return "pup";
  if (/reserve\/nfi|nfi/.test(text)) return "nfi";
  if (/ir|injured reserve/.test(text)) return "ir";
  if (/out/.test(text)) return "out";
  if (/doubt/.test(text)) return "doubtful";
  if (/question/.test(text)) return "questionable";
  if (/suspend/.test(text)) return "suspended";
  return "active";
}
function severityFor(source, status, family, news = {}) {
  const text = normalizedText(source?.injuryBodyPart, source?.injuryNotes, news.text);
  if (MAJOR_PRIORS[family] || /rupture|reconstruction|season-ending|season ending/.test(text)) return "major";
  if (/surgery|surgical|repair/.test(text) && ["pup", "nfi", "ir", "out"].includes(status)) return "major";
  if (["pup", "nfi", "ir", "out", "doubtful"].includes(status)) return "moderate";
  if (status === "questionable" || practiceStatus(source?.practiceParticipation) !== "none") return "minor";
  return "none";
}
function ageDays(timestamp, now) {
  const value = Number(timestamp) || Date.parse(timestamp || 0);
  return value > 0 ? Math.max(0, (now - value) / 86_400_000) : null;
}
function freshnessWeight(days) {
  if (days === null) return 0;
  if (days <= 2) return 1;
  if (days <= 7) return 0.8;
  if (days <= 14) return 0.5;
  if (days <= 30) return 0.25;
  return 0.08;
}
function classifyNewsArticle(article, now = Date.now()) {
  const text = normalizedText(article?.headline, article?.description);
  const daysOld = ageDays(article?.published, now);
  const freshness = freshnessWeight(daysOld);
  const attributable = article?.focused !== false;
  const healthRelevant = attributable && /injur|surgery|surgical|acl|achilles|hamstring|ankle|knee|foot|concussion|pup|injured reserve|rehab|practice|cleared|setback|limited|out for|miss time|return/.test(text);
  const roleRelevant = attributable && /first-team|starter|starting|lead back|featured|expanded role|breakout|demoted|backup|holdout|hold-in|suspend/.test(text);
  let availabilityDelta = 0;
  let performanceDelta = 0;
  let roleDelta = 0;
  const drivers = [];
  const apply = (pattern, amount, label, target = "availability") => {
    if (target === "role" && !roleRelevant) return;
    if (target !== "role" && !healthRelevant) return;
    if (!pattern.test(text)) return;
    if (target === "availability") availabilityDelta += amount;
    else if (target === "performance") performanceDelta += amount;
    else roleDelta += amount;
    drivers.push(label);
  };
  apply(/cleared|activated|full participant|full practice|no limitations|ready to play/, 0.16, "cleared or full participation");
  apply(/returned to practice|back at practice|resumed practice/, 0.09, "returned to practice");
  apply(/expected to play|on track|ahead of schedule|should play/, 0.08, "positive return report");
  apply(/setback|reinjur|re-injur|aggravat/, -0.18, "reported setback");
  apply(/season-ending|season ending|out for the season/, -0.55, "season-ending report");
  apply(/no timetable|indefinitely/, -0.14, "uncertain timetable");
  apply(/placed on injured reserve|placed on ir|reserve\/pup|pup list/, -0.20, "reserve designation");
  apply(/underwent surgery|had surgery|surgical repair/, -0.18, "surgical recovery");
  apply(/limited participant|limited practice|snap count/, -0.05, "limited workload");
  apply(/will miss|ruled out|out at least|sidelined/, -0.12, "expected absence");
  apply(/no limitations|fully healthy|100 percent/, 0.04, "full-performance language", "performance");
  apply(/snap count|eased back|limited workload/, -0.07, "ramp-up language", "performance");
  apply(/first-team|starter|starting|lead back|featured|expanded role|breakout/, 0.025, "positive role signal", "role");
  apply(/demoted|backup|lost the starting|holdout|hold-in|suspend/, -0.035, "negative role signal", "role");
  return {
    article,
    text,
    daysOld: daysOld === null ? null : round(daysOld, 1),
    freshness,
    attributable,
    healthRelevant,
    roleRelevant,
    availabilityDelta: round(clamp(availabilityDelta * freshness, -0.6, 0.25), 4),
    performanceDelta: round(clamp(performanceDelta * freshness, -0.2, 0.08), 4),
    roleDelta: round(clamp(roleDelta * freshness, -0.05, 0.04), 4),
    drivers,
  };
}
function newsSignals(player, now = Date.now()) {
  const rows = (player.news || []).map((article) => classifyNewsArticle(article, now));
  const healthRows = rows.filter((row) => row.healthRelevant);
  const roleRows = rows.filter((row) => row.roleRelevant);
  const availabilityDelta = clamp(healthRows.reduce((sum, row) => sum + row.availabilityDelta, 0), -0.6, 0.25);
  const performanceDelta = clamp(healthRows.reduce((sum, row) => sum + row.performanceDelta, 0), -0.2, 0.08);
  const roleDelta = clamp(roleRows.reduce((sum, row) => sum + row.roleDelta, 0), -0.05, 0.04);
  return {
    rows,
    healthRows,
    roleRows,
    availabilityDelta,
    performanceDelta,
    roleDelta,
    text: normalizedText(...rows.map((row) => row.text)),
    latestPublished: rows[0]?.article?.published || null,
    drivers: [...new Set(rows.flatMap((row) => row.drivers))],
  };
}
function availabilityLookup(calibration, position, status, practice) {
  if (["pup", "nfi", "ir"].includes(status)) return { probability: 0.02, samples: 0, source: status };
  if (status === "suspended") return { probability: 0, samples: 0, source: status };
  if (status === "active" && practice === "none") return { probability: 0.985, samples: 0, source: "active prior" };
  const groups = calibration.availability?.groups || {};
  const keys = [
    `position-status-practice:${position}|${status}|${practice}`,
    `status-practice:${status}|${practice}`,
    `status:${status}`,
    `practice:${practice}`,
    "global",
  ];
  for (const key of keys) {
    const row = groups[key];
    if (row && row.samples >= 25) {
      const weight = row.samples / (row.samples + 35);
      const neutral = status === "questionable" ? 0.58 : status === "doubtful" ? 0.08 : status === "out" ? 0.01 : 0.9;
      return {
        probability: clamp(neutral + (row.rate - neutral) * weight, 0.005, 0.995),
        samples: row.samples,
        source: key,
      };
    }
  }
  return { probability: status === "out" ? 0.01 : status === "doubtful" ? 0.08 : 0.72, samples: 0, source: "fallback" };
}
function recoveryPrior(calibration, position, family, severity) {
  const rows = calibration.recovery?.priors || {};
  const candidates = [
    rows[`position-family:${position}|${family}`],
    rows[`family:${family}`],
    rows[`position:${position}`],
    calibration.recovery?.global,
  ].filter(Boolean);
  let prior = candidates.find((row) => row.samples >= 12) || candidates[0] || {
    samples: 0,
    firstGameRetention: 0.82,
    fourGameRetention: 0.95,
    sameLevelRate: 0.46,
    recurrenceRate: 0.26,
    meanWeeksMissed: 1.5,
    meanReturnDelay: 1.7,
  };
  if (severity === "major" && MAJOR_PRIORS[family]) {
    const clinical = MAJOR_PRIORS[family];
    prior = {
      ...prior,
      returnProbability: clinical.returnProbability,
      firstGameRetention: clinical.firstGameRetention,
      fourGameRetention: clinical.fourGameRetention,
      longTermSameLevelRate: clinical.longTermSameLevelRate,
      recurrenceRate: clinical.recurrenceRate,
      rampWeeks: clinical.rampWeeks,
      source: "major-injury literature prior plus historical calibration",
    };
  } else {
    prior = {
      ...prior,
      returnProbability: severity === "moderate" ? 0.93 : 0.98,
      rampWeeks: severity === "moderate" ? 4 : 2,
      source: "nflverse return episode calibration",
    };
  }
  return prior;
}
function seasonWeekContext(schedule = {}, now = Date.now()) {
  const weekDates = Array.from({ length: 18 }, (_, index) => {
    const dates = Object.values(schedule)
      .map((team) => finite(team?.weeks?.[index]?.date, 0))
      .filter((value) => value > 0);
    return dates.length ? Math.min(...dates) : null;
  });
  const first = weekDates.find((value) => value !== null) || now;
  if (now < first) {
    return {
      currentWeek: 1,
      preseason: true,
      daysToWeekOne: Math.max(0, (first - now) / 86_400_000),
      weekDates,
    };
  }
  let currentWeek = 18;
  for (let index = 0; index < weekDates.length; index += 1) {
    const date = weekDates[index];
    if (date && now <= date + 5 * 86_400_000) {
      currentWeek = index + 1;
      break;
    }
  }
  return { currentWeek, preseason: false, daysToWeekOne: 0, weekDates };
}
function returnWindow(status, severity, prior, seasonContext, source, news) {
  const current = seasonContext.currentWeek;
  const practice = practiceStatus(source?.practiceParticipation);
  let earliest = current;
  let likely = current;
  let latest = current + 1;
  let confidence = 0.45;
  if (severity === "none") {
    confidence = 0.75;
  } else if (severity === "minor") {
    earliest = current;
    likely = current + (practice === "dnp" ? 1 : 0);
    latest = current + (practice === "dnp" ? 2 : 1);
    confidence = practice === "none" ? 0.45 : 0.7;
  } else if (severity === "moderate") {
    earliest = current + (["out", "doubtful"].includes(status) ? 1 : 0);
    likely = current + Math.max(1, Math.round(finite(prior.meanWeeksMissed, 1.5)));
    latest = likely + 2;
    confidence = 0.5;
  } else {
    if (seasonContext.preseason) {
      if (["pup", "nfi"].includes(status)) {
        earliest = 1;
        likely = 2;
        latest = 5;
      } else if (status === "ir") {
        earliest = 5;
        likely = 7;
        latest = 11;
      } else if (["questionable", "active"].includes(status)) {
        earliest = 1;
        likely = 1;
        latest = 2;
      } else {
        earliest = 1;
        likely = 2;
        latest = 4;
      }
      confidence = source?.injuryStartDate ? 0.48 : 0.32;
    } else if (status === "ir") {
      earliest = current + 4;
      likely = current + 6;
      latest = current + 10;
    } else if (["pup", "nfi"].includes(status)) {
      earliest = seasonContext.preseason ? 1 : Math.max(current, 5);
      likely = seasonContext.preseason ? 3 : Math.max(current + 2, 5);
      latest = Math.max(likely + 4, 8);
    } else if (["questionable", "active"].includes(status)) {
      earliest = current;
      likely = current + 1;
      latest = current + 3;
    } else {
      earliest = current + 2;
      likely = current + 5;
      latest = current + 9;
    }
    confidence = 0.3;
  }
  if (news.availabilityDelta >= 0.12) {
    likely = Math.max(earliest, likely - 1);
    latest = Math.max(likely, latest - 1);
    confidence += 0.12;
  }
  if (news.availabilityDelta <= -0.12) {
    likely += 1;
    latest += 2;
    confidence += 0.1;
  }
  return {
    earliestWeek: Math.round(clamp(earliest, 1, 18)),
    likelyWeek: Math.round(clamp(likely, 1, 18)),
    latestWeek: Math.round(clamp(latest, 1, 18)),
    confidence: round(clamp(confidence, 0.2, 0.9), 3),
  };
}
function weeklyHealthCurve(options) {
  const {
    status, severity, prior, seasonContext, window, baseAvailability,
    news, practice,
  } = options;
  const blend = severity === "major" ? 0.82
    : ["ir", "pup", "nfi", "out"].includes(status) ? 0.78
      : status === "doubtful" ? 0.68
        : status === "questionable" ? 0.48
          : (news.healthRows.length ? 0.32 : 0.18);
  const returnProbability = clamp(prior.returnProbability + news.availabilityDelta * 0.35, 0.05, 0.995);
  const firstRetention = clamp(prior.firstGameRetention + news.performanceDelta, 0.45, 1.05);
  const fourRetention = clamp(prior.fourGameRetention + news.performanceDelta * 0.5, 0.55, 1.08);
  const rampWeeks = Math.max(1, Math.round(finite(prior.rampWeeks, 3)));
  return Array.from({ length: 18 }, (_, index) => {
    const week = index + 1;
    let availability = 0.99;
    let retention = 1;
    if (severity !== "none" || status !== "active") {
      if (week < window.earliestWeek) {
        availability = 0.01;
        retention = firstRetention;
      } else if (week < window.likelyWeek) {
        const width = Math.max(1, window.likelyWeek - window.earliestWeek);
        const progress = (week - window.earliestWeek + 1) / (width + 1);
        availability = 0.08 + returnProbability * progress * 0.62;
        retention = firstRetention;
      } else {
        const gamesBack = week - window.likelyWeek;
        availability = clamp(returnProbability + gamesBack * 0.045, 0.05, 0.995);
        const ramp = clamp(gamesBack / rampWeeks, 0, 1);
        retention = firstRetention + (fourRetention - firstRetention) * ramp;
        if (gamesBack > rampWeeks) {
          const longTerm = clamp(Math.max(fourRetention, 0.82 + prior.sameLevelRate * 0.16), 0.7, 1.02);
          retention += (longTerm - retention) * clamp((gamesBack - rampWeeks) / 6, 0, 1);
        }
      }
      if (week === seasonContext.currentWeek && !seasonContext.preseason) {
        availability = clamp(baseAvailability + news.availabilityDelta, 0.005, 0.995);
        if (practice === "full") availability = Math.max(availability, 0.78);
      }
    }
    const expected = clamp(availability * retention + news.roleDelta, 0, 1.06);
    const factor = clamp(1 + (expected - 1) * blend, 0, 1.04);
    return {
      week,
      availability: round(availability, 4),
      performanceRetention: round(retention, 4),
      expectedFactor: round(expected, 4),
      projectionFactor: round(factor, 4),
    };
  });
}
function healthDrivers(context) {
  const rows = [];
  const add = (label, direction, impact, reported = false) => rows.push({ label, direction, impact: round(impact, 4), reported });
  if (context.status !== "active") add(`${context.status} designation`, "negative", -0.12, true);
  if (context.practice !== "none") add(`${context.practice} practice`, context.practice === "full" ? "positive" : "negative", context.practice === "full" ? 0.08 : -0.08, true);
  if (context.family !== "unknown") add(`${context.family} recovery prior`, "negative", -(1 - context.performanceRetention), false);
  if (context.news.availabilityDelta) add("recent news signal", context.news.availabilityDelta > 0 ? "positive" : "negative", context.news.availabilityDelta, true);
  add("return-to-prior-level probability", context.returnToPriorLevelProbability >= 0.7 ? "positive" : "negative", context.returnToPriorLevelProbability - 0.7, false);
  add("recurrence risk", "negative", -context.recurrenceRisk, false);
  return rows.sort((left, right) => Math.abs(right.impact) - Math.abs(left.impact)).slice(0, 6);
}
function buildPlayerHealthContext(player, schedule, now = Date.now(), calibration = loadHealthCalibration()) {
  const source = player.healthSource || {};
  const news = newsSignals(player, now);
  const status = canonicalStatus(source.injuryStatus || player.injuryStatus);
  const practice = practiceStatus(source.practiceParticipation);
  const family = detailedFamily(source);
  const severity = severityFor(source, status, family, news);
  const seasonContext = seasonWeekContext(schedule, now);
  const availability = availabilityLookup(calibration, player.position, status, practice);
  const prior = recoveryPrior(calibration, player.position, family, severity);
  const window = returnWindow(status, severity, prior, seasonContext, source, news);
  const age = finite(player.opportunityContext?.age, 0);
  const agePenalty = age > 29 ? Math.min(0.16, (age - 29) * 0.018) : 0;
  const earlySameLevel = clamp(finite(prior.sameLevelRate, 0.46), 0.12, 0.88);
  let sameLevel = severity === "none" ? 0.98
    : severity === "minor" ? 0.85 + earlySameLevel * 0.1
      : severity === "moderate" ? 0.72 + earlySameLevel * 0.15
        : finite(prior.longTermSameLevelRate, 0.62 + earlySameLevel * 0.2);
  sameLevel = clamp(sameLevel - agePenalty + news.performanceDelta * 0.5, 0.2, 0.99);
  let recurrenceRisk = finite(prior.recurrenceRate, 0.2) * 0.65;
  if (severity === "none") recurrenceRisk *= 0.25;
  else if (severity === "minor") recurrenceRisk *= 0.85;
  recurrenceRisk = clamp(recurrenceRisk + (/recurr|chronic/.test(normalizedText(source.injuryNotes)) ? 0.1 : 0), 0.02, 0.55);
  const curve = weeklyHealthCurve({
    status,
    severity,
    prior,
    seasonContext,
    window,
    baseAvailability: availability.probability,
    news,
    practice,
  });
  const width = window.latestWeek - window.earliestWeek;
  const conflictingNews = news.rows.some((row) => row.availabilityDelta > 0) && news.rows.some((row) => row.availabilityDelta < 0);
  const uncertainty = clamp(
    width / 18 + (severity === "major" && !source.injuryStartDate ? 0.16 : 0) +
      (practice === "none" && severity !== "none" ? 0.08 : 0) +
      (conflictingNews ? 0.1 : 0) + (1 - window.confidence) * 0.2,
    0.04,
    0.72,
  );
  const currentCurve = curve[Math.max(0, seasonContext.currentWeek - 1)] || curve[0];
  const context = {
    version: HEALTH_MODEL_VERSION,
    status,
    practice,
    family,
    severity,
    currentWeek: seasonContext.currentWeek,
    preseason: seasonContext.preseason,
    currentAvailability: currentCurve.availability,
    performanceRetention: currentCurve.performanceRetention,
    returnWindow: window,
    returnToPlayProbability: round(finite(prior.returnProbability, 0.96), 4),
    earlyReturnToPriorLevelProbability: round(earlySameLevel, 4),
    returnToPriorLevelProbability: round(sameLevel, 4),
    recurrenceRisk: round(recurrenceRisk, 4),
    uncertainty: round(uncertainty, 4),
    confidence: round(1 - uncertainty, 4),
    calibration: {
      availabilitySamples: availability.samples,
      availabilitySource: availability.source,
      recoverySamples: finite(prior.samples, 0),
      recoverySource: prior.source,
      firstGameRetention: round(finite(prior.firstGameRetention, 0.82), 4),
      fourGameRetention: round(finite(prior.fourGameRetention, 0.95), 4),
    },
    reportedFacts: {
      injuryStatus: String(source.injuryStatus || player.injuryStatus || "ACTIVE"),
      injuryBodyPart: String(source.injuryBodyPart || ""),
      injuryNotes: String(source.injuryNotes || ""),
      injuryStartDate: source.injuryStartDate || null,
      practiceParticipation: String(source.practiceParticipation || ""),
      practiceDescription: String(source.practiceDescription || ""),
      latestNewsAt: news.latestPublished || (source.newsUpdated ? new Date(source.newsUpdated).toISOString() : null),
    },
    news: {
      availabilityDelta: round(news.availabilityDelta, 4),
      performanceDelta: round(news.performanceDelta, 4),
      roleDelta: round(news.roleDelta, 4),
      drivers: news.drivers,
      articles: news.rows.slice(0, 5).map((row) => ({
        ...row.article,
        daysOld: row.daysOld,
        healthRelevant: row.healthRelevant,
        roleRelevant: row.roleRelevant,
        signals: row.drivers,
      })),
    },
    weekly: curve,
  };
  context.drivers = healthDrivers(context);
  return context;
}
function applyHealthToPlayer(player, schedule, now, calibration) {
  const context = buildPlayerHealthContext(player, schedule, now, calibration);
  const sourceWeekly = Array.from({ length: 18 }, (_, index) => Math.max(0, finite(player.weeklyProjections?.[index], 0)));
  const weeklyProjections = sourceWeekly.map((value, index) => round(value * context.weekly[index].projectionFactor, 2));
  const factors = context.weekly
    .filter((row, index) => sourceWeekly[index] > 0)
    .map((row) => row.projectionFactor);
  const meanFactor = factors.length ? mean(factors) : 1;
  const uncertainty = context.uncertainty;
  const recurrence = context.recurrenceRisk;
  const floorFactor = clamp(meanFactor * (1 - uncertainty * 0.22), 0.35, 1.02);
  const ceilingFactor = clamp(meanFactor + (1 - meanFactor) * 0.35 + context.news.roleDelta * 0.4, 0.55, 1.04);
  const volatilityFactor = clamp(1 + uncertainty * 0.35 + recurrence * 0.16 - (context.practice === "full" ? 0.06 : 0), 0.92, 1.48);
  const reliabilityDelta = clamp(-uncertainty * 0.18 - recurrence * 0.06 + (context.practice === "full" ? 0.05 : 0), -0.22, 0.06);
  const injuryRisk = clamp(Math.max(
    finite(player.injuryRisk, 0.08),
    recurrence + (context.severity === "major" ? 0.18 : context.severity === "moderate" ? 0.08 : 0),
  ), 0.02, 0.95);
  const activeWeeks = weeklyProjections.filter((value) => value > 0);
  const weeklyProjection = activeWeeks.length ? mean(activeWeeks) : 0;
  return {
    ...player,
    weeklyProjections,
    weeklyProjection: round(weeklyProjection, 2),
    projectedPoints: round(weeklyProjections.reduce((sum, value) => sum + value, 0), 2),
    floorProjection: round(Math.max(0, finite(player.floorProjection, weeklyProjection * 0.6) * floorFactor), 2),
    ceilingProjection: round(Math.max(weeklyProjection, finite(player.ceilingProjection, weeklyProjection * 1.5) * ceilingFactor), 2),
    projectionStdDev: round(Math.max(0.2, finite(player.projectionStdDev, weeklyProjection * 0.45) * volatilityFactor), 2),
    reliability: round(clamp(finite(player.reliability, 0.68) + reliabilityDelta, 0.15, 0.98), 3),
    injuryRisk: round(injuryRisk, 4),
    projectionModel: {
      ...(player.projectionModel || {}),
      healthVersion: HEALTH_MODEL_VERSION,
      components: [...new Set([...(player.projectionModel?.components || []), "live-injury-status", "practice-participation", "news-signals", "return-to-performance"])],
    },
    healthContext: {
      ...context,
      meanFactor: round(meanFactor, 4),
      floorFactor: round(floorFactor, 4),
      ceilingFactor: round(ceilingFactor, 4),
      volatilityFactor: round(volatilityFactor, 4),
      reliabilityDelta: round(reliabilityDelta, 4),
    },
  };
}

function applyHealthIntelligence(players, schedule = {}, now = Date.now()) {
  const calibration = loadHealthCalibration();
  const modeled = players.map((player) => applyHealthToPlayer(player, schedule, now, calibration));
  const contexts = modeled.map((player) => player.healthContext);
  const affected = contexts.filter((context) => context.severity !== "none" || context.news.articles.length);
  return {
    players: modeled,
    summary: {
      version: HEALTH_MODEL_VERSION,
      calibrationVersion: calibration.meta?.version || null,
      generatedAt: new Date(now).toISOString(),
      coverage: contexts.length,
      affectedPlayers: affected.length,
      injuredPlayers: contexts.filter((context) => context.severity !== "none").length,
      newsPlayers: contexts.filter((context) => context.news.articles.length).length,
      majorRecoveries: contexts.filter((context) => context.severity === "major").length,
      averageAvailability: round(mean(contexts.map((context) => context.currentAvailability)), 4),
      averageReturnToPriorLevel: round(mean(affected.map((context) => context.returnToPriorLevelProbability)), 4),
      dataSources: ["ESPN Fantasy", "ESPN News", "Sleeper players", "nflverse injuries and weekly outcomes"],
      limitations: [
        "News effects are rule-based and only explicit language changes projections.",
        "Exact diagnosis, surgery date, and rehabilitation testing are often unavailable.",
        "Return-to-level values are fantasy-performance priors, not medical prognoses.",
      ],
    },
  };
}

function healthSummary() {
  const calibration = loadHealthCalibration();
  return {
    version: HEALTH_MODEL_VERSION,
    calibrationVersion: calibration.meta?.version || null,
    historicalInjuryReports: calibration.meta?.injuryReports || 0,
    historicalRecoveryEpisodes: calibration.meta?.recoveryEpisodes || 0,
    seasons: calibration.meta?.seasons || [],
    globalRecovery: calibration.recovery?.global || null,
    sources: calibration.meta?.sources || [],
    limitations: calibration.meta?.limitations || [],
  };
}

module.exports = {
  HEALTH_MODEL_VERSION,
  applyHealthIntelligence,
  applyHealthToPlayer,
  buildPlayerHealthContext,
  classifyNewsArticle,
  healthSummary,
  loadHealthCalibration,
  newsSignals,
};
