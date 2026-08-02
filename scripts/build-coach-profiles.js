"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "data", "coaches-2026.json");
const clamp = (value) => Math.min(1, Math.max(0, Number(value)));
const round = (value, digits = 3) => Number(clamp(value).toFixed(digits));

const archetypes = {
  shanahan: {
    label: "Wide-zone play action",
    tendencies: { pace: .55, passRate: .55, targetConcentration: .59, rbCommittee: .61, teUsage: .64, qbRun: .43, playAction: .78, motion: .84, redZone: .67, aggression: .62 },
    development: { QB: .72, RB: .74, WR: .68, TE: .73 },
  },
  mcvay: {
    label: "Motion-heavy condensed spread",
    tendencies: { pace: .57, passRate: .59, targetConcentration: .70, rbCommittee: .55, teUsage: .54, qbRun: .34, playAction: .79, motion: .86, redZone: .70, aggression: .66 },
    development: { QB: .78, RB: .70, WR: .80, TE: .64 },
  },
  reid: {
    label: "West Coast spread",
    tendencies: { pace: .59, passRate: .64, targetConcentration: .72, rbCommittee: .65, teUsage: .84, qbRun: .46, playAction: .68, motion: .80, redZone: .80, aggression: .76 },
    development: { QB: .84, RB: .60, WR: .70, TE: .86 },
  },  balanced: {
    label: "Balanced play-action",
    tendencies: { pace: .53, passRate: .55, targetConcentration: .59, rbCommittee: .56, teUsage: .63, qbRun: .45, playAction: .70, motion: .62, redZone: .68, aggression: .61 },
    development: { QB: .68, RB: .68, WR: .67, TE: .69 },
  },
  power: {
    label: "Power-run vertical",
    tendencies: { pace: .49, passRate: .48, targetConcentration: .56, rbCommittee: .51, teUsage: .69, qbRun: .49, playAction: .73, motion: .49, redZone: .72, aggression: .55 },
    development: { QB: .62, RB: .75, WR: .61, TE: .72 },
  },
  spread: {
    label: "Shotgun spread",
    tendencies: { pace: .62, passRate: .63, targetConcentration: .64, rbCommittee: .60, teUsage: .55, qbRun: .59, playAction: .56, motion: .62, redZone: .68, aggression: .69 },
    development: { QB: .75, RB: .60, WR: .73, TE: .59 },
  },
  vertical: {
    label: "Vertical play-action",
    tendencies: { pace: .57, passRate: .60, targetConcentration: .67, rbCommittee: .56, teUsage: .55, qbRun: .48, playAction: .70, motion: .57, redZone: .70, aggression: .67 },
    development: { QB: .73, RB: .63, WR: .75, TE: .61 },
  },
  conservative: {
    label: "Conservative balanced",
    tendencies: { pace: .47, passRate: .50, targetConcentration: .54, rbCommittee: .64, teUsage: .60, qbRun: .44, playAction: .63, motion: .46, redZone: .58, aggression: .43 },
    development: { QB: .58, RB: .66, WR: .58, TE: .63 },
  },
};

