
cmake_minimum_required(VERSION 3.15)
project(SmartAccidentDetection LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(PostgreSQL QUIET)

add_executable(accident_backend main.cpp database.cpp)

if(PostgreSQL_FOUND)
    target_compile_definitions(accident_backend PRIVATE SAD_WITH_POSTGRESQL)
    target_include_directories(accident_backend PRIVATE ${PostgreSQL_INCLUDE_DIRS})
    target_link_libraries(accident_backend PRIVATE PostgreSQL::PostgreSQL)
    message(STATUS "PostgreSQL persistence enabled")
else()
    message(WARNING "libpq not found. Building with in-memory-only mode; install PostgreSQL development files to enable persistence.")
endif()
