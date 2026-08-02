#include "engine.hpp"

#include <chrono>
#include <cmath>
#include <iostream>
#include <string>

namespace {

using oracle::json;

json error_response(const json& request, const std::string& code, const std::string& message) {
  return {
      {"id", request.value("id", 0)},
      {"ok", false},
      {"code", code},
      {"error", message},
  };
}

}  // namespace

int main(int argc, char** argv) {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  json cached_players = json::array();
  std::string cached_dataset_key;

  if (argc > 1 && std::string(argv[1]) == "--capabilities") {
    std::cout << oracle::capabilities().dump() << '\n';
    return 0;
  }

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    json request;
    try {
      request = json::parse(line);
      const auto started = std::chrono::steady_clock::now();
      const std::string type = request.value("type", "");
      json payload = request.value("payload", json::object());
      json data;
      if (type == "dataset-load") {
        const std::string dataset_key = payload.value("datasetKey", "");
        const json players = payload.value("players", json::array());
        if (dataset_key.empty() || !players.is_array() || players.empty()) {
          throw std::runtime_error("dataset-load requires datasetKey and players");
        }
        cached_dataset_key = dataset_key;
        cached_players = players;
        data = {{"datasetKey", cached_dataset_key}, {"players", cached_players.size()}};
      } else {
        const std::string requested_key = payload.value("datasetKey", "");
        if (!payload.contains("players") && !requested_key.empty()) {
          if (requested_key != cached_dataset_key || cached_players.empty()) {
            throw std::runtime_error("Requested native dataset is not loaded");
          }
          payload["players"] = cached_players;
        }
        data = oracle::run_task(type, payload);
      }
      const auto elapsed = std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - started).count();
      json response = {
          {"id", request.value("id", 0)},
          {"ok", true},
          {"result", {
              {"data", std::move(data)},
              {"computeMs", std::round(elapsed * 100.0) / 100.0},
              {"engine", "oracle-native"},
              {"engineVersion", "1.1.0"},
          }},
      };
      std::cout << response.dump() << '\n' << std::flush;
    } catch (const nlohmann::json::exception& error) {
      std::cout << error_response(request, "INVALID_JSON", error.what()).dump()
                << '\n' << std::flush;
    } catch (const std::exception& error) {
      std::cout << error_response(request, "NATIVE_COMPUTE_FAILED", error.what()).dump()
                << '\n' << std::flush;
    } catch (...) {
      std::cout << error_response(request, "NATIVE_UNKNOWN_FAILURE", "Unknown native error").dump()
                << '\n' << std::flush;
    }
  }
  return 0;
}
