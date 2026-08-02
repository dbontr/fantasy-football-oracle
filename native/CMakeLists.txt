cmake_minimum_required(VERSION 3.20)
project(fantasy_oracle_native VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(oracle-engine
  src/main.cpp
  src/engine.cpp
)

target_include_directories(oracle-engine PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)

if(MSVC)
  target_compile_options(oracle-engine PRIVATE /O2 /W4 /permissive-)
else()
  target_compile_options(oracle-engine PRIVATE -O3 -Wall -Wextra -Wpedantic)
endif()

install(TARGETS oracle-engine RUNTIME DESTINATION bin)
