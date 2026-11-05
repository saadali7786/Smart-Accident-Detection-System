#include "database.h"

#include <cstdlib>
#include <iostream>

#ifdef SAD_WITH_POSTGRESQL
#include <libpq-fe.h>
#endif

PostgresDatabase::~PostgresDatabase()
{
#ifdef SAD_WITH_POSTGRESQL
    if (connection_ != nullptr)
    {
        PQfinish(static_cast<PGconn *>(connection_));
    }
#endif
}

bool PostgresDatabase::connectFromEnvironment(std::string &error)
{
    const char *host = std::getenv("PGHOST");
    const char *port = std::getenv("PGPORT");
    const char *database = std::getenv("PGDATABASE");
    const char *user = std::getenv("PGUSER");
    const char *password = std::getenv("PGPASSWORD");
    const char *sslMode = std::getenv("PGSSLMODE");

    const bool configured =
        (host != nullptr && *host != '\0') ||
        (port != nullptr && *port != '\0') ||
        (database != nullptr && *database != '\0') ||
        (user != nullptr && *user != '\0') ||
        (password != nullptr && *password != '\0') ||
        (sslMode != nullptr && *sslMode != '\0');

    if (!configured)
    {
        return true;
    }

    if (database == nullptr || *database == '\0' ||
        user == nullptr || *user == '\0')
    {
        error = "PGDATABASE and PGUSER are required when PostgreSQL is configured.";
        return false;
    }

#ifndef SAD_WITH_POSTGRESQL
    error = "This build does not include libpq. Install PostgreSQL development files and rebuild.";
    return false;
#else
    const char *keywords[] = {
        "host", "port", "dbname", "user", "password", "sslmode",
        "application_name", nullptr};
    const char *values[] = {
        host, port, database, user, password, sslMode,
        "SmartAccidentDetection", nullptr};
    PGconn *connection = PQconnectdbParams(keywords, values, 0);

    if (connection == nullptr || PQstatus(connection) != CONNECTION_OK)
    {
        error = connection == nullptr ? "Could not allocate a PostgreSQL connection."
                                      : PQerrorMessage(connection);
        if (connection != nullptr)
        {
            PQfinish(connection);
        }
        return false;
    }

    connection_ = connection;
    return true;
#endif
}

bool PostgresDatabase::isEnabled() const
{
    return connection_ != nullptr;
}

bool PostgresDatabase::registerVehicle(const std::string &vehicleId,
                                       std::string &error)
{
#ifdef SAD_WITH_POSTGRESQL
    const char *values[] = {vehicleId.c_str()};
    PGresult *result = PQexecParams(
        static_cast<PGconn *>(connection_),
        "INSERT INTO vehicles (vehicle_id) VALUES ($1) "
        "ON CONFLICT (vehicle_id) DO NOTHING",
        1, nullptr, values, nullptr, nullptr, 0);
    if (result == nullptr || PQresultStatus(result) != PGRES_COMMAND_OK)
    {
        error = result == nullptr ? PQerrorMessage(static_cast<PGconn *>(connection_))
                                 : PQresultErrorMessage(result);
        if (result != nullptr) PQclear(result);
        return false;
    }

    const bool inserted = std::string(PQcmdTuples(result)) == "1";
    PQclear(result);
    if (!inserted) error = "Vehicle ID already exists in PostgreSQL.";
    return inserted;
#else
    (void)vehicleId;
    error = "PostgreSQL support is not available in this build.";
    return false;
#endif
}

bool PostgresDatabase::insertLocation(const std::string &vehicleId,
                                      double latitude, double longitude,
                                      double speed, std::string &error)
{
#ifdef SAD_WITH_POSTGRESQL
    const std::string latitudeText = std::to_string(latitude);
    const std::string longitudeText = std::to_string(longitude);
    const std::string speedText = std::to_string(speed);
    const char *values[] = {vehicleId.c_str(), latitudeText.c_str(),
                            longitudeText.c_str(), speedText.c_str()};
    PGresult *result = PQexecParams(
        static_cast<PGconn *>(connection_),
        "INSERT INTO gps_locations (vehicle_id, latitude, longitude, speed) "
        "VALUES ($1, $2::double precision, $3::double precision, "
        "$4::double precision)",
        4, nullptr, values, nullptr, nullptr, 0);
    if (result == nullptr || PQresultStatus(result) != PGRES_COMMAND_OK)
    {
        error = result == nullptr ? PQerrorMessage(static_cast<PGconn *>(connection_))
                                 : PQresultErrorMessage(result);
        if (result != nullptr) PQclear(result);
        return false;
    }
    PQclear(result);
    return true;
#else
    (void)vehicleId;
    (void)latitude;
    (void)longitude;
    (void)speed;
    error = "PostgreSQL support is not available in this build.";
    return false;
#endif
}

