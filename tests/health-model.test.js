const assert = require("node:assert/strict");
const test = require("node:test");

const calibration = require("../data/health-calibration-2026.json");
const {
  applyHealthIntelligence,
  buildPlayerHealthContext,
  classifyNewsArticle,
} = require("../server/health-model.js");

function schedule(firstKickoff = "2026-09-10T00:00:00Z") {
  const start = Date.parse(firstKickoff);
  return {
    KC: {
      weeks: Array.from({ length: 18 }, (_, index) => ({
        opponent: "DEN",
        date: start + index * 7 * 86_400_000,
        home: index % 2 === 0,
      })),
    },
  };
}

function player(overrides = {}) {
  return {
    id: "1",
    name: "Test Player",
    position: "WR",
    team: "KC",
    weeklyProjection: 15,
    weeklyProjections: Array(18).fill(15),
    projectedPoints: 255,
    floorProjection: 8,
    ceilingProjection: 23,
    projectionStdDev: 6,
    reliability: 0.82,
    injuryRisk: 0.08,
    injuryStatus: "ACTIVE",
    opportunityContext: { age: 26, volumeStability: 0.74 },
    healthSource: {
      injuryStatus: "",
      injuryBodyPart: "",
      injuryNotes: "",
      injuryStartDate: null,
      practiceParticipation: "",
      practiceDescription: "",
      newsUpdated: 0,
    },
    news: [],
    ...overrides,
  };
}

test("historical health calibration has meaningful availability and recovery coverage", () => {
  assert.ok(calibration.meta.injuryReports > 10_000);
  assert.ok(calibration.meta.recoveryEpisodes > 1_000);
  assert.ok(calibration.availability.groups["status:out"].rate < 0.02);
  assert.ok(calibration.availability.groups["practice:full"].rate > calibration.availability.groups["practice:dnp"].rate);
  assert.ok(calibration.recovery.global.firstGameRetention < calibration.recovery.global.fourGameRetention);
});
test("multi-athlete news is displayed but does not change projections without attribution", () => {
  const generic = classifyNewsArticle({
    headline: "Training camp updates and potential breakouts",
    description: "Several players earned first-team work.",
    published: "2026-08-01T12:00:00Z",
    focused: false,
  }, Date.parse("2026-08-01T18:00:00Z"));
  assert.equal(generic.attributable, false);
  assert.equal(generic.roleRelevant, false);
  assert.equal(generic.roleDelta, 0);

  const focused = classifyNewsArticle({
    headline: "Test Player suffers setback in recovery",
    description: "The player has no timetable to return.",
    published: "2026-08-01T12:00:00Z",
    focused: true,
  }, Date.parse("2026-08-01T18:00:00Z"));
  assert.equal(focused.healthRelevant, true);
  assert.ok(focused.availabilityDelta < -0.2);
});

test("preseason PUP produces a probabilistic Week 1 outlook rather than an automatic absence", () => {
  const context = buildPlayerHealthContext(player({
    healthSource: {
      injuryStatus: "PUP",
      injuryBodyPart: "Achilles",
      injuryNotes: "Surgery",
      practiceParticipation: "",
    },
  }), schedule(), Date.parse("2026-08-01T18:00:00Z"));
  assert.equal(context.preseason, true);
  assert.equal(context.severity, "major");
  assert.ok(context.currentAvailability > 0.05 && context.currentAvailability < 0.8);
  assert.ok(context.returnWindow.likelyWeek <= 5);
  assert.ok(context.weekly[4].projectionFactor > context.weekly[0].projectionFactor);
  assert.ok(context.returnToPriorLevelProbability < 0.7);
});
test("practice progression changes current-week availability", () => {
  const now = Date.parse("2026-09-12T18:00:00Z");
  const base = {
    injuryStatus: "Questionable",
    injuryBodyPart: "Hamstring",
    injuryNotes: "",
  };
  const dnp = buildPlayerHealthContext(player({
    healthSource: { ...base, practiceParticipation: "Did Not Participate" },
  }), schedule(), now);
  const limited = buildPlayerHealthContext(player({
    healthSource: { ...base, practiceParticipation: "Limited Participation" },
  }), schedule(), now);
  const full = buildPlayerHealthContext(player({
    healthSource: { ...base, practiceParticipation: "Full Participation" },
  }), schedule(), now);
  assert.ok(dnp.currentAvailability < limited.currentAvailability);
  assert.ok(limited.currentAvailability < full.currentAvailability);
  assert.ok(full.confidence >= limited.confidence);
});

test("major injury context separates early performance from long-term return potential", () => {
  const acl = buildPlayerHealthContext(player({
    position: "RB",
    opportunityContext: { age: 24, volumeStability: 0.8 },
    healthSource: {
      injuryStatus: "Questionable",
      injuryBodyPart: "Knee - ACL",
      injuryNotes: "Surgery",
      practiceParticipation: "",
    },
  }), schedule(), Date.parse("2026-08-01T18:00:00Z"));
  assert.equal(acl.family, "acl");
  assert.equal(acl.severity, "major");
  assert.ok(acl.earlyReturnToPriorLevelProbability < acl.returnToPriorLevelProbability);
  assert.ok(acl.returnToPriorLevelProbability > 0.5 && acl.returnToPriorLevelProbability < 0.9);
  assert.ok(acl.uncertainty > 0.25);
});
test("health adjustments are bounded and propagate through all 18 weeks", () => {
  const healthy = player({ id: "healthy", name: "Healthy Player" });
  const injured = player({
    id: "injured",
    name: "Injured Player",
    healthSource: {
      injuryStatus: "PUP",
      injuryBodyPart: "Achilles",
      injuryNotes: "Surgery",
      practiceParticipation: "",
    },
  });
  const result = applyHealthIntelligence(
    [healthy, injured],
    schedule(),
    Date.parse("2026-08-01T18:00:00Z"),
  );
  assert.equal(result.players.length, 2);
  assert.equal(result.players[1].weeklyProjections.length, 18);
  assert.ok(result.players[1].projectedPoints < injured.projectedPoints);
  assert.ok(result.players[1].healthContext.meanFactor >= 0 && result.players[1].healthContext.meanFactor <= 1.04);
  assert.ok(result.players[0].healthContext.meanFactor > 0.97);
  assert.ok(result.players[1].projectionModel.components.includes("return-to-performance"));
  assert.equal(result.summary.majorRecoveries, 1);
});
