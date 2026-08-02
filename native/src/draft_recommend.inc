json draft_recommendations(const json& payload) {
  const Settings settings = parse_settings(payload.value("settings", json::object()));
  const std::vector<Player> players = parse_players(payload.value("players", json::array()));
  const json state = payload.value("state", json::object());
  const int target_team = integer(payload, "targetTeamId", settings.draft_position);
  const int limit = clamp_int(integer(payload, "limit", 60), 1, 260);
  json simulation_payload = payload.value("simulation", json::object());
  if (!simulation_payload.contains("players")) simulation_payload["players"] = payload.value("players", json::array());
  if (!simulation_payload.contains("state")) simulation_payload["state"] = state;
  if (!simulation_payload.contains("settings")) simulation_payload["settings"] = payload.value("settings", json::object());
  if (!simulation_payload.contains("targetTeamId")) simulation_payload["targetTeamId"] = target_team;
  const json simulation = simulate_draft(simulation_payload);
  const auto drafted = drafted_ids(state);
  const auto replacement = replacement_levels(players, settings);
  const auto cliffs = tier_cliffs(players, drafted);

  std::unordered_map<std::string, int> by_id;
  by_id.reserve(players.size());
  std::vector<double> asset_values(players.size(), 0);
  std::unordered_map<std::string, std::vector<int>> position_order;
  for (int index = 0; index < static_cast<int>(players.size()); ++index) {
    by_id[players[index].id] = index;
    asset_values[index] = asset_value(players[index], replacement, settings);
    if (!drafted.contains(players[index].id)) {
      position_order[players[index].position].push_back(index);
    }
  }
  for (auto& [position, indexes] : position_order) {
    std::sort(indexes.begin(), indexes.end(), [&](int left, int right) {
      if (asset_values[left] != asset_values[right]) return asset_values[left] > asset_values[right];
      return rank_for_scoring(players[left], settings) < rank_for_scoring(players[right], settings);
    });
  }

  std::vector<Player> roster;
  for (int index : roster_indices(state, target_team, by_id)) roster.push_back(players[index]);
  const auto counts = count_positions(roster);
  const int current_pick = pick_count(state) + 1;
  const int current_team = snake_team(current_pick, settings.teams);
  const int target_start = current_team == target_team ? current_pick + 1 : current_pick;
  int target_pick = next_pick_for_team(settings, target_team, target_start);
  if (!target_pick) target_pick = current_pick;
  const int picks_between = std::max(0, target_pick - current_pick);

  std::unordered_map<std::string, double> pressure;
  for (const auto* position : kPositions) {
    pressure[position] = opponent_pressure(position, state, settings, by_id, players,
                                           target_start, target_pick, target_team);
  }
  const json& availability = simulation.at("availabilityById");
  const json& run_rates = simulation.at("positionRunRates");
  auto return_probability = [&](int index) {
    const Player& player = players[index];
    if (availability.contains(player.id)) return availability.at(player.id).get<double>();
    return conditional_availability(player, current_pick, target_pick,
                                    settings, pressure[player.position]);
  };

  std::vector<json> results;
  results.reserve(players.size());
  for (int player_index = 0; player_index < static_cast<int>(players.size()); ++player_index) {
    const Player& player = players[player_index];
    if (drafted.contains(player.id)) continue;
    const double level = replacement.contains(player.position) ? replacement.at(player.position) : 0;
    const double vorp = player.projected - level;
    const int need = starter_need(player.position, counts, settings);
    const double cliff = cliffs.contains(player.id) ? cliffs.at(player.id) : 0;
    const double adp_pressure = player.adp > 0 ? clamp((current_pick - player.adp) * 0.34, -9, 12) : 0;
    const double need_bonus = need > 0 ? 13 + need * 4.5 : 0;
    const double risk_penalty = player.injury_risk * (18 - settings.risk_tolerance * 10);
    const double base_asset = asset_values[player_index];
    const double base_score = base_asset + need_bonus + cliff * 0.9 + adp_pressure -
        risk_penalty - construction_penalty(player, counts, settings, current_pick);
    const double return_chance = return_probability(player_index);

    double none_higher = 1;
    double future_value = 0;
    int peer_count = 0;
    const auto found = position_order.find(player.position);
    if (found != position_order.end()) {
      for (int peer_index : found->second) {
        if (peer_index == player_index) continue;
        const double probability = return_probability(peer_index);
        future_value += none_higher * probability * asset_values[peer_index];
        none_higher *= 1 - probability;
        if (++peer_count >= 14) break;
      }
    }
    future_value += none_higher * level * 0.45;
    const double vona = base_asset - future_value;
    double run_risk = clamp(pressure[player.position] / std::max(1, picks_between), 0, 1);
    if (run_rates.contains(player.position)) run_risk = run_rates.at(player.position).get<double>();
    const double urgency = clamp((1 - return_chance) * 58 + std::max(0.0, vona) * 1.35 +
                                 run_risk * 16 + cliff * 0.45, 0, 100);
    const std::string decision = return_chance < 0.25 || vona >= 12 ? "Draft now" :
        (return_chance < 0.58 || urgency >= 58 ? "Priority target" : "Can wait");

    json reasons = json::array();
    if (need > 0) reasons.push_back("fills " + player.position + " starter need");
    if (vorp > 18) reasons.push_back("+" +
        std::to_string(static_cast<int>(std::llround(vorp))) + " points over replacement");
    if (cliff > 8) reasons.push_back(player.position + " tier drops after him");
    if (adp_pressure > 4) reasons.push_back("falling past ADP " +
        std::to_string(round_to(player.adp, 1)));
    if (player.injury_risk >= 0.35) reasons.push_back(lower(player.injury_status) + " risk");
    reasons.push_back(std::to_string(static_cast<int>(std::llround(return_chance * 100))) +
                      "% estimated chance to return");
    if (vona >= 5) reasons.push_back("waiting costs about " +
                                     std::to_string(round_to(vona, 1)) + " value");
    if (run_risk >= 0.45) reasons.push_back(player.position + " run pressure is elevated");

    json row = player_json(player);
    row["score"] = round_to(base_score + std::max(-8.0, vona * 0.48) +
                            (1 - return_chance) * 8 + run_risk * 3, 2);
    row["baseScore"] = round_to(base_score, 2);
    row["vorp"] = round_to(vorp, 2);
    row["replacement"] = round_to(level, 2);
    row["tierCliff"] = round_to(cliff, 2);
    row["need"] = need;
    row["returnChance"] = round_to(return_chance, 4);
    row["vona"] = round_to(vona, 2);
    row["expectedFutureValue"] = round_to(future_value, 2);
    row["runRisk"] = round_to(run_risk, 3);
    row["urgency"] = round_to(urgency, 1);
    row["decision"] = decision;
    row["nextTeamPick"] = target_pick;
    row["reasons"] = reasons;
    results.push_back(std::move(row));
  }

  std::sort(results.begin(), results.end(), [](const json& left, const json& right) {
    const double left_score = left.value("score", 0.0);
    const double right_score = right.value("score", 0.0);
    if (left_score != right_score) return left_score > right_score;
    return left.value("returnChance", 1.0) < right.value("returnChance", 1.0);
  });
  if (results.size() > static_cast<std::size_t>(limit)) {
    results.resize(static_cast<std::size_t>(limit));
  }
  return {{"simulation", simulation}, {"recommendations", results}};
}
