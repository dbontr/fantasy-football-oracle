# Health, News, and Recovery Intelligence Plan

## Goal
Add current news and injury intelligence that estimates weekly availability, expected snap ramp, recurrence risk, and probability of returning near the player’s prior level.

## Data flow
1. Enrich current players from Sleeper injury/practice fields and ESPN news metadata.
2. Build a versioned medical prior library by injury family, position, severity, and time since injury.
3. Convert status/news/practice chronology into availability, return-week, ramp, recurrence, and performance-retention distributions.
4. Feed those distributions into projections, contextual uncertainty, native draft/lineup/waiver/trade/season decisions, APIs, and the Team Manager.

## Guardrails
- Never infer a precise diagnosis from vague news text.
- Distinguish reported facts from modeled priors.
- Shrink missing or ambiguous cases toward neutral.
- Cap mean changes; place more weight on availability, floor, ceiling, volatility, and confidence.
- Preserve stale-data timestamps and provenance.
- Treat medical estimates as fantasy decision aids, not medical advice.

## Verification
- Unit tests for status parsing, practice progression, recovery curves, recurrence, and bounded effects.
- API tests for health/news status and player evidence.
- Full native/server verification and browser desktop/mobile validation.
- Confirm raw feeds are cached outside committed deployment artifacts.

## Result

Implemented in version 3.5.0 with live ESPN/Sleeper enrichment, nflverse calibration, weekly availability and performance ramps, major-injury long-term priors, conservative news attribution, APIs, Team Manager telemetry, and native decision propagation.
