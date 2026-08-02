#include "engine.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <numeric>
#include <random>
#include <set>
#include <stdexcept>
#include <unordered_set>

namespace oracle {
namespace {

constexpr double kInf = 1e100;
constexpr std::array<const char*, 8> kStarterSlots = {
    "QB", "RB", "WR", "TE", "FLEX", "SUPERFLEX", "DST", "K"};
constexpr std::array<const char*, 6> kPositions = {"QB", "RB", "WR", "TE", "DST", "K"};

int clamp_int(int value, int low, int high) {
  return std::min(high, std::max(low, value));
}

double clamp(double value, double low, double high) {
  if (!std::isfinite(value)) return low;
  return std::min(high, std::max(low, value));
}

double number(const json& value, const char* key, double fallback = 0.0) {
  if (!value.is_object() || !value.contains(key) || value.at(key).is_null()) return fallback;
  const auto& item = value.at(key);
  if (item.is_number()) return item.get<double>();
  if (item.is_string()) {
    try {
      return std::stod(item.get<std::string>());
    } catch (...) {
      return fallback;
    }
  }
  return fallback;
}

int integer(const json& value, const char* key, int fallback = 0) {
  return static_cast<int>(std::llround(number(value, key, fallback)));
}

std::string text(const json& value, const char* key, const std::string& fallback = {}) {
  if (!value.is_object() || !value.contains(key) || value.at(key).is_null()) return fallback;
  const auto& item = value.at(key);
  if (item.is_string()) return item.get<std::string>();
  if (item.is_number_integer()) return std::to_string(item.get<long long>());
  return fallback;
}

std::string upper(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::toupper(c));
  });
  return value;
}

std::string lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return value;
}

double round_to(double value, int digits) {
  const double scale = std::pow(10.0, digits);
  return std::round(value * scale) / scale;
}

bool skill_position(const std::string& position) {
  return position == "QB" || position == "RB" || position == "WR" || position == "TE";
}

std::unordered_map<std::string, int> default_slots() {
  return {{"QB", 1}, {"RB", 2}, {"WR", 2}, {"TE", 1}, {"FLEX", 1},
          {"SUPERFLEX", 0}, {"DST", 1}, {"K", 1}, {"BN", 7}};
}

int slot_count(const Settings& settings, const std::string& slot) {
  auto found = settings.slots.find(slot);
  return found == settings.slots.end() ? 0 : found->second;
}

bool eligible(const std::string& slot, const std::string& position) {
  if (slot == "FLEX") return position == "RB" || position == "WR" || position == "TE";
  if (slot == "SUPERFLEX") return position == "QB" || position == "RB" || position == "WR" || position == "TE";
  return slot == position;
}

std::vector<std::pair<std::string, std::string>> expanded_slots(const Settings& settings) {
  std::vector<std::pair<std::string, std::string>> result;
  for (const char* slot : kStarterSlots) {
    const int count = std::max(0, slot_count(settings, slot));
    for (int index = 0; index < count; ++index) {
      result.emplace_back(slot, std::string(slot) + std::to_string(index + 1));
    }
  }
  auto width = [](const std::string& slot) {
    if (slot == "FLEX") return 3;
    if (slot == "SUPERFLEX") return 4;
    return 1;
  };
  std::stable_sort(result.begin(), result.end(), [&](const auto& a, const auto& b) {
    const int left = width(a.first);
    const int right = width(b.first);
    return left != right ? left < right : a.first < b.first;
  });
  return result;
}

int snake_team(int pick_number, int teams) {
  teams = std::max(2, teams);
  pick_number = std::max(1, pick_number);
  const int round = (pick_number - 1) / teams + 1;
  const int within = (pick_number - 1) % teams + 1;
  return round % 2 == 1 ? within : teams - within + 1;
}

}  // namespace

Settings parse_settings(const json& value) {
  Settings settings;
  settings.teams = clamp_int(integer(value, "teams", 12), 4, 20);
  settings.rounds = clamp_int(integer(value, "rounds", 16), 4, 30);
  settings.draft_position = clamp_int(integer(value, "draftPosition", 6), 1, settings.teams);
  settings.risk_tolerance = clamp(number(value, "riskTolerance", 0.5), 0.0, 1.0);
  settings.scoring = lower(text(value, "scoring", "ppr"));
  settings.slots = default_slots();
  if (value.is_object() && value.contains("slots") && value.at("slots").is_object()) {
    for (auto it = value.at("slots").begin(); it != value.at("slots").end(); ++it) {
      settings.slots[upper(it.key())] = clamp_int(static_cast<int>(std::llround(it.value().get<double>())), 0, 40);
    }
  }
  return settings;
}

Player parse_player(const json& value, bool keep_raw) {
  Player player;
  player.raw = keep_raw && value.is_object()
    ? std::make_shared<const json>(value)
    : nullptr;
  player.id = text(value, "id", text(value, "playerId", text(value, "name", "")));
  player.name = text(value, "name", "Unknown player");
  player.position = upper(text(value, "position", ""));
  player.team = upper(text(value, "team", "FA"));
  player.injury_status = text(value, "injuryStatus", "ACTIVE");
  player.projected = number(value, "projectedPoints", number(value, "projection", 0));
  player.weekly = number(value, "weeklyProjection", player.projected / 17.0);
  player.previous = number(value, "previousPoints", 0);
  player.floor = number(value, "floorProjection", player.weekly * 0.62);
  player.ceiling = number(value, "ceilingProjection", player.weekly * 1.58);
  player.stddev = number(value, "projectionStdDev", player.weekly * 0.42);
  player.reliability = clamp(number(value, "reliability", 0.72), 0, 1);
  player.injury_risk = clamp(number(value, "injuryRisk", 0), 0, 1);
  player.bye_week = clamp_int(integer(value, "byeWeek", 0), 0, 18);
  player.adp = number(value, "adp", 0);
  player.ppr_rank = number(value, "pprRank", 0);
  player.standard_rank = number(value, "standardRank", 0);
  player.superflex_rank = number(value, "superflexRank", 0);
  player.percent_owned = number(value, "percentOwned", 0);
  if (value.is_object() && value.contains("weeklyProjections") && value.at("weeklyProjections").is_array()) {
    const auto& rows = value.at("weeklyProjections");
    for (std::size_t index = 0; index < std::min<std::size_t>(18, rows.size()); ++index) {
      if (rows.at(index).is_number()) {
        player.weekly_values[index] = std::max(0.0, rows.at(index).get<double>());
        player.weekly_present[index] = true;
      }
    }
  }
  return player;
}

std::vector<Player> parse_players(const json& value, bool keep_raw) {
  std::vector<Player> players;
  if (!value.is_array()) return players;
  std::unordered_set<std::string> seen;
  players.reserve(value.size());
  for (const auto& row : value) {
    Player player = parse_player(row, keep_raw);
    if (player.id.empty() || seen.contains(player.id)) continue;
    seen.insert(player.id);
    players.push_back(std::move(player));
  }
  return players;
}

