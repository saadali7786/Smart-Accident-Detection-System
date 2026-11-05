#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct PersistedVehicle
{
    std::string vehicleId;
    double latitude;
    double longitude;
    double speed;
    std::string lastUpdated;
    bool isOnline;
    std::int64_t lastLocationAt;
};

struct PersistedAccident
{
    std::uint64_t id;
    int impactScore;
    std::string severity;
    std::string timestamp;
    double latitude;
    double longitude;
    bool hasLocation;
    bool processed;
};

class PostgresDatabase
{
public:
    PostgresDatabase() = default;
    ~PostgresDatabase();

    PostgresDatabase(const PostgresDatabase &) = delete;
    PostgresDatabase &operator=(const PostgresDatabase &) = delete;

    bool connectFromEnvironment(std::string &error);
    bool isEnabled() const;

    bool registerVehicle(const std::string &vehicleId, std::string &error);
    bool insertLocation(const std::string &vehicleId, double latitude,
                        double longitude, double speed, std::string &error);
    bool insertAccident(int impactScore, const std::string &severity,
                        const std::string &collisionType, bool hasLocation,
                        double latitude, double longitude, std::uint64_t &id,
                        std::string &error);
    bool updateAccidentProcessed(std::uint64_t id, std::string &error);
    bool insertSensorReading(const std::string &vehicleId,
                             double accelerationX, double accelerationY,
                             double accelerationZ, double gyroscopeX,
                             double gyroscopeY, double gyroscopeZ,
                             std::string &error);
    bool loadVehicles(std::vector<PersistedVehicle> &vehicles,
                      std::string &error);
    bool loadAccidents(std::vector<PersistedAccident> &accidents,
                       std::string &error);

private:
    void *connection_ = nullptr;
};
