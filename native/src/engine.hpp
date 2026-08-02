#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "../third_party/nlohmann/json.hpp"

namespace oracle {

using json = nlohmann::json;

struct Settings {
  int teams = 12;
  int rounds = 16;
  int draft_position = 6;
  double risk_tolerance = 0.5;
  std::string scoring = "ppr";
  std::unordered_map<std::string, int> slots;
};

struct Player {
  std::shared_ptr<const json> raw;
  std::string id;
  std::string name;
  std::string position;
  std::string team;
  std::string injury_status;
  int bye_week = 0;
  double projected = 0;
  double weekly = 0;
  double previous = 0;
  double floor = 0;
  double ceiling = 0;
  double stddev = 0;
  double reliability = 0.72;
  double injury_risk = 0;
  double adp = 0;
  double ppr_rank = 0;
  double standard_rank = 0;
  double superflex_rank = 0;
  double percent_owned = 0;
  std::array<double, 18> weekly_values{};
  std::array<bool, 18> weekly_present{};
};

struct Starter {
  std::string slot;
  std::string slot_key;
  int player_index = -1;
};

struct Lineup {
  std::vector<Starter> starters;
  std::vector<int> bench;
  double total = 0;
  int filled = 0;
};

Settings parse_settings(const json& value);
Player parse_player(const json& value, bool keep_raw = true);
std::vector<Player> parse_players(const json& value, bool keep_raw = true);
json player_json(const Player& player, std::optional<double> metric = std::nullopt);

json run_task(const std::string& type, const json& payload);
json capabilities();

}  // namespace oracle