json player_json(const Player& player, std::optional<double> metric) {
  json value = player.raw ? *player.raw : json::object();
  value["id"] = player.id;
  value["name"] = player.name;
  value["position"] = player.position;
  value["team"] = player.team;
  value["projectedPoints"] = player.projected;
  value["weeklyProjection"] = player.weekly;
  value["previousPoints"] = player.previous;
  value["floorProjection"] = player.floor;
  value["ceilingProjection"] = player.ceiling;
  value["projectionStdDev"] = player.stddev;
  value["reliability"] = player.reliability;
  value["injuryRisk"] = player.injury_risk;
  value["injuryStatus"] = player.injury_status;
  value["byeWeek"] = player.bye_week;
  if (metric.has_value()) value["weekProjection"] = *metric;
  return value;
}

namespace {

double week_projection(const Player& player, int week, bool fallback = true) {
  week = clamp_int(week, 1, 18);
  if (player.bye_week == week) return 0;
  const std::size_t index = static_cast<std::size_t>(week - 1);
  if (player.weekly_present[index]) return std::max(0.0, player.weekly_values[index]);
  return fallback ? std::max(0.0, player.weekly) : 0;
}

std::pair<double, double> week_range(const Player& player, int week) {
  const double projection = week_projection(player, week);
  if (projection <= 0) return {0, 0};
  const double ratio = player.weekly > 0 ? projection / player.weekly : 1;
  return {std::max(0.0, player.floor * ratio), std::max(projection, player.ceiling * ratio)};
}

double rank_for_scoring(const Player& player, const Settings& settings) {
  if (settings.scoring == "superflex") {
    if (player.superflex_rank > 0) return player.superflex_rank;
    if (player.ppr_rank > 0) return player.ppr_rank;
    if (player.adp > 0) return player.adp;
  } else if (settings.scoring == "standard") {
    if (player.standard_rank > 0) return player.standard_rank;
    if (player.ppr_rank > 0) return player.ppr_rank;
    if (player.adp > 0) return player.adp;
  } else {
    if (player.ppr_rank > 0) return player.ppr_rank;
    if (player.adp > 0) return player.adp;
    if (player.standard_rank > 0) return player.standard_rank;
  }
  return 9999;
}

std::unordered_map<std::string, double> position_demand(const Settings& settings) {
  const double teams = settings.teams;
  return {
      {"QB", std::max(teams, teams * (slot_count(settings, "QB") + slot_count(settings, "SUPERFLEX") * 0.72))},
      {"RB", teams * (slot_count(settings, "RB") + slot_count(settings, "FLEX") * 0.45 + slot_count(settings, "SUPERFLEX") * 0.08)},
      {"WR", teams * (slot_count(settings, "WR") + slot_count(settings, "FLEX") * 0.43 + slot_count(settings, "SUPERFLEX") * 0.08)},
      {"TE", teams * (slot_count(settings, "TE") + slot_count(settings, "FLEX") * 0.12 + slot_count(settings, "SUPERFLEX") * 0.04)},
      {"DST", teams * slot_count(settings, "DST")},
      {"K", teams * slot_count(settings, "K")},
  };
}

std::unordered_map<std::string, double> replacement_levels(
    const std::vector<Player>& players, const Settings& settings, std::optional<int> week = std::nullopt) {
  const auto demand = position_demand(settings);
  std::unordered_map<std::string, double> result;
  for (const auto& [position, count] : demand) {
    std::vector<double> values;
    for (const auto& player : players) {
      if (player.position != position) continue;
      values.push_back(week.has_value() ? week_projection(player, *week) : player.projected);
    }
    std::sort(values.begin(), values.end(), std::greater<double>());
    if (values.empty()) {
      result[position] = 0;
      continue;
    }
    const int index = clamp_int(static_cast<int>(std::llround(count)) - 1, 0, static_cast<int>(values.size()) - 1);
    result[position] = values[static_cast<std::size_t>(index)];
  }
  return result;
}

std::vector<int> minimum_cost_assignment(const std::vector<std::vector<double>>& costs) {
  const int rows = static_cast<int>(costs.size());
  const int columns = rows ? static_cast<int>(costs.front().size()) : 0;
  if (!rows || !columns) return {};
  std::vector<double> row_potential(rows + 1, 0);
  std::vector<double> column_potential(columns + 1, 0);
  std::vector<int> matched_row(columns + 1, 0);
  std::vector<int> previous_column(columns + 1, 0);
  for (int row = 1; row <= rows; ++row) {
    matched_row[0] = row;
    int current_column = 0;
    std::vector<double> minimum(columns + 1, kInf);
    std::vector<unsigned char> used(columns + 1, 0);
    do {
      used[current_column] = 1;
      const int current_row = matched_row[current_column];
      double delta = kInf;
      int next_column = 0;
      for (int column = 1; column <= columns; ++column) {
        if (used[column]) continue;
        const double reduced = costs[current_row - 1][column - 1] -
            row_potential[current_row] - column_potential[column];
        if (reduced < minimum[column]) {
          minimum[column] = reduced;
          previous_column[column] = current_column;
        }
        if (minimum[column] < delta) {
          delta = minimum[column];
          next_column = column;
        }
      }
      for (int column = 0; column <= columns; ++column) {
        if (used[column]) {
          row_potential[matched_row[column]] += delta;
          column_potential[column] -= delta;
        } else {
          minimum[column] -= delta;
        }
      }
      current_column = next_column;
    } while (matched_row[current_column] != 0);
    do {
      const int prior = previous_column[current_column];
      matched_row[current_column] = matched_row[prior];
      current_column = prior;
    } while (current_column != 0);
  }
  std::vector<int> assignment(rows, -1);
  for (int column = 1; column <= columns; ++column) {
    if (matched_row[column] > 0) assignment[matched_row[column] - 1] = column - 1;
  }
  return assignment;
}

Lineup optimize_lineup(const std::vector<Player>& players, const Settings& settings,
                       std::optional<int> week = std::nullopt,
                       const std::vector<double>* custom_metric = nullptr) {
  const auto slots = expanded_slots(settings);
  if (slots.empty()) return Lineup{};
  const int dummy_count = static_cast<int>(slots.size());
  std::vector<std::vector<double>> costs;
  costs.reserve(slots.size());
  auto metric = [&](int index) {
    if (custom_metric) return custom_metric->at(static_cast<std::size_t>(index));
    return week.has_value() ? week_projection(players[static_cast<std::size_t>(index)], *week)
                            : players[static_cast<std::size_t>(index)].weekly;
  };
  for (const auto& [slot, key] : slots) {
    std::vector<double> row;
    row.reserve(players.size() + dummy_count);
    for (int index = 0; index < static_cast<int>(players.size()); ++index) {
      row.push_back(eligible(slot, players[static_cast<std::size_t>(index)].position)
                        ? -metric(index) : 1'000'000.0);
    }
    row.insert(row.end(), dummy_count, 0.0);
    costs.push_back(std::move(row));
  }
  const auto assignment = minimum_cost_assignment(costs);
  Lineup lineup;
  std::unordered_set<int> used;
  for (int row = 0; row < static_cast<int>(slots.size()); ++row) {
    const int column = assignment[static_cast<std::size_t>(row)];
    int player_index = -1;
    if (column >= 0 && column < static_cast<int>(players.size()) &&
        eligible(slots[static_cast<std::size_t>(row)].first,
                 players[static_cast<std::size_t>(column)].position)) {
      player_index = column;
      used.insert(column);
      lineup.total += metric(column);
      ++lineup.filled;
    }
    lineup.starters.push_back({slots[static_cast<std::size_t>(row)].first,
                               slots[static_cast<std::size_t>(row)].second,
                               player_index});
  }
  for (int index = 0; index < static_cast<int>(players.size()); ++index) {
    if (!used.contains(index)) lineup.bench.push_back(index);
  }
  std::sort(lineup.bench.begin(), lineup.bench.end(), [&](int left, int right) {
    return metric(left) > metric(right);
  });
  lineup.total = round_to(lineup.total, 2);
  return lineup;
}

json lineup_json(const Lineup& lineup, const std::vector<Player>& players,
                 std::optional<int> week = std::nullopt,
                 const std::vector<double>* custom_metric = nullptr) {
  json starters = json::array();
  for (const auto& row : lineup.starters) {
    json item = {{"slot", row.slot}, {"slotKey", row.slot_key}};
    if (row.player_index >= 0) {
      const Player& player = players[static_cast<std::size_t>(row.player_index)];
      const double metric = custom_metric ? custom_metric->at(static_cast<std::size_t>(row.player_index))
                                          : (week.has_value() ? week_projection(player, *week) : player.weekly);
      item["player"] = player_json(player, week.has_value() || custom_metric ? std::optional<double>(metric) : std::nullopt);
    } else {
      item["player"] = nullptr;
    }
    starters.push_back(std::move(item));
  }
  json bench = json::array();
  for (int index : lineup.bench) {
    const Player& player = players[static_cast<std::size_t>(index)];
    const double metric = custom_metric ? custom_metric->at(static_cast<std::size_t>(index))
                                        : (week.has_value() ? week_projection(player, *week) : player.weekly);
    bench.push_back(player_json(player, week.has_value() || custom_metric ? std::optional<double>(metric) : std::nullopt));
  }
  json result = {{"starters", starters}, {"bench", bench}, {"total", lineup.total},
                 {"filled", lineup.filled}, {"slots", lineup.starters.size()}};
  if (week.has_value()) result["week"] = *week;
  return result;
}

std::unordered_map<std::string, int> count_positions(const std::vector<Player>& roster) {
  std::unordered_map<std::string, int> counts;
  for (const auto& player : roster) ++counts[player.position];
  return counts;
}

int starter_need(const std::string& position, const std::unordered_map<std::string, int>& counts,
                 const Settings& settings) {
  const int direct = std::max(0, slot_count(settings, position) -
      (counts.contains(position) ? counts.at(position) : 0));
  if (!skill_position(position)) return direct;
  const int skill_rostered = (counts.contains("RB") ? counts.at("RB") : 0) +
      (counts.contains("WR") ? counts.at("WR") : 0) +
      (counts.contains("TE") ? counts.at("TE") : 0);
  const int direct_skill = slot_count(settings, "RB") + slot_count(settings, "WR") + slot_count(settings, "TE");
  const int flex_need = std::max(0, direct_skill + slot_count(settings, "FLEX") +
      slot_count(settings, "SUPERFLEX") - skill_rostered);
  const int qb_need = position == "QB" ? std::max(0, slot_count(settings, "QB") +
      slot_count(settings, "SUPERFLEX") - (counts.contains("QB") ? counts.at("QB") : 0)) : 0;
  return std::max(direct, position == "QB" ? qb_need : std::min(1, flex_need));
}

}  // namespace