const rows = [  ["ARI", "Mike LaFleur", "Nathaniel Hackett", "Nick Rallis", "Mike LaFleur", "shanahan", .56, .69, .63, .57, .12, .58, 3, .55, .61, .60, .62, .58],
  ["ATL", "Kevin Stefanski", "Tommy Rees", "Jeff Ulbrich", "Tommy Rees", "balanced", .72, .73, .69, .70, .12, .66, 7, .69, .69, .68, .68, .66],
  ["BAL", "Jesse Minter", "Declan Doyle", "Anthony Weaver", "Declan Doyle", "power", .65, .64, .67, .63, .12, .67, 2, .52, .78, .74, .72, .70],
  ["BUF", "Joe Brady", "Pete Carmichael", "Jim Leonhard", "Joe Brady", "spread", .65, .78, .76, .74, .55, .67, 5, .70, .78, .76, .76, .71],
  ["CAR", "Dave Canales", "Brad Idzik", "Ejiro Evero", "Dave Canales", "balanced", .61, .61, .63, .65, .70, .65, 3, .62, .76, .72, .74, .70],
  ["CHI", "Ben Johnson", "Press Taylor", "Dennis Allen", "Ben Johnson", "balanced", .72, .88, .84, .80, .72, .70, 4, .80, .82, .78, .78, .74],
  ["CIN", "Zac Taylor", "Dan Pitcher", "Al Golden", "Zac Taylor", "spread", .67, .74, .68, .72, .78, .62, 7, .75, .64, .65, .67, .64],
  ["CLE", "Todd Monken", "Travis Switzer", "Mike Rutenberg", "Todd Monken", "power", .69, .79, .76, .70, .12, .66, 6, .71, .66, .67, .69, .63],
  ["DAL", "Brian Schottenheimer", "Klayton Adams", "Christian Parker", "Brian Schottenheimer", "balanced", .61, .62, .60, .64, .68, .64, 4, .62, .62, .65, .64, .65],
  ["DEN", "Sean Payton", "Davis Webb", "Vance Joseph", "Sean Payton", "balanced", .82, .84, .80, .82, .83, .74, 12, .88, .85, .80, .84, .79],
  ["DET", "Dan Campbell", "Drew Petzing", "Kelvin Sheppard", "Drew Petzing", "power", .86, .72, .76, .82, .55, .76, 7, .78, .71, .76, .77, .72],
  ["GB", "Matt LaFleur", "Adam Stenavich", "Jonathan Gannon", "Matt LaFleur", "shanahan", .78, .84, .80, .78, .84, .69, 7, .85, .75, .72, .76, .70],
  ["HOU", "DeMeco Ryans", "Nick Caley", "Matt Burke", "Nick Caley", "mcvay", .80, .65, .68, .70, .74, .73, 4, .70, .80, .79, .76, .77],
  ["IND", "Shane Steichen", "Jim Bob Cooter", "Lou Anarumo", "Shane Steichen", "spread", .72, .76, .77, .72, .80, .66, 6, .78, .79, .75, .80, .75],
  ["JAX", "Liam Coen", "Grant Udinski", "Anthony Campanile", "Liam Coen", "mcvay", .70, .80, .76, .74, .67, .67, 4, .76, .70, .72, .73, .68],
  ["KC", "Andy Reid", "Eric Bieniemy", "Steve Spagnuolo", "Andy Reid", "reid", .94, .93, .92, .90, .92, .80, 20, .95, .92, .84, .92, .88],  ["LAC", "Jim Harbaugh", "Mike McDaniel", "Chris O'Leary", "Mike McDaniel", "shanahan", .90, .88, .84, .82, .45, .82, 10, .86, .73, .72, .74, .70],
  ["LAR", "Sean McVay", "Nate Scheelhaase", "Chris Shula", "Sean McVay", "mcvay", .89, .94, .91, .88, .82, .75, 9, .94, .76, .74, .73, .75],
  ["LV", "Klint Kubiak", "Andrew Janocko", "Rob Leonard", "Klint Kubiak", "shanahan", .62, .74, .68, .67, .10, .63, 4, .65, .66, .67, .68, .61],
  ["MIA", "Jeff Hafley", "Bobby Slowik", "Sean Duggan", "Bobby Slowik", "shanahan", .65, .69, .66, .62, .12, .64, 4, .61, .72, .70, .71, .65],
  ["MIN", "Kevin O'Connell", "Wes Phillips", "Brian Flores", "Kevin O'Connell", "mcvay", .84, .89, .88, .84, .86, .76, 7, .90, .90, .82, .92, .80],
  ["NE", "Mike Vrabel", "Josh McDaniels", "Zak Kuhr", "Josh McDaniels", "balanced", .88, .79, .76, .80, .67, .82, 10, .84, .75, .77, .76, .78],
  ["NO", "Kellen Moore", "Doug Nussmeier", "Brandon Staley", "Kellen Moore", "spread", .67, .77, .74, .70, .72, .65, 6, .75, .77, .72, .79, .70],
  ["NYG", "John Harbaugh", "Matt Nagy", "Dennard Wilson", "Matt Nagy", "reid", .90, .72, .70, .82, .10, .84, 12, .82, .73, .74, .77, .68],
  ["NYJ", "Aaron Glenn", "Frank Reich", "Brian Duker", "Frank Reich", "balanced", .60, .67, .66, .62, .30, .62, 7, .62, .68, .70, .72, .60],
  ["PHI", "Nick Sirianni", "Sean Mannion", "Vic Fangio", "Sean Mannion", "spread", .79, .64, .69, .75, .52, .73, 5, .68, .88, .80, .84, .84],
  ["PIT", "Mike McCarthy", "Brian Angelichio", "Patrick Graham", "Mike McCarthy", "reid", .79, .77, .72, .78, .10, .72, 15, .82, .76, .73, .78, .70],
  ["SEA", "Mike Macdonald", "Brian Fleury", "Aden Durde", "Brian Fleury", "shanahan", .81, .68, .72, .71, .55, .77, 4, .70, .84, .81, .85, .76],
  ["SF", "Kyle Shanahan", "Klay Kubiak", "Raheem Morris", "Kyle Shanahan", "shanahan", .82, .95, .91, .84, .88, .68, 9, .94, .79, .75, .78, .76],
  ["TB", "Todd Bowles", "Zac Robinson", null, "Zac Robinson", "mcvay", .73, .73, .71, .68, .55, .67, 6, .72, .80, .74, .82, .75],
  ["TEN", "Robert Saleh", "Brian Daboll", "Gus Bradley", "Brian Daboll", "vertical", .73, .77, .75, .70, .10, .68, 8, .75, .73, .70, .72, .71],
  ["WSH", "Dan Quinn", "David Blough", "Daronte Jones", "David Blough", "spread", .82, .60, .65, .69, .50, .74, 5, .64, .72, .71, .75, .68],
];

