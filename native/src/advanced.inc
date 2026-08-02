namespace {

double normal_cdf(double value) {
  return 0.5 * (1.0 + std::erf(value / std::sqrt(2.0)));
}

double normal_pdf(double value) {
  constexpr double inverse_sqrt_two_pi = 0.3989422804014327;
  return inverse_sqrt_two_pi * std::exp(-0.5 * value * value);
}

double expected_positive_normal(double mean, double sigma) {
  if (sigma <= 0.0001) return std::max(0.0, mean);
  const double standardized = mean / sigma;
  return sigma * normal_pdf(standardized) + mean * normal_cdf(standardized);
}

double decision_correlation(const Player& left, const Player& right) {
  if (left.team.empty() || left.team != right.team) return 0;
  const bool quarterback_stack =
      (left.position == "QB" && (right.position == "WR" || right.position == "TE")) ||
      (right.position == "QB" && (left.position == "WR" || left.position == "TE"));
  if (quarterback_stack) return 0.22;
  if (left.position == right.position &&
      (left.position == "RB" || left.position == "WR" || left.position == "TE")) return -0.08;
  return 0.08;
}

json start_sit_analysis(const json& payload) {
  const Settings settings = parse_settings(payload.value("settings", json::object()));
  const auto roster = parse_players(payload.value("roster", json::array()));  const int week = clamp_int(integer(payload, "week", 1), 1, 18);
  const double target = number(payload, "opponentTarget", 0);
  std::vector<double> balanced;
  std::vector<double> floor_metric;
  std::vector<double> ceiling_metric;
  std::vector<double> risk_adjusted;
  balanced.reserve(roster.size());
  floor_metric.reserve(roster.size());
  ceiling_metric.reserve(roster.size());
  risk_adjusted.reserve(roster.size());
  for (const auto& player : roster) {
    const double projection = week_projection(player, week);
    const auto [low, high] = week_range(player, week);
    const double ratio = player.weekly > 0 ? projection / player.weekly : 1;
    const double deviation = std::max(0.25, player.stddev * ratio);
    balanced.push_back(projection);
    floor_metric.push_back(low);
    ceiling_metric.push_back(high);
    risk_adjusted.push_back(projection - (1 - settings.risk_tolerance) * deviation * 0.55 -
                            player.injury_risk * projection * 0.18);
  }
  const Lineup balanced_lineup = optimize_lineup(roster, settings, std::nullopt, &balanced);
  const double target_delta = target > 0 ? clamp((target - balanced_lineup.total) / 24.0, -1, 1) : 0;
  std::vector<double> leverage;
  leverage.reserve(roster.size());
  for (std::size_t index = 0; index < roster.size(); ++index) {
    const double ratio = roster[index].weekly > 0 ? balanced[index] / roster[index].weekly : 1;
    const double deviation = std::max(0.25, roster[index].stddev * ratio);    leverage.push_back(balanced[index] + target_delta * deviation * 0.7 -
                       roster[index].injury_risk * balanced[index] * 0.12);
  }
  const Lineup floor_lineup = optimize_lineup(roster, settings, std::nullopt, &floor_metric);
  const Lineup ceiling_lineup = optimize_lineup(roster, settings, std::nullopt, &ceiling_metric);
  const Lineup risk_lineup = optimize_lineup(roster, settings, std::nullopt, &risk_adjusted);
  const Lineup leverage_lineup = optimize_lineup(roster, settings, std::nullopt, &leverage);
  std::unordered_set<int> balanced_starters;
  for (const auto& row : balanced_lineup.starters) {
    if (row.player_index >= 0) balanced_starters.insert(row.player_index);
  }
  json decisions = json::array();
  double total_expected_regret = 0;
  int fragile_decisions = 0;
  int filled_decisions = 0;
  json highest_regret = nullptr;
  for (const auto& row : balanced_lineup.starters) {
    json alternatives = json::array();
    if (row.player_index < 0) {
      decisions.push_back({{"slot", row.slot}, {"slotKey", row.slot_key}, {"starter", nullptr},
                           {"confidence", 0}, {"expectedRegret", 0}, {"fragility", 0},
                           {"alternatives", alternatives}});
      continue;
    }
    filled_decisions += 1;
    const Player& starter = roster[static_cast<std::size_t>(row.player_index)];
    struct Alternative {
      int index;
      double delta;      double probability;
      double regret;
      double swing;
      double correlation;
    };
    std::vector<Alternative> rows;
    const double starter_ratio = starter.weekly > 0 ? balanced[row.player_index] / starter.weekly : 1;
    const double starter_sigma = std::max(0.25, starter.stddev * starter_ratio);
    for (int index = 0; index < static_cast<int>(roster.size()); ++index) {
      if (balanced_starters.contains(index) ||
          !eligible(row.slot, roster[static_cast<std::size_t>(index)].position)) continue;
      const Player& candidate = roster[static_cast<std::size_t>(index)];
      const double candidate_ratio = candidate.weekly > 0 ? balanced[index] / candidate.weekly : 1;
      const double candidate_sigma = std::max(0.25, candidate.stddev * candidate_ratio);
      const double correlation = decision_correlation(starter, candidate);
      const double variance = starter_sigma * starter_sigma + candidate_sigma * candidate_sigma -
                              2 * correlation * starter_sigma * candidate_sigma;
      const double sigma = std::sqrt(std::max(0.01, variance));
      const double delta = balanced[index] - balanced[row.player_index];
      const double starter_probability = normal_cdf(-delta / sigma);
      rows.push_back({index, delta, starter_probability,
                      expected_positive_normal(delta, sigma),
                      sigma * 1.281551565545, correlation});
    }
    std::sort(rows.begin(), rows.end(), [](const auto& left, const auto& right) {
      if (left.regret != right.regret) return left.regret > right.regret;
      return left.delta > right.delta;
    });
    double confidence = 1;    for (std::size_t index = 0; index < std::min<std::size_t>(4, rows.size()); ++index) {
      const auto& alternative = rows[index];
      confidence = std::min(confidence, alternative.probability);
      alternatives.push_back({
          {"player", player_json(roster[static_cast<std::size_t>(alternative.index)], balanced[alternative.index])},
          {"projectionDelta", round_to(alternative.delta, 2)},
          {"starterOutscoresProbability", round_to(alternative.probability, 4)},
          {"alternativeOutscoresProbability", round_to(1 - alternative.probability, 4)},
          {"expectedRegret", round_to(alternative.regret, 3)},
          {"swing80", round_to(alternative.swing, 2)},
          {"correlation", round_to(alternative.correlation, 3)},
      });
    }
    const double slot_regret = rows.empty() ? 0 : rows.front().regret;
    const double slot_fragility = rows.empty() ? 0 : 1 - confidence;
    total_expected_regret += slot_regret;
    if (confidence < 0.67) fragile_decisions += 1;
    if (!rows.empty() && (highest_regret.is_null() ||
        slot_regret > highest_regret.value("expectedRegret", -1.0))) {
      highest_regret = {
          {"slot", row.slot},
          {"starter", player_json(starter, balanced[row.player_index])},
          {"alternative", player_json(roster[static_cast<std::size_t>(rows.front().index)], balanced[rows.front().index])},
          {"expectedRegret", round_to(slot_regret, 3)},
          {"alternativeOutscoresProbability", round_to(1 - rows.front().probability, 4)},
      };
    }
    decisions.push_back({        {"slot", row.slot},
        {"slotKey", row.slot_key},
        {"starter", player_json(starter, balanced[row.player_index])},
        {"confidence", round_to(confidence, 4)},
        {"expectedRegret", round_to(slot_regret, 3)},
        {"fragility", round_to(slot_fragility, 4)},
        {"alternatives", alternatives},
    });
  }
  return {
      {"week", week},
      {"opponentTarget", target > 0 ? json(target) : json(nullptr)},
      {"recommended", lineup_json(balanced_lineup, roster, std::nullopt, &balanced)},
      {"profiles", {
          {"balanced", lineup_json(balanced_lineup, roster, std::nullopt, &balanced)},
          {"floor", lineup_json(floor_lineup, roster, std::nullopt, &floor_metric)},
          {"ceiling", lineup_json(ceiling_lineup, roster, std::nullopt, &ceiling_metric)},
          {"riskAdjusted", lineup_json(risk_lineup, roster, std::nullopt, &risk_adjusted)},
          {"targetAware", lineup_json(leverage_lineup, roster, std::nullopt, &leverage)},
      }},
      {"decisions", decisions},
      {"regret", {
          {"totalExpectedRegret", round_to(total_expected_regret, 3)},
          {"averageExpectedRegret", round_to(total_expected_regret / std::max(1, filled_decisions), 3)},
          {"fragileDecisions", fragile_decisions},
          {"highestRegret", highest_regret},
          {"interpretation", "Expected points left on the bench when uncertainty makes the alternative win."},
      }},
      {"model", "native-start-sit-v2-regret"},
  };
}

struct LeagueTeam {
  std::string id;
  std::string name;
  std::vector<Player> roster;
  double wins = 0;
  double losses = 0;
  double ties = 0;
  double points_for = 0;
};

std::vector<LeagueTeam> parse_league_teams(const json& value) {
  std::vector<LeagueTeam> teams;
  if (!value.is_array()) return teams;
  for (std::size_t index = 0; index < value.size(); ++index) {
    const auto& row = value[index];
    LeagueTeam team;
    team.id = text(row, "teamId", std::to_string(index + 1));
    team.name = text(row, "name", "Team " + std::to_string(index + 1));
    team.roster = parse_players(row.value("roster", json::array()));
    const json standing = row.value("standing", json::object());
    team.wins = std::max(0.0, number(standing, "wins", number(row, "wins", 0)));
    team.losses = std::max(0.0, number(standing, "losses", number(row, "losses", 0)));
    team.ties = std::max(0.0, number(standing, "ties", number(row, "ties", 0)));
    team.points_for = std::max(0.0, number(standing, "pointsFor", number(row, "pointsFor", 0)));
    if (!team.roster.empty()) teams.push_back(std::move(team));
  }
  return teams;
}

std::vector<std::pair<int, int>> round_robin_pairs(int team_count, int week) {
  std::vector<int> rotation;
  for (int index = 0; index < team_count; ++index) rotation.push_back(index);
  if (rotation.size() % 2 == 1) rotation.push_back(-1);
  const int rounds = static_cast<int>(rotation.size()) - 1;
  for (int step = 0; step < (week - 1) % std::max(1, rounds); ++step) {
    const int last = rotation.back();
    rotation.pop_back();
    rotation.insert(rotation.begin() + 1, last);
  }
  std::vector<std::pair<int, int>> pairs;
  for (int index = 0; index < static_cast<int>(rotation.size()) / 2; ++index) {
    const int left = rotation[index];
    const int right = rotation[rotation.size() - 1 - index];
    if (left >= 0 && right >= 0) pairs.emplace_back(left, right);
  }
  return pairs;
}

int next_power_of_two(int value) {
  int result = 1;
  while (result < value) result <<= 1;
  return result;
}

json league_simulation(const json& payload) {
  const Settings settings = parse_settings(payload.value("settings", json::object()));
  const auto teams = parse_league_teams(payload.value("teams", json::array()));
  if (teams.size() < 2) throw std::runtime_error("League simulation requires at least two teams");
  const int regular_start = clamp_int(integer(payload, "startWeek", 1), 1, 18);
  const int regular_end = clamp_int(integer(payload, "regularSeasonEnd", 14), regular_start, 17);
  const int championship_week = clamp_int(integer(payload, "championshipWeek", 17), regular_end + 1, 18);
  const int playoff_teams = clamp_int(integer(payload, "playoffTeams", std::min<int>(6, teams.size())), 2,
                                      static_cast<int>(teams.size()));
  const int automatic_byes = next_power_of_two(playoff_teams) - playoff_teams;
  const int playoff_byes = clamp_int(integer(payload, "playoffByes", automatic_byes), 0, playoff_teams - 1);
  const bool median_game = payload.value("medianGame", false);
  const int simulations = clamp_int(integer(payload, "simulations", 20000), 100, 250000);
  const std::uint64_t seed = static_cast<std::uint64_t>(number(payload, "seed", 2026));
  const double team_correlation = clamp(number(payload, "teamCorrelation", 0.16), 0, 0.6);
  const double game_correlation = clamp(number(payload, "gameCorrelation", 0.08), 0, 0.4);
  std::mt19937_64 generator(seed ? seed : 1);
  std::normal_distribution<double> normal(0, 1);
  std::uniform_real_distribution<double> uniform(0, 1);
  const int team_count = static_cast<int>(teams.size());
  std::vector<std::vector<Lineup>> lineups(team_count);
  for (int team = 0; team < team_count; ++team) {
    for (int week = regular_start; week <= championship_week; ++week) {
      lineups[team].push_back(optimize_lineup(teams[team].roster, settings, week));
    }
  }
  std::unordered_map<std::string, int> team_by_id;
  for (int index = 0; index < team_count; ++index) team_by_id[teams[index].id] = index;
  std::unordered_map<int, std::vector<std::pair<int, int>>> schedule;
  if (payload.contains("schedule") && payload.at("schedule").is_array()) {
    for (const auto& row : payload.at("schedule")) {
      const int week = integer(row, "week", 0);
      const std::string home = text(row, "homeTeamId", "");
      const std::string away = text(row, "awayTeamId", "");
      const bool completed = row.value("completed", false);
      if (!completed && week >= regular_start && week <= regular_end && team_by_id.contains(home) && team_by_id.contains(away)) {
        schedule[week].emplace_back(team_by_id[home], team_by_id[away]);
      }
    }
  }
  std::vector<double> playoff_counts(team_count, 0);
  std::vector<double> championship_counts(team_count, 0);
  std::vector<double> wins_total(team_count, 0);
  std::vector<double> points_total(team_count, 0);
  std::vector<double> all_play_total(team_count, 0);
  std::vector<std::vector<int>> seed_counts(team_count, std::vector<int>(team_count, 0));
  for (int simulation = 0; simulation < simulations; ++simulation) {
    std::vector<std::vector<double>> scores(team_count,
        std::vector<double>(static_cast<std::size_t>(championship_week - regular_start + 1), 0));
    for (int week = regular_start; week <= championship_week; ++week) {
      std::unordered_map<std::string, double> nfl_team_factors;
      std::unordered_map<std::string, double> game_factors;
      for (int team = 0; team < team_count; ++team) {
        const Lineup& lineup = lineups[team][static_cast<std::size_t>(week - regular_start)];
        double total = 0;
        for (const auto& starter : lineup.starters) {
          if (starter.player_index < 0) continue;
          const Player& player = teams[team].roster[static_cast<std::size_t>(starter.player_index)];
          const double projection = week_projection(player, week);
          if (projection <= 0) continue;
          if (!nfl_team_factors.contains(player.team)) nfl_team_factors[player.team] = normal(generator);
          if (!game_factors.contains(player.team)) game_factors[player.team] = normal(generator);
          const double availability = clamp(1 - player.injury_risk * 0.52, 0.42, 0.995);
          if (uniform(generator) > availability) continue;
          const double ratio = player.weekly > 0 ? projection / player.weekly : 1;
          const double sigma = std::max(0.5, player.stddev * ratio) *
              (1.08 - player.reliability * 0.22);
          const double independent = std::sqrt(std::max(0.01,
              1 - team_correlation * team_correlation - game_correlation * game_correlation));
          const double z = team_correlation * nfl_team_factors[player.team] +
              game_correlation * game_factors[player.team] + independent * normal(generator);
          total += std::max(0.0, projection + sigma * z);
        }
        scores[team][static_cast<std::size_t>(week - regular_start)] = total;
      }
    }
    std::vector<double> wins(team_count, 0);
    std::vector<double> points(team_count, 0);
    for (int team = 0; team < team_count; ++team) {
      wins[team] = teams[team].wins + teams[team].ties * 0.5;
      points[team] = teams[team].points_for;
    }
    std::vector<double> all_play(team_count, 0);
    for (int week = regular_start; week <= regular_end; ++week) {
      const auto& pairs = schedule.contains(week) && !schedule[week].empty()
          ? schedule[week] : round_robin_pairs(team_count, week);
      for (const auto& [left, right] : pairs) {
        const double a = scores[left][static_cast<std::size_t>(week - regular_start)];
        const double b = scores[right][static_cast<std::size_t>(week - regular_start)];
        if (a > b) wins[left] += 1;
        else if (b > a) wins[right] += 1;
        else { wins[left] += 0.5; wins[right] += 0.5; }
      }
      double weekly_median = 0;
      if (median_game) {
        std::vector<double> weekly_scores;
        weekly_scores.reserve(static_cast<std::size_t>(team_count));
        for (int team = 0; team < team_count; ++team) {
          weekly_scores.push_back(scores[team][static_cast<std::size_t>(week - regular_start)]);
        }
        std::sort(weekly_scores.begin(), weekly_scores.end());
        const std::size_t middle = weekly_scores.size() / 2;
        weekly_median = weekly_scores.size() % 2 == 0
            ? (weekly_scores[middle - 1] + weekly_scores[middle]) / 2
            : weekly_scores[middle];
      }
      for (int team = 0; team < team_count; ++team) {
        const double score = scores[team][static_cast<std::size_t>(week - regular_start)];
        points[team] += score;
        if (median_game) {
          if (score > weekly_median) wins[team] += 1;
          else if (score == weekly_median) wins[team] += 0.5;
        }
        for (int other = 0; other < team_count; ++other) {
          if (team == other) continue;
          const double opponent = scores[other][static_cast<std::size_t>(week - regular_start)];
          all_play[team] += score > opponent ? 1 : (score == opponent ? 0.5 : 0);
        }
      }
    }
    std::vector<int> ranking(team_count);
    std::iota(ranking.begin(), ranking.end(), 0);
    std::sort(ranking.begin(), ranking.end(), [&](int left, int right) {
      return wins[left] != wins[right] ? wins[left] > wins[right] : points[left] > points[right];
    });
    for (int seed = 0; seed < team_count; ++seed) ++seed_counts[ranking[seed]][seed];
    std::vector<int> participants(ranking.begin(), ranking.begin() + playoff_teams);
    for (int team : participants) playoff_counts[team] += 1;
    int playoff_week = regular_end + 1;
    const int byes = std::min(playoff_byes, static_cast<int>(participants.size()) - 1);
    if (byes > 0) {
      std::vector<int> next(participants.begin(), participants.begin() + byes);
      std::vector<int> active(participants.begin() + byes, participants.end());
      while (active.size() >= 2) {
        const int high = active.front();
        const int low = active.back();
        active.erase(active.begin());
        active.pop_back();
        const double high_score = scores[high][static_cast<std::size_t>(playoff_week - regular_start)];
        const double low_score = scores[low][static_cast<std::size_t>(playoff_week - regular_start)];
        next.push_back(high_score >= low_score ? high : low);
      }
      if (!active.empty()) next.push_back(active.front());
      participants = std::move(next);
      ++playoff_week;
    }
    while (participants.size() > 1 && playoff_week <= championship_week) {
      std::sort(participants.begin(), participants.end(), [&](int left, int right) {
        return std::find(ranking.begin(), ranking.end(), left) < std::find(ranking.begin(), ranking.end(), right);
      });
      std::vector<int> next;
      while (participants.size() >= 2) {
        const int high = participants.front();
        const int low = participants.back();
        participants.erase(participants.begin());
        participants.pop_back();
        const double high_score = scores[high][static_cast<std::size_t>(playoff_week - regular_start)];
        const double low_score = scores[low][static_cast<std::size_t>(playoff_week - regular_start)];
        next.push_back(high_score >= low_score ? high : low);
      }
      if (!participants.empty()) next.push_back(participants.front());
      participants = std::move(next);
      ++playoff_week;
    }
    if (!participants.empty()) championship_counts[participants.front()] += 1;
    for (int team = 0; team < team_count; ++team) {
      wins_total[team] += wins[team];
      points_total[team] += points[team];
      all_play_total[team] += all_play[team];
    }
  }
  json results = json::array();
  const int regular_weeks = regular_end - regular_start + 1;
  for (int team = 0; team < team_count; ++team) {
    json seed_probabilities = json::array();
    for (int seed = 0; seed < team_count; ++seed) {
      seed_probabilities.push_back(round_to(static_cast<double>(seed_counts[team][seed]) / simulations, 4));
    }
    results.push_back({{"teamId", teams[team].id}, {"name", teams[team].name},
                       {"currentWins", round_to(teams[team].wins + teams[team].ties * 0.5, 2)},
                       {"currentPoints", round_to(teams[team].points_for, 2)},
                       {"expectedWins", round_to(wins_total[team] / simulations, 2)},
                       {"futureExpectedWins", round_to(wins_total[team] / simulations - teams[team].wins - teams[team].ties * 0.5, 2)},
                       {"expectedPoints", round_to(points_total[team] / simulations, 2)},
                       {"futureExpectedPoints", round_to(points_total[team] / simulations - teams[team].points_for, 2)},
                       {"allPlayWinPct", round_to(all_play_total[team] /
                           std::max(1, simulations * regular_weeks * (team_count - 1)), 4)},
                       {"playoffProbability", round_to(playoff_counts[team] / simulations, 4)},
                       {"championshipProbability", round_to(championship_counts[team] / simulations, 4)},
                       {"seedProbabilities", seed_probabilities}});
  }
  std::sort(results.begin(), results.end(), [](const json& left, const json& right) {
    return left.value("championshipProbability", 0.0) > right.value("championshipProbability", 0.0);
  });
  return {{"simulations", simulations}, {"regularSeasonStart", regular_start},
          {"regularSeasonEnd", regular_end}, {"championshipWeek", championship_week},
          {"playoffTeams", playoff_teams}, {"playoffByes", playoff_byes},
          {"medianGame", median_game}, {"teams", results},
          {"model", "native-league-monte-carlo-v2-exact-state"}};
}

}  // namespace