namespace {

#include "draft_sim.inc"

}  // namespace

namespace {

double asset_value(const Player& player,
                   const std::unordered_map<std::string, double>& replacement,
                   const Settings& settings) {
  const double level = replacement.contains(player.position) ? replacement.at(player.position) : 0;
  const double vorp = player.projected - level;
  const double rank_bonus = std::max(0.0, 180 - rank_for_scoring(player, settings)) * 0.11;
  const double durability = player.previous > 0 ? std::min(12.0, player.previous * 0.025) : 0;
  return player.projected * 0.22 + vorp * 1.8 + rank_bonus + durability - player.injury_risk * 26;
}

std::unordered_map<std::string, double> tier_cliffs(const std::vector<Player>& players,
                                                    const std::unordered_set<std::string>& drafted) {
  std::unordered_map<std::string, std::vector<const Player*>> grouped;
  for (const auto& player : players) {
    if (!drafted.contains(player.id)) grouped[player.position].push_back(&player);
  }
  std::unordered_map<std::string, double> result;
  for (auto& [position, rows] : grouped) {
    std::sort(rows.begin(), rows.end(), [](const auto* left, const auto* right) {
      return left->projected > right->projected;
    });
    for (std::size_t index = 0; index < rows.size(); ++index) {
      const auto* comparison = rows[std::min(rows.size() - 1, index + 5)];
      result[rows[index]->id] = std::max(0.0, rows[index]->projected - comparison->projected);
    }
  }
  return result;
}

double construction_penalty(const Player& player,
                            const std::unordered_map<std::string, int>& counts,
                            const Settings& settings, int pick_number) {
  const int position_count = counts.contains(player.position) ? counts.at(player.position) : 0;
  const int starter_count = slot_count(settings, player.position);
  const double fraction = static_cast<double>(pick_number) /
      std::max(1, settings.teams * settings.rounds);
  double penalty = 0;
  if ((player.position == "K" || player.position == "DST") && fraction < 0.72) {
    penalty += 24 * (0.72 - fraction);
  }
  if (player.position == "QB" && slot_count(settings, "SUPERFLEX") == 0 &&
      position_count >= 1 && fraction < 0.55) penalty += 9;
  if (position_count >= starter_count + 3 && player.position != "RB" && player.position != "WR") {
    penalty += 8;
  }
  return penalty;
}

std::vector<int> roster_indices(const json& state, int team_id,
                                const std::unordered_map<std::string, int>& by_id) {
  std::vector<int> result;
  for (const auto& id : roster_ids(state, team_id)) {
    auto found = by_id.find(id);
    if (found != by_id.end()) result.push_back(found->second);
  }
  return result;
}

double opponent_pressure(const std::string& position, const json& state,
                         const Settings& settings,
                         const std::unordered_map<std::string, int>& by_id,
                         const std::vector<Player>& players,
                         int start_pick, int target_pick, int target_team) {
  double pressure = 0;
  for (int pick = start_pick; pick < target_pick; ++pick) {
    const int team = snake_team(pick, settings.teams);
    if (team == target_team) continue;
    std::vector<Player> roster;
    for (int index : roster_indices(state, team, by_id)) roster.push_back(players[index]);
    const auto counts = count_positions(roster);
    pressure += starter_need(position, counts, settings) > 0 ? 1 : 0.18;
  }
  return pressure;
}

#include "draft_recommend.inc"

}  // namespace