const teamNames = {  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills",
  CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers",
  HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs",
  LAC: "Los Angeles Chargers", LAR: "Los Angeles Rams", LV: "Las Vegas Raiders", MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WSH: "Washington Commanders",
};

function profile(row) {
  const [team, headCoach, offensiveCoordinator, defensiveCoordinator, playCaller, archetypeKey,
    leadership, offensiveDesign, adaptability, roleClarity, continuity, workloadManagement,
    evidenceSeasons, confidence, defensiveDesign, defensiveDevelopment,
    defensiveAggression, defensiveStability] = row;
  const archetype = archetypes[archetypeKey];
  const development = Object.fromEntries(Object.entries(archetype.development).map(([position, base]) => [
    position,
    round(base * .42 + offensiveDesign * .38 + adaptability * .12 + leadership * .08),
  ]));
  development.DST = round(defensiveDevelopment * .58 + defensiveDesign * .27 + leadership * .15);
  development.K = round(.48 + roleClarity * .22 + leadership * .18 + continuity * .12);

  return {
    team, teamName: teamNames[team], headCoach, offensiveCoordinator, defensiveCoordinator,
    offensivePlayCaller: playCaller, archetype: archetypeKey, schemeLabel: archetype.label,
    newStaff: continuity < .25, evidenceSeasons, confidence,
    leadership: { leadership, adaptability, roleClarity, continuity, workloadManagement },
    offense: { design: offensiveDesign, ...archetype.tendencies },
    defense: { design: defensiveDesign, development: defensiveDevelopment, aggression: defensiveAggression, stability: defensiveStability },
    development,
  };
}const teams = Object.fromEntries(rows.map((row) => [row[0], profile(row)]));
const payload = {
  meta: {
    version: "oracle-coaching-2026.1",
    season: 2026,
    verifiedAt: "2026-07-31",
    coverage: Object.keys(teams).length,
    methodology: "Bayesian-shrunk staff priors for leadership, scheme, usage, development, continuity, and uncertainty",
    staffSource: "NFL.com 2026 coaching tracker and current team staff directories",
    scoreNotice: "Scores are Oracle modeling priors, not objective facts or personnel evaluations.",
  },
  teams,
};

fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${Object.keys(teams).length} coaching profiles to ${output}`);

module.exports = { archetypes, profile, rows };
