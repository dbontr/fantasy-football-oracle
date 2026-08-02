class Mulberry32 {
 public:
  explicit Mulberry32(std::uint32_t seed) : value_(seed ? seed : 1u) {}
  std::uint32_t next_u32() {
    value_ += 0x6D2B79F5u;
    std::uint32_t result = value_;
    result = static_cast<std::uint32_t>((result ^ (result >> 15)) * (result | 1u));
    result ^= result + static_cast<std::uint32_t>((result ^ (result >> 7)) * (result | 61u));
    return result ^ (result >> 14);
  }
  double next() {
    return static_cast<double>(next_u32()) / 4294967296.0;
  }
 private:
  std::uint32_t value_;
};

double exact_gumbel(Mulberry32& random) {
  const double value = clamp(random.next(), 1e-9, 1 - 1e-9);
  return -std::log(-std::log(value));
}

const std::array<double, 65536>& gumbel_table() {
  static const std::array<double, 65536> table = [] {
    std::array<double, 65536> values{};
    for (std::size_t index = 0; index < values.size(); ++index) {
      const double value = (static_cast<double>(index) + 0.5) / values.size();
      values[index] = -std::log(-std::log(value));
    }
    return values;
  }();
  return table;
}

double fast_gumbel(Mulberry32& random) {
  return gumbel_table()[random.next_u32() >> 16];
}

int draft_position_index(const std::string& position) {
  if (position == "QB") return 0;
  if (position == "RB") return 1;
  if (position == "WR") return 2;
  if (position == "TE") return 3;
  if (position == "DST") return 4;
  if (position == "K") return 5;
  return 5;
}

const char* draft_position_name(int index) {
  return kPositions[static_cast<std::size_t>(clamp_int(index, 0, 5))];
}

int next_pick_for_team(const Settings& settings, int target_team, int start_pick) {
  const int maximum = settings.teams * settings.rounds;
  for (int pick = std::max(1, start_pick); pick <= maximum; ++pick) {
    if (snake_team(pick, settings.teams) == target_team) return pick;
  }
  return 0;
}

std::vector<std::string> roster_ids(const json& state, int team_id) {
  std::vector<std::string> ids;
  if (!state.is_object() || !state.contains("rosters") || !state.at("rosters").is_object()) return ids;
  const std::string key = std::to_string(team_id);
  if (!state.at("rosters").contains(key) || !state.at("rosters").at(key).is_array()) return ids;
  for (const auto& item : state.at("rosters").at(key)) {
    if (item.is_string()) ids.push_back(item.get<std::string>());
    else if (item.is_object()) ids.push_back(text(item, "id", ""));
    else if (item.is_number_integer()) ids.push_back(std::to_string(item.get<long long>()));
  }
  return ids;
}

int pick_count(const json& state) {
  if (!state.is_object() || !state.contains("picks") || !state.at("picks").is_array()) return 0;
  return static_cast<int>(state.at("picks").size());
}

std::unordered_set<std::string> drafted_ids(const json& state) {
  std::unordered_set<std::string> result;
  if (!state.is_object() || !state.contains("picks") || !state.at("picks").is_array()) return result;
  for (const auto& pick : state.at("picks")) {
    const std::string id = text(pick, "playerId", "");
    if (!id.empty()) result.insert(id);
  }
  return result;
}

double market_rank(const Player& player, const Settings& settings) {
  return player.adp > 0 ? player.adp : rank_for_scoring(player, settings);
}

double draft_spread(const Player& player, const Settings& settings) {
  const double rank = market_rank(player, settings);
  const double scale = player.position == "QB" && settings.scoring == "superflex" ? 0.82 : 1;
  return clamp((4.5 + rank * 0.12) * scale, 4.5, 28);
}

double logistic(double value) {
  if (value >= 35) return 1;
  if (value <= -35) return 0;
  return 1.0 / (1.0 + std::exp(-value));
}

double conditional_availability(const Player& player, int current_pick, int target_pick,
                                const Settings& settings, double pressure = 0) {
  current_pick = std::max(1, current_pick);
  target_pick = std::max(current_pick, target_pick);
  if (target_pick <= current_pick) return 1;
  const double center = market_rank(player, settings);
  const double spread = draft_spread(player, settings);
  const double drafted_current = logistic(((current_pick - 0.5) - center) / spread);
  const double drafted_target = logistic(((target_pick - 0.5) - center) / spread);
  const double survival_current = std::max(1e-6, 1 - drafted_current);
  const double survival_target = std::max(0.0, 1 - drafted_target);
  return clamp((survival_target / survival_current) *
      std::exp(-std::max(0.0, pressure) * 0.035), 0, 1);
}

int starter_need_fast(int position, const std::array<unsigned char, 6>& counts,
                      const Settings& settings) {
  const std::string name = draft_position_name(position);
  const int direct = std::max(0, slot_count(settings, name) - static_cast<int>(counts[position]));
  if (position >= 4) return direct;
  const int skill_rostered = counts[1] + counts[2] + counts[3];
  const int direct_skill = slot_count(settings, "RB") +
      slot_count(settings, "WR") + slot_count(settings, "TE");
  const int flex_need = std::max(0, direct_skill + slot_count(settings, "FLEX") +
      slot_count(settings, "SUPERFLEX") - skill_rostered);
  const int qb_need = position == 0 ? std::max(0, slot_count(settings, "QB") +
      slot_count(settings, "SUPERFLEX") - static_cast<int>(counts[0])) : 0;
  return std::max(direct, position == 0 ? qb_need : std::min(1, flex_need));
}