bool PostgresDatabase::insertAccident(int impactScore,
                                      const std::string &severity,
                                      const std::string &collisionType,
                                      bool hasLocation, double latitude,
                                      double longitude, std::uint64_t &id,
                                      std::string &error)
{
#ifdef SAD_WITH_POSTGRESQL
    const std::string scoreText = std::to_string(impactScore);
    const std::string latitudeText = std::to_string(latitude);
    const std::string longitudeText = std::to_string(longitude);
    const char *values[] = {scoreText.c_str(), severity.c_str(),
                            collisionType.c_str(),
                            hasLocation ? latitudeText.c_str() : nullptr,
                            hasLocation ? longitudeText.c_str() : nullptr};
    PGresult *result = PQexecParams(
        static_cast<PGconn *>(connection_),
        "INSERT INTO accidents "
        "(impact_score, severity, collision_type, latitude, longitude) "
        "VALUES ($1::integer, $2, $3, $4::double precision, "
        "$5::double precision) RETURNING id",
        5, nullptr, values, nullptr, nullptr, 0);
    if (result == nullptr || PQresultStatus(result) != PGRES_TUPLES_OK ||
        PQntuples(result) != 1)
    {
        error = result == nullptr ? PQerrorMessage(static_cast<PGconn *>(connection_))
                                 : PQresultErrorMessage(result);
        if (result != nullptr) PQclear(result);
        return false;
    }

    id = static_cast<std::uint64_t>(
        std::strtoull(PQgetvalue(result, 0, 0), nullptr, 10));
    PQclear(result);
    return true;
#else
    (void)impactScore;
    (void)severity;
    (void)collisionType;
    (void)hasLocation;
    (void)latitude;
    (void)longitude;
    (void)id;
    error = "PostgreSQL support is not available in this build.";
    return false;
#endif
}

bool PostgresDatabase::updateAccidentProcessed(std::uint64_t id,
                                               std::string &error)
{
#ifdef SAD_WITH_POSTGRESQL
    const std::string idText = std::to_string(id);
    const char *values[] = {idText.c_str()};
    PGresult *result = PQexecParams(
        static_cast<PGconn *>(connection_),
        "UPDATE accidents SET status = 'Processed' "
        "WHERE id = $1::bigint AND status = 'Pending'",
        1, nullptr, values, nullptr, nullptr, 0);
    if (result == nullptr || PQresultStatus(result) != PGRES_COMMAND_OK)
    {
        error = result == nullptr ? PQerrorMessage(static_cast<PGconn *>(connection_))
                                 : PQresultErrorMessage(result);
        if (result != nullptr) PQclear(result);
        return false;
    }

    const bool updated = std::string(PQcmdTuples(result)) == "1";
    PQclear(result);
    if (!updated) error = "Pending accident was not found in PostgreSQL.";
    return updated;
#else
    (void)id;
    error = "PostgreSQL support is not available in this build.";
    return false;
#endif
}

bool PostgresDatabase::insertSensorReading(
    const std::string &vehicleId, double accelerationX, double accelerationY,
    double accelerationZ, double gyroscopeX, double gyroscopeY,
    double gyroscopeZ, std::string &error)
{
#ifdef SAD_WITH_POSTGRESQL
    const std::string accelerationXText = std::to_string(accelerationX);
    const std::string accelerationYText = std::to_string(accelerationY);
    const std::string accelerationZText = std::to_string(accelerationZ);
    const std::string gyroscopeXText = std::to_string(gyroscopeX);
    const std::string gyroscopeYText = std::to_string(gyroscopeY);
    const std::string gyroscopeZText = std::to_string(gyroscopeZ);
    const char *values[] = {
        vehicleId.c_str(), accelerationXText.c_str(), accelerationYText.c_str(),
        accelerationZText.c_str(), gyroscopeXText.c_str(), gyroscopeYText.c_str(),
        gyroscopeZText.c_str()};
    PGresult *result = PQexecParams(
        static_cast<PGconn *>(connection_),
        "INSERT INTO sensor_readings "
        "(vehicle_id, acceleration_x, acceleration_y, acceleration_z, "
        "gyroscope_x, gyroscope_y, gyroscope_z) "
        "VALUES ($1, $2::double precision, $3::double precision, "
        "$4::double precision, $5::double precision, $6::double precision, "
        "$7::double precision)",
        7, nullptr, values, nullptr, nullptr, 0);
    if (result == nullptr || PQresultStatus(result) != PGRES_COMMAND_OK)
    {
        error = result == nullptr ? PQerrorMessage(static_cast<PGconn *>(connection_))
                                 : PQresultErrorMessage(result);
        if (result != nullptr) PQclear(result);
        return false;
    }
    PQclear(result);
    return true;
#else
    (void)vehicleId;
    (void)accelerationX;
    (void)accelerationY;
    (void)accelerationZ;
    (void)gyroscopeX;
    (void)gyroscopeY;
    (void)gyroscopeZ;
    error = "PostgreSQL support is not available in this build.";
    return false;
#endif
}

