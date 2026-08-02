"use strict";

const TEAM_VENUES_VERSION = "oracle-team-venues-2026.1";

function venue(name, latitude, longitude, indoor = false) {
  return Object.freeze({ name, latitude, longitude, indoor });
}

const TEAM_VENUES = Object.freeze({
  ARI: venue("State Farm Stadium", 33.5276, -112.2626, true),
  ATL: venue("Mercedes-Benz Stadium", 33.7554, -84.4008, true),
  BAL: venue("M&T Bank Stadium", 39.2780, -76.6227),
  BUF: venue("Highmark Stadium", 42.7738, -78.7870),
  CAR: venue("Bank of America Stadium", 35.2258, -80.8528),
  CHI: venue("Soldier Field", 41.8623, -87.6167),
  CIN: venue("Paycor Stadium", 39.0954, -84.5160),
  CLE: venue("Huntington Bank Field", 41.5061, -81.6995),
  DAL: venue("AT&T Stadium", 32.7473, -97.0945, true),
  DEN: venue("Empower Field at Mile High", 39.7439, -105.0201),
  DET: venue("Ford Field", 42.3400, -83.0456, true),
  GB: venue("Lambeau Field", 44.5013, -88.0622),
  HOU: venue("NRG Stadium", 29.6847, -95.4107, true),
  IND: venue("Lucas Oil Stadium", 39.7601, -86.1639, true),
  JAX: venue("EverBank Stadium", 30.3239, -81.6373),
  KC: venue("GEHA Field at Arrowhead Stadium", 39.0489, -94.4839),
  LV: venue("Allegiant Stadium", 36.0908, -115.1837, true),
  LAC: venue("SoFi Stadium", 33.9535, -118.3392, true),
  LAR: venue("SoFi Stadium", 33.9535, -118.3392, true),
  MIA: venue("Hard Rock Stadium", 25.9580, -80.2389),
  MIN: venue("U.S. Bank Stadium", 44.9736, -93.2575, true),
  NE: venue("Gillette Stadium", 42.0909, -71.2643),
  NO: venue("Caesars Superdome", 29.9509, -90.0813, true),
  NYG: venue("MetLife Stadium", 40.8135, -74.0745),
  NYJ: venue("MetLife Stadium", 40.8135, -74.0745),
  PHI: venue("Lincoln Financial Field", 39.9008, -75.1675),
  PIT: venue("Acrisure Stadium", 40.4468, -80.0158),
  SEA: venue("Lumen Field", 47.5952, -122.3316),
  SF: venue("Levi's Stadium", 37.4030, -121.9700),
  TB: venue("Raymond James Stadium", 27.9759, -82.5033),
  TEN: venue("Nissan Stadium", 36.1665, -86.7713),
  WSH: venue("Northwest Stadium", 38.9078, -76.8645),
});

module.exports = {
  TEAM_VENUES,
  TEAM_VENUES_VERSION,
};