namespace {

std::string score_grade(double score) {
  if (score >= 90) return "A+";
  if (score >= 82) return "A";
  if (score >= 74) return "B";
  if (score >= 64) return "C";
  if (score >= 54) return "D";
  return "F";
}

json roster_analysis(const json& payload) {
  const Settings settings = parse_settings(payload.value("settings", json::object()));
  const std::vector<Player> roster = parse_players(payload.value("roster", json::array()));
  std::vector<Player> universe = parse_players(payload.value("players", json::array()));
  if (universe.empty()) universe = roster;
  const int week = clamp_int(integer(payload, "week", 1), 1, 18);
  const Lineup lineup = optimize_lineup(roster, settings, week);
  const auto replacement = replacement_levels(universe, settings, week);
  double floor = 0;
  double ceiling = 0;
  double total_vorp = 0;
  double reliability = 0;
  std::unordered_set<int> starter_indices;
  for (const auto& row : lineup.starters) {
    if (row.player_index < 0) continue;
    starter_indices.insert(row.player_index);
    const auto& player = roster[static_cast<std::size_t>(row.player_index)];
    const auto [low, high] = week_range(player, week);
    floor += low;
    ceiling += high;
    total_vorp += week_projection(player, week) -
        (replacement.contains(player.position) ? replacement.at(player.position) : 0);
    reliability += player.reliability;
  }
  double bench_projection = 0;
  for (std::size_t index = 0; index < std::min<std::size_t>(5, lineup.bench.size()); ++index) {
    bench_projection += week_projection(roster[static_cast<std::size_t>(lineup.bench[index])], week) *
        (1 - static_cast<double>(index) * 0.12);
  }
  double injury_exposure = 0;
  int bye_starters = 0;
  for (const auto& row : lineup.starters) {
    if (row.player_index < 0) continue;
    const auto& player = roster[static_cast<std::size_t>(row.player_index)];
    injury_exposure += player.injury_risk * week_projection(player, week);
    if (player.bye_week == week) ++bye_starters;
  }
  injury_exposure /= std::max(1.0, lineup.total);
  const double strength = clamp(50 + total_vorp * 1.75 + bench_projection * 0.16 -
                                injury_exposure * 21 - bye_starters * 7, 0, 100);
  json positions = json::array();
  std::vector<std::pair<double, std::string>> weakest;
  for (const auto* position : kPositions) {
    int count = 0;
    int starter_count_value = 0;
    double points = 0;
    double depth = 0;
    for (int index = 0; index < static_cast<int>(roster.size()); ++index) {
      if (roster[static_cast<std::size_t>(index)].position != position) continue;
      ++count;
      if (starter_indices.contains(index)) {
        ++starter_count_value;
        points += week_projection(roster[static_cast<std::size_t>(index)], week);
      } else {
        depth += week_projection(roster[static_cast<std::size_t>(index)], week);
      }
    }
    if (!count && slot_count(settings, position) == 0) continue;
    const double baseline = (replacement.contains(position) ? replacement.at(position) : 0) *
        std::max(1, starter_count_value);
    const double position_score = clamp(55 + (points - baseline) * 4 + std::min(12.0, depth * 0.5), 0, 100);
    positions.push_back({{"position", position}, {"count", count}, {"starters", starter_count_value},
                         {"points", round_to(points, 2)}, {"replacement", round_to(baseline, 2)},
                         {"depth", round_to(depth, 2)}, {"score", round_to(position_score, 1)},
                         {"grade", score_grade(position_score)}});
    weakest.emplace_back(position_score, position);
  }
  std::sort(weakest.begin(), weakest.end());
  json weakest_positions = json::array();
  for (std::size_t index = 0; index < std::min<std::size_t>(2, weakest.size()); ++index) {
    weakest_positions.push_back(weakest[index].second);
  }
  json bye_players = json::array();
  json injury_players = json::array();
  for (const auto& player : roster) {
    if (player.bye_week == week) bye_players.push_back(player_json(player));
    if (player.injury_risk >= 0.35) injury_players.push_back(player_json(player));
  }
  json bye_conflicts = json::array();
  for (int selected = 1; selected <= 18; ++selected) {
    json rows = json::array();
    for (const auto& player : roster) if (player.bye_week == selected) rows.push_back(player_json(player));
    if (rows.size() >= 2) bye_conflicts.push_back({{"week", selected}, {"players", rows}});
  }
  double season_projection = 0;
  for (int selected = 1; selected <= 17; ++selected) {
    season_projection += optimize_lineup(roster, settings, selected).total;
  }
  return {{"week", week}, {"lineup", lineup_json(lineup, roster, week)},
          {"floor", round_to(floor, 2)}, {"ceiling", round_to(ceiling, 2)},
          {"reliability", round_to(reliability / std::max(1, lineup.filled), 3)},
          {"benchProjection", round_to(bench_projection, 2)},
          {"strengthScore", round_to(strength, 1)}, {"grade", score_grade(strength)},
          {"seasonProjection", round_to(season_projection, 2)},
          {"totalVorp", round_to(total_vorp, 2)}, {"byePlayers", bye_players},
          {"injuryPlayers", injury_players}, {"byeConflicts", bye_conflicts},
          {"positions", positions}, {"weakestPositions", weakest_positions}};
}

double bench_depth(const Lineup& lineup, const std::vector<Player>& roster,
                   std::optional<int> week = std::nullopt,
                   const std::vector<double>* metric = nullptr) {
  double total = 0;
  for (std::size_t index = 0; index < std::min<std::size_t>(4, lineup.bench.size()); ++index) {
    const int player_index = lineup.bench[index];
    const double value = metric ? metric->at(static_cast<std::size_t>(player_index)) :
        (week.has_value() ? week_projection(roster[static_cast<std::size_t>(player_index)], *week)
                          : roster[static_cast<std::size_t>(player_index)].weekly);
    total += value * (1 - static_cast<double>(index) * 0.14);
  }
  return total;
}

std::pair<std::string, std::string> trade_grade(double score) {
  if (score >= 18) return {"A+", "Major upgrade"};
  if (score >= 10) return {"A", "Strong accept"};
  if (score >= 4) return {"B", "Helpful trade"};
  if (score > -4) return {"C", "Mostly even"};
  if (score > -10) return {"D", "You lose value"};
  return {"F", "Reject"};
}

std::vector<Player> apply_trade(const std::vector<Player>& roster,
                                const std::vector<Player>& give,
                                const std::vector<Player>& receive) {
  std::unordered_set<std::string> removed;
  for (const auto& player : give) removed.insert(player.id);
  std::unordered_set<std::string> seen;
  std::vector<Player> result;
  for (const auto& player : roster) {
    if (!removed.contains(player.id) && seen.insert(player.id).second) result.push_back(player);
  }
  for (const auto& player : receive) {
    if (seen.insert(player.id).second) result.push_back(player);
  }
  return result;
}

struct TradeMetrics {
  std::vector<Player> after_roster;
  Lineup before;
  Lineup after;
  double give_value = 0;
  double receive_value = 0;
  double lineup_gain = 0;
  double asset_gain = 0;
  double depth_gain = 0;
  double score = 0;
  int fairness = 0;
};

TradeMetrics compute_trade_metrics(
    const std::vector<Player>& roster,
    const std::vector<Player>& give,
    const std::vector<Player>& receive,
    const std::vector<Player>& universe,
    const Settings& settings,
    std::optional<int> week,
    const std::optional<Lineup>& cached_before = std::nullopt,
    const std::optional<std::unordered_map<std::string, double>>& cached_replacement = std::nullopt) {
  TradeMetrics metrics;
  metrics.after_roster = apply_trade(roster, give, receive);
  const auto replacement = cached_replacement.has_value()
    ? *cached_replacement
    : replacement_levels(universe, settings);
  metrics.before = cached_before.has_value()
    ? *cached_before
    : optimize_lineup(roster, settings, week);
  metrics.after = optimize_lineup(metrics.after_roster, settings, week);
  for (const auto& player : give) {
    metrics.give_value += asset_value(player, replacement, settings);
  }
  for (const auto& player : receive) {
    metrics.receive_value += asset_value(player, replacement, settings);
  }
  metrics.lineup_gain = metrics.after.total - metrics.before.total;
  metrics.asset_gain = metrics.receive_value - metrics.give_value;
  metrics.depth_gain = bench_depth(metrics.after, metrics.after_roster, week) -
    bench_depth(metrics.before, roster, week);
  metrics.score = metrics.lineup_gain * 8 + metrics.asset_gain * 0.34 + metrics.depth_gain * 1.8;
  const double fairness = 1 - std::min(
    1.0,
    std::abs(metrics.receive_value - metrics.give_value) /
      std::max({1.0, metrics.give_value, metrics.receive_value})
  );
  metrics.fairness = static_cast<int>(std::llround(fairness * 100));
  return metrics;
}

json trade_metrics_json(
    const TradeMetrics& metrics,
    const std::vector<Player>& roster,
    std::optional<int> week) {
  const auto [grade, verdict] = trade_grade(metrics.score);
  json after_json = json::array();
  for (const auto& player : metrics.after_roster) {
    after_json.push_back(player_json(player));
  }
  return {
    {"grade", grade},
    {"verdict", verdict},
    {"score", round_to(metrics.score, 2)},
    {"fairness", metrics.fairness},
    {"lineupGain", round_to(metrics.lineup_gain, 2)},
    {"assetGain", round_to(metrics.asset_gain, 2)},
    {"depthGain", round_to(metrics.depth_gain, 2)},
    {"giveValue", round_to(metrics.give_value, 2)},
    {"receiveValue", round_to(metrics.receive_value, 2)},
    {"before", lineup_json(metrics.before, roster, week)},
    {"after", lineup_json(metrics.after, metrics.after_roster, week)},
    {"afterRoster", after_json},
    {"summary", metrics.lineup_gain > 0
      ? "Adds " + std::to_string(round_to(metrics.lineup_gain, 1)) +
        " projected starter points per week."
      : "Changes projected starter output by " +
        std::to_string(round_to(metrics.lineup_gain, 1)) + " points per week."}
  };
}

json trade_analysis_values(
    const std::vector<Player>& roster,
    const std::vector<Player>& give,
    const std::vector<Player>& receive,
    const std::vector<Player>& universe,
    const Settings& settings,
    std::optional<int> week,
    const std::optional<Lineup>& cached_before = std::nullopt,
    const std::optional<std::unordered_map<std::string, double>>& cached_replacement = std::nullopt) {
  const TradeMetrics metrics = compute_trade_metrics(
    roster,
    give,
    receive,
    universe,
    settings,
    week,
    cached_before,
    cached_replacement
  );
  return trade_metrics_json(metrics, roster, week);
}

json trade_analysis(const json& payload) {
  const Settings settings = parse_settings(payload.value("settings", json::object()));
  const auto roster = parse_players(payload.value("roster", json::array()));
  const auto give = parse_players(payload.value("give", json::array()));
  const auto receive = parse_players(payload.value("receive", json::array()));
  auto universe = parse_players(payload.value("players", json::array()));
  if (universe.empty()) {
    universe = roster;
    universe.insert(universe.end(), receive.begin(), receive.end());
  }
  const int week_value = integer(payload, "week", 0);
  return trade_analysis_values(roster, give, receive, universe, settings,
                               week_value ? std::optional<int>(clamp_int(week_value, 1, 18)) : std::nullopt);
}

}  // namespace