bool PostgresDatabase::loadVehicles(std::vector<PersistedVehicle> &vehicles,
                                    std::string &error)
{
#ifdef SAD_WITH_POSTGRESQL
    PGresult *result = PQexec(
        static_cast<PGconn *>(connection_),
        "SELECT v.vehicle_id, "
        "COALESCE(location.latitude, 0)::text, "
        "COALESCE(location.longitude, 0)::text, "
        "COALESCE(location.speed, 0)::text, "
        "COALESCE(to_char(location.recorded_at, "
        "'YYYY-MM-DD HH24:MI:SS TZ'), 'Not updated'), "
        "COALESCE(EXTRACT(EPOCH FROM location.recorded_at)::bigint, 0)::text, "
        "COALESCE(location.recorded_at >= now() - interval '10 seconds', false)::text "
        "FROM vehicles v "
        "LEFT JOIN LATERAL ("
        "  SELECT latitude, longitude, speed, recorded_at "
        "  FROM gps_locations WHERE vehicle_id = v.vehicle_id "
        "  ORDER BY recorded_at DESC, id DESC LIMIT 1"
        ") location ON true "
        "WHERE v.is_active = true ORDER BY v.created_at, v.vehicle_id");
    if (result == nullptr || PQresultStatus(result) != PGRES_TUPLES_OK)
    {
        error = result == nullptr ? PQerrorMessage(static_cast<PGconn *>(connection_))
                                 : PQresultErrorMessage(result);
        if (result != nullptr) PQclear(result);
        return false;
    }

    vehicles.clear();
    for (int row = 0; row < PQntuples(result); ++row)
    {
        PersistedVehicle vehicle{};
        vehicle.vehicleId = PQgetvalue(result, row, 0);
        vehicle.latitude = std::strtod(PQgetvalue(result, row, 1), nullptr);
        vehicle.longitude = std::strtod(PQgetvalue(result, row, 2), nullptr);
        vehicle.speed = std::strtod(PQgetvalue(result, row, 3), nullptr);
        vehicle.lastUpdated = PQgetvalue(result, row, 4);
        vehicle.lastLocationAt = std::strtoll(PQgetvalue(result, row, 5), nullptr, 10);
        vehicle.isOnline = std::string(PQgetvalue(result, row, 6)) == "true";
        vehicles.push_back(vehicle);
    }
    PQclear(result);
    return true;
#else
    (void)vehicles;
    error = "PostgreSQL support is not available in this build.";
    return false;
#endif
}

bool PostgresDatabase::loadAccidents(
    std::vector<PersistedAccident> &accidents, std::string &error)
{
#ifdef SAD_WITH_POSTGRESQL
    PGresult *result = PQexec(
        static_cast<PGconn *>(connection_),
        "SELECT id::text, impact_score::text, severity, "
        "to_char(detected_at, 'YYYY-MM-DD HH24:MI:SS TZ'), "
        "latitude::text, longitude::text, status "
        "FROM accidents ORDER BY id");
    if (result == nullptr || PQresultStatus(result) != PGRES_TUPLES_OK)
    {
        error = result == nullptr ? PQerrorMessage(static_cast<PGconn *>(connection_))
                                 : PQresultErrorMessage(result);
        if (result != nullptr) PQclear(result);
        return false;
    }

    accidents.clear();
    for (int row = 0; row < PQntuples(result); ++row)
    {
        PersistedAccident accident{};
        accident.id = static_cast<std::uint64_t>(
            std::strtoull(PQgetvalue(result, row, 0), nullptr, 10));
        accident.impactScore = std::atoi(PQgetvalue(result, row, 1));
        accident.severity = PQgetvalue(result, row, 2);
        accident.timestamp = PQgetvalue(result, row, 3);
        accident.hasLocation =
            !PQgetisnull(result, row, 4) && !PQgetisnull(result, row, 5);
        accident.latitude = accident.hasLocation
                                ? std::strtod(PQgetvalue(result, row, 4), nullptr)
                                : 0;
        accident.longitude = accident.hasLocation
                                 ? std::strtod(PQgetvalue(result, row, 5), nullptr)
                                 : 0;
        accident.processed = std::string(PQgetvalue(result, row, 6)) == "Processed";
        accidents.push_back(accident);
    }
    PQclear(result);
    return true;
#else
    (void)accidents;
    error = "PostgreSQL support is not available in this build.";
    return false;
#endif
}