json simulate_draft(const json& payload) {
  const Settings settings = parse_settings(payload.value("settings", json::object()));
  const std::vector<Player> players = parse_players(payload.value("players", json::array()), false);
  const json state = payload.value("state", json::object());
  const auto drafted = drafted_ids(state);
  struct MarketRow {
    int player_index;
    int position_index;
    std::string id;
    double projected;
    double rank;
    double spread;
  };
  std::vector<MarketRow> market;
  market.reserve(players.size());
  for (int index = 0; index < static_cast<int>(players.size()); ++index) {
    const auto& player = players[static_cast<std::size_t>(index)];
    if (drafted.contains(player.id)) continue;
    market.push_back({index, draft_position_index(player.position), player.id,
                      player.projected, market_rank(player, settings),
                      draft_spread(player, settings)});
  }
  std::sort(market.begin(), market.end(), [](const auto& left, const auto& right) {
    return left.rank != right.rank ? left.rank < right.rank : left.projected > right.projected;
  });
  const int tracked = std::min(static_cast<int>(market.size()),
      std::max(40, integer(payload, "trackLimit", 140)));
  const int current_pick = pick_count(state) + 1;
  const int target_team = integer(payload, "targetTeamId", settings.draft_position);
  const int current_team = snake_team(current_pick, settings.teams);
  const int start_pick = current_team == target_team ? current_pick + 1 : current_pick;
  int target_pick = next_pick_for_team(settings, target_team, start_pick);
  if (!target_pick) target_pick = current_pick;
  std::vector<std::pair<int, int>> sequence;
  for (int pick = start_pick; pick < target_pick; ++pick) {
    sequence.emplace_back(pick, snake_team(pick, settings.teams));
  }

  const int simulations = clamp_int(integer(payload, "simulations", 800), 20, 250000);
  const std::uint32_t seed = static_cast<std::uint32_t>(integer(
      payload, "seed", current_pick * 7919 + target_team * 104729));
  const bool exact_noise = payload.value("exactNoise", false);
  Mulberry32 random(seed);
  std::vector<std::uint32_t> available_counts(static_cast<std::size_t>(tracked), 0);
  std::vector<std::uint32_t> taken_counts(market.size(), 0);
  std::array<std::uint64_t, 6> position_counts{};
  std::array<std::array<unsigned char, 6>, 21> base_counts{};
  std::unordered_map<std::string, int> player_index;
  player_index.reserve(players.size());
  for (int index = 0; index < static_cast<int>(players.size()); ++index) {
    player_index[players[static_cast<std::size_t>(index)].id] = index;
  }
  std::array<unsigned char, 21> involved{};
  for (const auto& [pick, team] : sequence) involved[team] = 1;
  for (int team = 1; team <= settings.teams; ++team) {
    if (!involved[team]) continue;
    for (const auto& id : roster_ids(state, team)) {
      auto found = player_index.find(id);
      if (found == player_index.end()) continue;
      const int position = draft_position_index(
          players[static_cast<std::size_t>(found->second)].position);
      ++base_counts[team][position];
    }
  }
  std::vector<unsigned char> available(market.size(), 1);
  for (int simulation = 0; simulation < simulations; ++simulation) {
    std::fill(available.begin(), available.end(), 1);
    auto counts_by_team = base_counts;
    for (const auto& [pick, team] : sequence) {
      auto& counts = counts_by_team[team];
      int selected = -1;
      double best = -kInf;
      int candidates = 0;
      for (int index = 0; index < static_cast<int>(market.size()) && candidates < 52; ++index) {
        if (!available[static_cast<std::size_t>(index)]) continue;
        ++candidates;
        const auto& candidate = market[static_cast<std::size_t>(index)];
        const int need = starter_need_fast(candidate.position_index, counts, settings);
        const double reach = std::max(0.0, candidate.rank - pick) * 0.11;
        const double fall = std::max(0.0, pick - candidate.rank) * 0.24;
        const double noise = exact_noise ? exact_gumbel(random) : fast_gumbel(random);
        const double score = -candidate.rank * 0.62 + need * 9.5 + fall - reach +
            candidate.projected * 0.018 + noise * candidate.spread * 0.72;
        if (score > best) {
          selected = index;
          best = score;
        }
      }
      if (selected < 0) break;
      const auto& chosen = market[static_cast<std::size_t>(selected)];
      available[static_cast<std::size_t>(selected)] = 0;
      ++counts[chosen.position_index];
      ++taken_counts[static_cast<std::size_t>(selected)];
      ++position_counts[static_cast<std::size_t>(chosen.position_index)];
    }
    for (int index = 0; index < tracked; ++index) {
      if (available[static_cast<std::size_t>(index)]) {
        ++available_counts[static_cast<std::size_t>(index)];
      }
    }
  }

  json availability = json::object();
  for (int index = 0; index < tracked; ++index) {
    availability[market[static_cast<std::size_t>(index)].id] =
        round_to(static_cast<double>(available_counts[static_cast<std::size_t>(index)]) /
                 simulations, 4);
  }
  json taken = json::object();
  for (std::size_t index = 0; index < market.size(); ++index) {
    if (taken_counts[index]) {
      taken[market[index].id] = round_to(static_cast<double>(taken_counts[index]) /
                                        simulations, 4);
    }
  }
  json run_rates = json::object();
  const double denominator = std::max(1,
      simulations * std::max(1, static_cast<int>(sequence.size())));
  for (int position = 0; position < 6; ++position) {
    run_rates[draft_position_name(position)] = round_to(
        static_cast<double>(position_counts[static_cast<std::size_t>(position)]) /
        denominator, 4);
  }
  return {{"currentPick", current_pick}, {"startPick", start_pick},
          {"targetPick", target_pick}, {"targetTeamId", target_team},
          {"simulations", simulations}, {"noiseMode", exact_noise ? "exact" : "lookup"},
          {"availabilityById", availability}, {"takenById", taken},
          {"positionRunRates", run_rates}};
}