namespace {

struct Package {
  std::vector<int> indices;
  double value = 0;
};

std::vector<Package> make_packages(const std::vector<Player>& assets, int size,
                                   const std::unordered_map<std::string, double>& replacement,
                                   const Settings& settings) {
  std::vector<Package> result;
  if (size == 1) {
    result.reserve(assets.size());
    for (int index = 0; index < static_cast<int>(assets.size()); ++index) {
      result.push_back({{index}, asset_value(assets[static_cast<std::size_t>(index)], replacement, settings)});
    }
    return result;
  }
  for (int first = 0; first < static_cast<int>(assets.size()); ++first) {
    for (int second = first + 1; second < static_cast<int>(assets.size()); ++second) {
      result.push_back({{first, second},
                        asset_value(assets[static_cast<std::size_t>(first)], replacement, settings) +
                        asset_value(assets[static_cast<std::size_t>(second)], replacement, settings)});
    }
  }
  return result;
}

std::vector<Player> package_players(const Package& package, const std::vector<Player>& assets) {
  std::vector<Player> result;
  for (int index : package.indices) result.push_back(assets[static_cast<std::size_t>(index)]);
  return result;
}

std::string package_key(const std::vector<Player>& give, const std::vector<Player>& receive) {
  std::vector<std::string> left;
  std::vector<std::string> right;
  for (const auto& player : give) left.push_back(player.id);
  for (const auto& player : receive) right.push_back(player.id);
  std::sort(left.begin(), left.end());
  std::sort(right.begin(), right.end());
  std::string key;
  for (const auto& id : left) key += id + ",";
  key += "->";
  for (const auto& id : right) key += id + ",";
  return key;
}

json trade_generation(const json& payload) {
  const Settings settings = parse_settings(payload.value("settings", json::object()));
  const auto user_roster = parse_players(payload.value("userRoster", json::array()));
  const auto opponent_roster = parse_players(payload.value("opponentRoster", json::array()));
  auto universe = parse_players(payload.value("players", json::array()));
  if (universe.empty()) {
    universe = user_roster;
    universe.insert(universe.end(), opponent_roster.begin(), opponent_roster.end());
  }
  if (user_roster.empty() || opponent_roster.empty()) return json::array();
  const auto replacement = replacement_levels(universe, settings);
  const int week_value = integer(payload, "week", 0);
  const std::optional<int> week = week_value ? std::optional<int>(clamp_int(week_value, 1, 18)) : std::nullopt;
  const int asset_limit = clamp_int(integer(payload, "assetLimit", 12), 6, 16);
  const bool two_for_two = payload.value("includeTwoForTwo", true);
  const double minimum_raw = clamp(number(payload, "minimumRawFairness", 0.58), 0.35, 0.95);
  const int minimum_fairness = clamp_int(integer(payload, "minimumFairness", 62), 45, 95);
  const int neighbors = clamp_int(integer(payload, "packageNeighbors", two_for_two ? 20 : 12), 4, 60);
  const int max_evaluations = clamp_int(integer(payload, "maxEvaluations", two_for_two ? 900 : 600), 100, 12000);
  const int limit = clamp_int(integer(payload, "limit", 12), 1, 40);
  auto eligible_asset = [](const Player& player) {
    return (player.position != "K" && player.position != "DST") || player.percent_owned >= 70;
  };
  std::vector<Player> user_assets;
  std::vector<Player> opponent_assets;
  for (const auto& player : user_roster) if (eligible_asset(player)) user_assets.push_back(player);
  for (const auto& player : opponent_roster) if (eligible_asset(player)) opponent_assets.push_back(player);
  auto sort_assets = [&](std::vector<Player>& rows) {
    std::sort(rows.begin(), rows.end(), [&](const auto& left, const auto& right) {
      return asset_value(left, replacement, settings) > asset_value(right, replacement, settings);
    });
    if (rows.size() > static_cast<std::size_t>(asset_limit)) rows.resize(static_cast<std::size_t>(asset_limit));
  };
  sort_assets(user_assets);
  sort_assets(opponent_assets);
  const Lineup user_before = optimize_lineup(user_roster, settings, week);
  const Lineup opponent_before = optimize_lineup(opponent_roster, settings, week);
  struct Candidate {
    std::vector<Player> give;
    std::vector<Player> receive;
    double quick = 0;
  };
  std::unordered_map<std::string, Candidate> candidates;
  std::vector<std::pair<int, int>> sizes = {{1, 1}, {2, 1}, {1, 2}};
  if (two_for_two) sizes.emplace_back(2, 2);
  for (const auto& [give_size, receive_size] : sizes) {
    auto give_packages = make_packages(user_assets, give_size, replacement, settings);
    auto receive_packages = make_packages(opponent_assets, receive_size, replacement, settings);
    std::sort(receive_packages.begin(), receive_packages.end(), [](const auto& left, const auto& right) {
      return left.value < right.value;
    });
    for (const auto& give_package : give_packages) {
      const auto iterator = std::lower_bound(receive_packages.begin(), receive_packages.end(), give_package.value,
          [](const Package& package, double value) { return package.value < value; });
      const int center = static_cast<int>(std::distance(receive_packages.begin(), iterator));
      const int first = std::max(0, center - neighbors);
      const int last = std::min(static_cast<int>(receive_packages.size()), center + neighbors + 1);
      for (int index = first; index < last; ++index) {
        const auto& receive_package = receive_packages[static_cast<std::size_t>(index)];
        const double fairness = 1 - std::abs(receive_package.value - give_package.value) /
            std::max({1.0, receive_package.value, give_package.value});
        if (fairness < minimum_raw) continue;
        auto give = package_players(give_package, user_assets);
        auto receive = package_players(receive_package, opponent_assets);
        const std::string key = package_key(give, receive);
        const double quick = fairness * 100 - std::abs(give_size - receive_size) * 1.5;
        if (!candidates.contains(key) || candidates[key].quick < quick) {
          candidates[key] = {std::move(give), std::move(receive), quick};
        }
      }
    }
  }
  std::vector<Candidate> ranked;
  ranked.reserve(candidates.size());
  for (auto& [key, candidate] : candidates) ranked.push_back(std::move(candidate));
  std::sort(ranked.begin(), ranked.end(), [](const auto& left, const auto& right) {
    return left.quick > right.quick;
  });
  if (ranked.size() > static_cast<std::size_t>(max_evaluations)) ranked.resize(max_evaluations);
  struct Proposal {
    std::vector<Player> give;
    std::vector<Player> receive;
    double mutual = 0;
  };
  std::vector<Proposal> proposals;
  proposals.reserve(ranked.size());
  for (const auto& candidate : ranked) {
    const TradeMetrics user = compute_trade_metrics(
      user_roster,
      candidate.give,
      candidate.receive,
      universe,
      settings,
      week,
      user_before,
      replacement
    );
    const TradeMetrics opponent = compute_trade_metrics(
      opponent_roster,
      candidate.receive,
      candidate.give,
      universe,
      settings,
      week,
      opponent_before,
      replacement
    );
    const int fairness = static_cast<int>(std::llround(
      (static_cast<double>(user.fairness) + static_cast<double>(opponent.fairness)) / 2.0
    ));
    if (user.score < -1.5 || opponent.score < -4.5 || fairness < minimum_fairness) {
      continue;
    }
    const double mutual = user.score + std::max(-2.0, opponent.score) * 0.45 + fairness * 0.055;
    proposals.push_back({candidate.give, candidate.receive, mutual});
  }
  std::sort(proposals.begin(), proposals.end(), [](const auto& left, const auto& right) {
    return left.mutual > right.mutual;
  });
  json output = json::array();
  std::unordered_set<std::string> seen;
  for (const auto& proposal : proposals) {
    const std::string key = package_key(proposal.give, proposal.receive);
    if (!seen.insert(key).second) continue;

    const TradeMetrics user_metrics = compute_trade_metrics(
      user_roster,
      proposal.give,
      proposal.receive,
      universe,
      settings,
      week,
      user_before,
      replacement
    );
    const TradeMetrics opponent_metrics = compute_trade_metrics(
      opponent_roster,
      proposal.receive,
      proposal.give,
      universe,
      settings,
      week,
      opponent_before,
      replacement
    );
    const int fairness = static_cast<int>(std::llround(
      (static_cast<double>(user_metrics.fairness) +
       static_cast<double>(opponent_metrics.fairness)) / 2.0
    ));
    const json user = trade_metrics_json(user_metrics, user_roster, week);
    const json opponent = trade_metrics_json(opponent_metrics, opponent_roster, week);
    json give = json::array();
    json receive = json::array();
    for (const auto& player : proposal.give) give.push_back(player_json(player));
    for (const auto& player : proposal.receive) receive.push_back(player_json(player));

    std::string summary = "A value-balanced depth and roster-fit exchange.";
    if (user_metrics.lineup_gain > 0.25 && opponent_metrics.lineup_gain > 0.25) {
      summary = "Both optimized lineups improve.";
    } else if (user_metrics.lineup_gain > 0.25) {
      summary = "Improves your starters while preserving plausible value for the opponent.";
    }
    output.push_back({
      {"give", give},
      {"receive", receive},
      {"userAnalysis", user},
      {"opponentAnalysis", opponent},
      {"fairness", fairness},
      {"mutualScore", round_to(proposal.mutual, 2)},
      {"packageType", std::to_string(proposal.give.size()) + "-for-" +
        std::to_string(proposal.receive.size())},
      {"summary", summary}
    });
    if (output.size() >= static_cast<std::size_t>(limit)) break;
  }
  return output;
}

json waiver_recommendations(const json& payload) {
  const Settings settings = parse_settings(payload.value("settings", json::object()));
  const auto roster = parse_players(payload.value("roster", json::array()));
  auto free_agents = parse_players(payload.value("freeAgents", json::array()));
  const int week_value = integer(payload, "week", 0);
  const std::optional<int> week = week_value ? std::optional<int>(clamp_int(week_value, 1, 18)) : std::nullopt;
  const int limit = clamp_int(integer(payload, "limit", 12), 1, 40);
  const double budget_remaining = clamp(number(payload, "budgetRemaining", 0), 0, 10000);
  const int weeks_remaining = clamp_int(integer(payload, "weeksRemaining", 17), 1, 18);
  const double aggressiveness = clamp(number(payload, "aggressiveness", settings.risk_tolerance), 0, 1);
  std::vector<double> roster_metric;
  for (const auto& player : roster) roster_metric.push_back(week ? week_projection(player, *week) : player.weekly);
  std::vector<double> free_metric;
  for (const auto& player : free_agents) free_metric.push_back(week ? week_projection(player, *week) : player.weekly);
  std::vector<int> free_order(free_agents.size());
  std::iota(free_order.begin(), free_order.end(), 0);
  std::sort(free_order.begin(), free_order.end(), [&](int left, int right) {
    return free_metric[left] > free_metric[right];
  });
  if (free_order.size() > 120) free_order.resize(120);
  const Lineup before = optimize_lineup(roster, settings, std::nullopt, &roster_metric);
  std::unordered_set<int> starter_indices;
  for (const auto& row : before.starters) if (row.player_index >= 0) starter_indices.insert(row.player_index);
  std::vector<int> drops(roster.size());
  std::iota(drops.begin(), drops.end(), 0);
  std::sort(drops.begin(), drops.end(), [&](int left, int right) {
    return roster_metric[left] < roster_metric[right];
  });
  if (drops.size() > 8) drops.resize(8);
  struct Suggestion { json value; double score; std::string add_id; };
  std::vector<Suggestion> suggestions;
  for (std::size_t order_index = 0; order_index < std::min<std::size_t>(40, free_order.size()); ++order_index) {
    const int add_index = free_order[order_index];
    const Player& add = free_agents[static_cast<std::size_t>(add_index)];
    for (int drop_index : drops) {
      const Player& drop = roster[static_cast<std::size_t>(drop_index)];
      if (starter_indices.contains(drop_index) && free_metric[add_index] <= roster_metric[drop_index]) continue;
      std::vector<Player> next;
      std::vector<double> next_metric;
      for (int index = 0; index < static_cast<int>(roster.size()); ++index) {
        if (index == drop_index) continue;
        next.push_back(roster[static_cast<std::size_t>(index)]);
        next_metric.push_back(roster_metric[static_cast<std::size_t>(index)]);
      }
      next.push_back(add);
      next_metric.push_back(free_metric[static_cast<std::size_t>(add_index)]);
      const Lineup after = optimize_lineup(next, settings, std::nullopt, &next_metric);
      const double lineup_gain = after.total - before.total;
      const double depth_gain = bench_depth(after, next, std::nullopt, &next_metric) -
          bench_depth(before, roster, std::nullopt, &roster_metric);
      const double asset_gain = add.projected - drop.projected;
      const double reliability_gain = add.reliability - drop.reliability;
      const double score = lineup_gain * 9 + depth_gain * 2 + asset_gain * 0.055 + reliability_gain * 3;
      if (score <= 0.25) continue;
      const std::string reason = lineup_gain >= 0.5 ?
          "Improves the optimized lineup by " + std::to_string(round_to(lineup_gain, 1)) + " points." :
          "Raises bench and injury-replacement depth by " + std::to_string(round_to(depth_gain, 1)) + " points.";
      json faab = nullptr;
      if (budget_remaining > 0) {
        const double relative_gain = asset_gain / std::max(20.0, add.projected);
        const double scarcity = clamp(relative_gain + std::max(0.0, lineup_gain) * 0.035, -0.2, 0.65);
        const double urgency = clamp(score / 38.0 + std::max(0.0, lineup_gain) * 0.025 +
                                     scarcity * 0.38 + (1 - add.reliability) * 0.06, 0.01, 0.82);
        const double season_factor = clamp(static_cast<double>(weeks_remaining) / 17.0, 0.22, 1.0);
        const double target_percent = clamp(urgency * (0.62 + aggressiveness * 0.72) * season_factor,
                                            0.01, 0.88);
        const double target_bid = std::min(budget_remaining, std::round(budget_remaining * target_percent));
        const double floor_bid = std::min(target_bid, std::max(1.0, std::round(target_bid * 0.68)));
        const double ceiling_bid = std::min(budget_remaining, std::max(target_bid,
            std::round(target_bid * (1.22 + aggressiveness * 0.22))));
        faab = {{"budgetRemaining", round_to(budget_remaining, 2)},
                {"floor", floor_bid}, {"target", target_bid}, {"ceiling", ceiling_bid},
                {"percentBudget", round_to(target_bid / budget_remaining, 4)},
                {"urgency", round_to(urgency, 3)}, {"weeksRemaining", weeks_remaining}};
      }
      suggestions.push_back({{{"add", player_json(add)}, {"drop", player_json(drop)},
                              {"week", week ? json(*week) : json(nullptr)}, {"score", round_to(score, 2)},
                              {"lineupGain", round_to(lineup_gain, 2)}, {"depthGain", round_to(depth_gain, 2)},
                              {"assetGain", round_to(asset_gain, 2)},
                              {"reliabilityGain", round_to(reliability_gain, 3)}, {"reason", reason},
                              {"faab", faab}},
                             score, add.id});
    }
  }
  std::sort(suggestions.begin(), suggestions.end(), [](const auto& left, const auto& right) {
    return left.score > right.score;
  });
  json output = json::array();
  std::unordered_set<std::string> seen;
  for (const auto& suggestion : suggestions) {
    if (!seen.insert(suggestion.add_id).second) continue;
    output.push_back(suggestion.value);
    if (output.size() >= static_cast<std::size_t>(limit)) break;
  }
  return output;
}

}  // namespace

namespace {

double quantile(std::vector<double> values, double probability) {
  if (values.empty()) return 0;
  probability = clamp(probability, 0, 1);
  const double position = probability * static_cast<double>(values.size() - 1);
  const std::size_t lower_index = static_cast<std::size_t>(std::floor(position));
  const std::size_t upper_index = static_cast<std::size_t>(std::ceil(position));
  std::nth_element(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(lower_index), values.end());
  const double lower_value = values[lower_index];
  if (lower_index == upper_index) return lower_value;
  std::nth_element(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(upper_index), values.end());
  return lower_value + (values[upper_index] - lower_value) * (position - lower_index);
}

double mean(const std::vector<double>& values) {
  return values.empty() ? 0 : std::accumulate(values.begin(), values.end(), 0.0) / values.size();
}

double standard_deviation(const std::vector<double>& values, double average) {
  if (values.size() < 2) return 0;
  double total = 0;
  for (double value : values) total += (value - average) * (value - average);
  return std::sqrt(total / static_cast<double>(values.size() - 1));
}

json season_simulation(const json& payload) {
  const Settings settings = parse_settings(payload.value("settings", json::object()));
  const auto roster = parse_players(payload.value("roster", json::array()));
  const int start_week = clamp_int(integer(payload, "startWeek", 1), 1, 18);
  const int end_week = clamp_int(integer(payload, "endWeek", 17), start_week, 18);
  const int simulations = clamp_int(integer(payload, "simulations", 25000), 100, 500000);
  const std::uint64_t seed = static_cast<std::uint64_t>(number(payload, "seed", 2026));
  const double team_correlation = clamp(number(payload, "teamCorrelation", 0.16), 0, 0.6);
  const double game_correlation = clamp(number(payload, "gameCorrelation", 0.08), 0, 0.4);
  std::mt19937_64 generator(seed ? seed : 1);
  std::normal_distribution<double> normal(0, 1);
  std::uniform_real_distribution<double> uniform(0, 1);
  std::vector<double> season_totals;
  season_totals.reserve(simulations);
  std::vector<std::vector<double>> weekly_totals(static_cast<std::size_t>(end_week - start_week + 1));
  for (auto& rows : weekly_totals) rows.reserve(simulations);
  std::vector<Lineup> weekly_lineups;
  for (int week = start_week; week <= end_week; ++week) {
    weekly_lineups.push_back(optimize_lineup(roster, settings, week));
  }
  for (int simulation = 0; simulation < simulations; ++simulation) {
    double season_total = 0;
    for (int week = start_week; week <= end_week; ++week) {
      const Lineup& lineup = weekly_lineups[static_cast<std::size_t>(week - start_week)];
      std::unordered_map<std::string, double> team_factors;
      std::unordered_map<std::string, double> game_factors;
      double total = 0;
      for (const auto& starter : lineup.starters) {
        if (starter.player_index < 0) continue;
        const Player& player = roster[static_cast<std::size_t>(starter.player_index)];
        const double projection = week_projection(player, week);
        if (projection <= 0) continue;
        if (!team_factors.contains(player.team)) team_factors[player.team] = normal(generator);
        const std::string game_key = player.team;
        if (!game_factors.contains(game_key)) game_factors[game_key] = normal(generator);
        const double availability = clamp(1 - player.injury_risk * 0.52, 0.42, 0.995);
        if (uniform(generator) > availability) continue;
        const double ratio = player.weekly > 0 ? projection / player.weekly : 1;
        const double sigma = std::max(0.5, player.stddev * ratio) *
            (1.08 - player.reliability * 0.22);
        const double independent_weight = std::sqrt(std::max(0.01,
            1 - team_correlation * team_correlation - game_correlation * game_correlation));
        const double z = team_correlation * team_factors[player.team] +
            game_correlation * game_factors[game_key] + independent_weight * normal(generator);
        total += std::max(0.0, projection + sigma * z);
      }
      weekly_totals[static_cast<std::size_t>(week - start_week)].push_back(total);
      season_total += total;
    }
    season_totals.push_back(season_total);
  }
  const double expected = mean(season_totals);
  const double deviation = standard_deviation(season_totals, expected);
  const double p10 = quantile(season_totals, 0.10);
  const double p25 = quantile(season_totals, 0.25);
  const double p50 = quantile(season_totals, 0.50);
  const double p75 = quantile(season_totals, 0.75);
  const double p90 = quantile(season_totals, 0.90);
  double cvar_total = 0;
  int cvar_count = 0;
  for (double value : season_totals) {
    if (value <= p10) {
      cvar_total += value;
      ++cvar_count;
    }
  }
  json weeks = json::array();
  for (int week = start_week; week <= end_week; ++week) {
    auto& rows = weekly_totals[static_cast<std::size_t>(week - start_week)];
    const double average = mean(rows);
    const double weekly_p10 = quantile(rows, 0.10);
    const double weekly_p50 = quantile(rows, 0.50);
    const double weekly_p90 = quantile(rows, 0.90);
    weeks.push_back({{"week", week}, {"mean", round_to(average, 2)},
                     {"p10", round_to(weekly_p10, 2)}, {"p50", round_to(weekly_p50, 2)},
                     {"p90", round_to(weekly_p90, 2)},
                     {"stdDev", round_to(standard_deviation(rows, average), 2)},
                     {"lineup", lineup_json(weekly_lineups[static_cast<std::size_t>(week - start_week)], roster, week)}});
  }
  return {{"simulations", simulations}, {"startWeek", start_week}, {"endWeek", end_week},
          {"expectedPoints", round_to(expected, 2)}, {"stdDev", round_to(deviation, 2)},
          {"p10", round_to(p10, 2)}, {"p25", round_to(p25, 2)},
          {"median", round_to(p50, 2)}, {"p75", round_to(p75, 2)},
          {"p90", round_to(p90, 2)},
          {"cvar10", round_to(cvar_count ? cvar_total / cvar_count : p10, 2)},
          {"coefficientOfVariation", round_to(expected > 0 ? deviation / expected : 0, 4)},
          {"weeks", weeks}, {"model", "native-correlated-monte-carlo-v1"}};
}

json lineup_task(const json& payload) {
  const Settings settings = parse_settings(payload.value("settings", json::object()));
  const auto roster = parse_players(payload.value("roster", json::array()));
  const int week_value = integer(payload, "week", 0);
  const std::optional<int> week = week_value ? std::optional<int>(clamp_int(week_value, 1, 18)) : std::nullopt;
  const Lineup lineup = optimize_lineup(roster, settings, week);
  return lineup_json(lineup, roster, week);
}

}  // namespace

#include "advanced.inc"

json capabilities() {
  return {{"engine", "oracle-native"}, {"version", "1.1.0"}, {"protocol", 1},
          {"language", "C++20"},
          {"tasks", {"draft-simulate", "draft-recommend", "lineup-optimize",
                     "roster-analyze", "waivers", "trade-analyze",
                     "trades-generate", "season-simulate", "start-sit", "league-simulate"}}};
}

json run_task(const std::string& type, const json& payload) {
  if (type == "capabilities") return capabilities();
  if (type == "draft-simulate") return simulate_draft(payload);
  if (type == "draft-recommend") return draft_recommendations(payload);
  if (type == "lineup-optimize") return lineup_task(payload);
  if (type == "roster-analyze") return roster_analysis(payload);
  if (type == "waivers") return waiver_recommendations(payload);
  if (type == "trade-analyze") return trade_analysis(payload);
  if (type == "trades-generate") return trade_generation(payload);
  if (type == "season-simulate") return season_simulation(payload);
  if (type == "start-sit") return start_sit_analysis(payload);
  if (type == "league-simulate") return league_simulation(payload);
  throw std::runtime_error("Unknown native task: " + type);
}

}  // namespace oracle
