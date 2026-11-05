
#define _WIN32_WINNT 0x0600
#define NOMINMAX

#include "database.h"

#include <iostream>
#include <algorithm>
#include <vector>
#include <stack>
#include <queue>
#include <ctime>
#include <cmath>
#include <string>
#include <sstream>
#include <cstdint>
#include <cstdlib>
#include <winsock2.h>
#include <ws2tcpip.h>

#pragma comment(lib, "ws2_32.lib")

using namespace std;
// ================= DSA: ACCIDENT EVENT MANAGEMENT =================

struct AccidentEvent
{
    std::uint64_t id;
    int impactScore;
    string severity;
    string timestamp;

    double latitude;
    double longitude;
    bool hasLocation;

    bool processed;
};

// Priority Queue: Higher impact score gets higher priority.
struct ComparePriority
{
    bool operator()(const AccidentEvent &a, const AccidentEvent &b)
    {
        return a.impactScore < b.impactScore;
    }
};

priority_queue<AccidentEvent, vector<AccidentEvent>, ComparePriority> priorityAccidentQueue;

// Queue: processes accident events in FIFO order.
queue<AccidentEvent> accidentQueue;

// Stack: stores the most recent severe accident events.
stack<AccidentEvent> severeAccidentStack;

// Stores accident records independently of the Queue.
vector<AccidentEvent> accidentHistory;

// Accident IDs start from 1.
std::uint64_t nextAccidentId = 1;

// Maximum number of records retained in memory.
const size_t MAX_HISTORY = 100;

unsigned long processedAccidentEvents = 0;
unsigned long totalEnqueuedEvents = 0;

// ================= REGISTERED VEHICLE TRACKING =================

struct RegisteredVehicle
{
    string vehicleId;

    double latitude;
    double longitude;
    double speed;

    string lastUpdated;
    bool isOnline;
    time_t lastLocationAt;
};

// Stores all registered vehicles.
vector<RegisteredVehicle> registeredVehicles;
const time_t VEHICLE_OFFLINE_TIMEOUT_SECONDS = 10;
PostgresDatabase database;

void pushSevereEvent(const AccidentEvent &event);

// Update Priority Queue with pending accidents.
void updatePriorityQueue()
{
    while (!priorityAccidentQueue.empty())
    {
        priorityAccidentQueue.pop();
    }

    queue<AccidentEvent> pendingEvents = accidentQueue;
    while (!pendingEvents.empty())
    {
        const AccidentEvent event = pendingEvents.front();
        pendingEvents.pop();
        if (!event.processed)
        {
            priorityAccidentQueue.push(event);
        }
    }
}

string getCurrentTimestamp()
{
    time_t now = time(nullptr);
    string timestamp = ctime(&now);

    if (!timestamp.empty() && timestamp[timestamp.size() - 1] == '\n')
    {
        timestamp.erase(timestamp.size() - 1);
    }

    return timestamp;
}

bool loadPersistentState(std::string &error)
{
    std::vector<PersistedVehicle> vehicles;
    std::vector<PersistedAccident> accidents;
    if (!database.loadVehicles(vehicles, error) ||
        !database.loadAccidents(accidents, error))
    {
        return false;
    }

    registeredVehicles.clear();
    for (const PersistedVehicle &stored : vehicles)
    {
        RegisteredVehicle vehicle{};
        vehicle.vehicleId = stored.vehicleId;
        vehicle.latitude = stored.latitude;
        vehicle.longitude = stored.longitude;
        vehicle.speed = stored.speed;
        vehicle.lastUpdated = stored.lastUpdated;
        vehicle.isOnline = stored.isOnline;
        vehicle.lastLocationAt = static_cast<time_t>(stored.lastLocationAt);
        registeredVehicles.push_back(vehicle);
    }

    accidentHistory.clear();
    accidentQueue = queue<AccidentEvent>();
    severeAccidentStack = stack<AccidentEvent>();
    priorityAccidentQueue =
        priority_queue<AccidentEvent, vector<AccidentEvent>, ComparePriority>();
    processedAccidentEvents = 0;
    totalEnqueuedEvents = 0;
    nextAccidentId = 1;

    for (const PersistedAccident &stored : accidents)
    {
        AccidentEvent event{};
        event.id = stored.id;
        event.impactScore = stored.impactScore;
        event.severity = stored.severity;
        event.timestamp = stored.timestamp;
        event.latitude = stored.latitude;
        event.longitude = stored.longitude;
        event.hasLocation = stored.hasLocation;
        event.processed = stored.processed;

        if (event.processed)
        {
            ++processedAccidentEvents;
            if (event.severity == "Severe")
            {
                pushSevereEvent(event);
            }
        }
        else
        {
            accidentQueue.push(event);
        }
        ++totalEnqueuedEvents;

        if (accidentHistory.size() >= MAX_HISTORY)
        {
            accidentHistory.erase(accidentHistory.begin());
        }
        accidentHistory.push_back(event);

        if (event.id >= nextAccidentId)
        {
            nextAccidentId = event.id + 1;
        }
    }

    updatePriorityQueue();
    return true;
}

// ================= VEHICLE REGISTRATION =================

bool registerVehicle(const string &vehicleId)
{
    // Check whether vehicle ID is empty.
    if (vehicleId.empty())
    {
        return false;
    }

    // Check whether vehicle is already registered.
    for (const auto &vehicle : registeredVehicles)
    {
        if (vehicle.vehicleId == vehicleId)
        {
            return false;
        }
    }

    // Create a new vehicle record.
    RegisteredVehicle newVehicle;

    newVehicle.vehicleId = vehicleId;
    newVehicle.latitude = 0;
    newVehicle.longitude = 0;
    newVehicle.speed = 0;
    newVehicle.lastUpdated = "Not updated";
    newVehicle.isOnline = false;
    newVehicle.lastLocationAt = 0;

    // Store vehicle in the vector.
    registeredVehicles.push_back(newVehicle);

    return true;
}
// Binary Decision Tree
struct TreeNode
{
    int threshold;
    string result;
    int yes;
    int no;
};

// Tree nodes
TreeNode severityTree[] =
    {
        {75, "", 1, 2},
        {0, "Severe", -1, -1},
        {42, "", 3, 4},
        {0, "Moderate", -1, -1},
        {18, "", 5, 6},
        {0, "Minor", -1, -1},
        {0, "No Accident", -1, -1}};

// Traverse the tree recursively
string decisionTree(int score, int node = 0)
{
    if (severityTree[node].result != "")
    {
        return severityTree[node].result;
    }

    if (score >= severityTree[node].threshold)
    {
        return decisionTree(score, severityTree[node].yes);
    }

    return decisionTree(score, severityTree[node].no);
}

// Store severe accident in Stack
void pushSevereEvent(const AccidentEvent &event)
{
    severeAccidentStack.push(event);
}

string getResponse(int status, const string &body)
{
    stringstream response;
    response << "HTTP/1.1 " << status
             << (status == 200 ? " OK"
                               : status == 400 ? " Bad Request"
                                               : status == 503 ? " Service Unavailable"
                                                               : " Internal Server Error")
             << "\r\n"
             << "Content-Type: application/json\r\n"
             << "Access-Control-Allow-Origin: *\r\n"
             << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
             << "Access-Control-Allow-Headers: Content-Type\r\n"
             << "Connection: close\r\n"
             << "Content-Length: " << body.size() << "\r\n\r\n"
             << body;
    return response.str();
}

double readSpeed(const string &body, const string &key)
{
    size_t pos = body.find("\"" + key + "\"");
    if (pos == string::npos)
        return -1;

    pos = body.find(':', pos);
    if (pos == string::npos)
        return -1;

    try
    {
        return stod(body.substr(pos + 1));
    }
    catch (...)
    {
        return -1;
    }
}

bool readFiniteNumber(const string &body, const string &key, double &value)
{
    const size_t keyPosition = body.find("\"" + key + "\"");
    if (keyPosition == string::npos)
    {
        return false;
    }

    const size_t colon = body.find(':', keyPosition);
    if (colon == string::npos)
    {
        return false;
    }

    const char *start = body.c_str() + colon + 1;
    while (*start == ' ' || *start == '\t' || *start == '\r' || *start == '\n')
    {
        ++start;
    }
    if (*start != '-' && (*start < '0' || *start > '9'))
    {
        return false;
    }

    char *end = nullptr;
    value = std::strtod(start, &end);
    if (end == start || !std::isfinite(value))
    {
        return false;
    }
    while (*end == ' ' || *end == '\t' || *end == '\r' || *end == '\n')
    {
        ++end;
    }
    return *end == ',' || *end == '}';
}

// Read a string value from JSON.
string readString(const string &body, const string &key)
{
    size_t pos = body.find("\"" + key + "\"");

    if (pos == string::npos)
        return "";

    pos = body.find(':', pos);

    if (pos == string::npos)
        return "";

    pos = body.find('"', pos);

    if (pos == string::npos)
        return "";

    size_t end = body.find('"', pos + 1);

    if (end == string::npos)
        return "";

    return body.substr(pos + 1, end - pos - 1);
}

string processRequest(const string &request)
{
    size_t headerEnd = request.find("\r\n\r\n");
    if (headerEnd == string::npos)
    {
        return getResponse(400, R"({"error":"Invalid HTTP request"})");
    }

    string headers = request.substr(0, headerEnd);
    string body = request.substr(headerEnd + 4);

    if (headers.find("OPTIONS ") == 0)
    {
        return getResponse(200, "{}");
    }

    // DSA status endpoint
    if (headers.find("GET /api/dsa/status ") == 0)
    {
        string latestSevereEvent = "null";

        string highestPriorityEvent = "null";

        if (!priorityAccidentQueue.empty())
        {
            AccidentEvent highest = priorityAccidentQueue.top();

            highestPriorityEvent =
                "{\"id\":" + to_string(highest.id) +
                ",\"impactScore\":" + to_string(highest.impactScore) +
                ",\"severity\":\"" + highest.severity + "\"}";
        }

        if (!severeAccidentStack.empty())
        {
            AccidentEvent latest = severeAccidentStack.top();

            latestSevereEvent =
                "{\"id\":" + to_string(latest.id) +
                ",\"impactScore\":" + to_string(latest.impactScore) +
                ",\"severity\":\"" + latest.severity + "\"" +
                ",\"timestamp\":\"" + latest.timestamp + "\"}";
        }

        // Copy Queue to display its contents without removing events.
        queue<AccidentEvent> queueCopy = accidentQueue;

        string queueEvents = "[";

        bool firstQueueEvent = true;

        while (!queueCopy.empty())
        {
            AccidentEvent event = queueCopy.front();
            queueCopy.pop();

            if (!firstQueueEvent)
            {
                queueEvents += ",";
            }

            queueEvents +=
                "{\"id\":" + to_string(event.id) +
                ",\"impactScore\":" + to_string(event.impactScore) +
                ",\"severity\":\"" + event.severity + "\"" +
                ",\"timestamp\":\"" + event.timestamp + "\"}";

            firstQueueEvent = false;
        }

        queueEvents += "]";

        // Copy Stack to display its contents without removing events.
        stack<AccidentEvent> stackCopy = severeAccidentStack;

        string stackEvents = "[";

        bool firstStackEvent = true;

        while (!stackCopy.empty())
        {
            AccidentEvent event = stackCopy.top();
            stackCopy.pop();

            if (!firstStackEvent)
            {
                stackEvents += ",";
            }

            stackEvents +=
                "{\"id\":" + to_string(event.id) +
                ",\"impactScore\":" + to_string(event.impactScore) +
                ",\"severity\":\"" + event.severity + "\"" +
                ",\"timestamp\":\"" + event.timestamp + "\"}";

            firstStackEvent = false;
        }

        stackEvents += "]";

        string status =
            "{\"queueSize\":" + to_string(accidentQueue.size()) +
            ",\"severeStackSize\":" + to_string(severeAccidentStack.size()) +
            ",\"processedEvents\":" + to_string(processedAccidentEvents) +
            ",\"totalEnqueuedEvents\":" + to_string(totalEnqueuedEvents) +
            ",\"latestSevereEvent\":" + latestSevereEvent +
            ",\"queueEvents\":" + queueEvents +
            ",\"stackEvents\":" + stackEvents +
            ",\"highestPriorityEvent\":" + highestPriorityEvent + "}";

        return getResponse(200, status);
    }
    // GET: Accident History
    if (headers.find("GET /api/accidents/history ") == 0)
    {
        std::vector<PersistedAccident> persistedAccidents;
        std::string databaseError;
        if (database.isEnabled() &&
            !database.loadAccidents(persistedAccidents, databaseError))
        {
            cerr << "PostgreSQL accident history query failed: "
                 << databaseError << '\n';
            return getResponse(
                503, R"({"success":false,"error":"Accident history is temporarily unavailable"})");
        }

        const size_t totalRecords = database.isEnabled()
                                        ? persistedAccidents.size()
                                        : accidentHistory.size();
        string history = "{\"success\":true,\"totalRecords\":" +
                         to_string(totalRecords) +
                         ",\"accidents\":[";

        for (size_t i = 0; i < totalRecords; i++)
        {
            const bool fromDatabase = database.isEnabled();
            const std::uint64_t id = fromDatabase ? persistedAccidents[i].id
                                                  : accidentHistory[i].id;
            const int impactScore = fromDatabase
                                        ? persistedAccidents[i].impactScore
                                        : accidentHistory[i].impactScore;
            const string &severity = fromDatabase
                                         ? persistedAccidents[i].severity
                                         : accidentHistory[i].severity;
            const string &timestamp = fromDatabase
                                          ? persistedAccidents[i].timestamp
                                          : accidentHistory[i].timestamp;
            const bool hasLocation = fromDatabase
                                         ? persistedAccidents[i].hasLocation
                                         : accidentHistory[i].hasLocation;
            const double latitude = fromDatabase
                                        ? persistedAccidents[i].latitude
                                        : accidentHistory[i].latitude;
            const double longitude = fromDatabase
                                         ? persistedAccidents[i].longitude
                                         : accidentHistory[i].longitude;
            const bool processed = fromDatabase
                                       ? persistedAccidents[i].processed
                                       : accidentHistory[i].processed;

            if (i > 0)
            {
                history += ",";
            }

            history +=
                "{\"id\":" + to_string(id) +
                ",\"impactScore\":" + to_string(impactScore) +
                ",\"severity\":\"" + severity + "\"" +
                ",\"timestamp\":\"" + timestamp + "\"" +
                ",\"hasLocation\":" + string(hasLocation ? "true" : "false") +
                ",\"latitude\":" + (hasLocation ? to_string(latitude) : "null") +
                ",\"longitude\":" + (hasLocation ? to_string(longitude) : "null") +
                ",\"status\":\"" +
                string(processed ? "Processed" : "Pending") +
                "\"}";
        }

        history += "]}";

        return getResponse(200, history);
    }

    // Process the oldest pending accident event.
    if (headers.find("POST /api/dsa/process ") == 0)
    {

        if (accidentQueue.empty())
        {
            return getResponse(200,
                               R"({"success":true,"message":"Queue is empty"})");
        }

        // FIFO: retrieve and remove the oldest event.
        AccidentEvent currentEvent = accidentQueue.front();
        std::string databaseError;
        if (database.isEnabled() &&
            !database.updateAccidentProcessed(currentEvent.id, databaseError))
        {
            cerr << "PostgreSQL accident status update failed: "
                 << databaseError << '\n';
            return getResponse(
                503, R"({"success":false,"error":"Accident could not be processed"})");
        }
        accidentQueue.pop();

        // Update the corresponding history record.
        for (size_t i = 0; i < accidentHistory.size(); i++)
        {
            if (accidentHistory[i].id == currentEvent.id)
            {
                accidentHistory[i].processed = true;
                break;
            }
        }

        processedAccidentEvents++;
        updatePriorityQueue();

        // Store severe events in the LIFO stack.
        if (currentEvent.severity == "Severe")
        {
            pushSevereEvent(currentEvent);
        }

        string result =
            "{\"success\":true,"
            "\"message\":\"Accident event processed successfully\","
            "\"processedEventId\":" +
            to_string(currentEvent.id) +
            "}";

        return getResponse(200, result);
    }

    // ================= VEHICLE REGISTRATION API =================

    if (headers.find("POST /api/vehicles/register ") == 0)
    {
        string vehicleId = readString(body, "vehicleId");

        if (vehicleId.empty() || vehicleId.size() > 40)
        {
            return getResponse(400,
                               R"({"success":false,"error":"Invalid vehicle ID"})");
        }

        // Allow only letters, numbers, hyphens and underscores.
        for (char c : vehicleId)
        {
            if (!isalnum(static_cast<unsigned char>(c)) &&
                c != '-' && c != '_')
            {
                return getResponse(400,
                                   R"({"success":false,"error":"Invalid characters in vehicle ID"})");
            }
        }

        for (const auto &vehicle : registeredVehicles)
        {
            if (vehicle.vehicleId == vehicleId)
            {
                return getResponse(
                    400, R"({"success":false,"error":"Vehicle already registered or invalid"})");
            }
        }

        std::string databaseError;
        if (database.isEnabled() &&
            !database.registerVehicle(vehicleId, databaseError))
        {
            cerr << "PostgreSQL vehicle registration failed: "
                 << databaseError << '\n';
            return getResponse(
                databaseError == "Vehicle ID already exists in PostgreSQL." ? 400 : 503,
                databaseError == "Vehicle ID already exists in PostgreSQL."
                    ? R"({"success":false,"error":"Vehicle already registered or invalid"})"
                    : R"({"success":false,"error":"Vehicle could not be saved"})");
        }

        if (!registerVehicle(vehicleId))
        {
            return getResponse(400,
                               R"({"success":false,"error":"Vehicle already registered or invalid"})");
        }

        string result =
            "{\"success\":true,"
            "\"message\":\"Vehicle registered successfully\","
            "\"vehicleId\":\"" +
            vehicleId + "\"}";

        return getResponse(200, result);
    }

    // ================= GPS LOCATION UPDATE API =================

    if (headers.find("POST /api/vehicles/location ") == 0)
    {
        string vehicleId = readString(body, "vehicleId");

        double latitude = readSpeed(body, "latitude");
        double longitude = readSpeed(body, "longitude");
        double speed = readSpeed(body, "speed");

        if (vehicleId.empty())
        {
            return getResponse(400,
                               R"({"success":false,"error":"Vehicle ID is required"})");
        }

        if (!std::isfinite(latitude) || !std::isfinite(longitude) ||
            !std::isfinite(speed) ||
            latitude < -90 || latitude > 90 ||
            longitude < -180 || longitude > 180 ||
            speed < 0 || speed > 300)
        {
            return getResponse(400,
                               R"({"success":false,"error":"Invalid GPS or speed values"})");
        }

        auto vehicle = std::find_if(
            registeredVehicles.begin(), registeredVehicles.end(),
            [&vehicleId](const RegisteredVehicle &candidate)
            {
                return candidate.vehicleId == vehicleId;
            });
        if (vehicle == registeredVehicles.end())
        {
            return getResponse(400,
                               R"({"success":false,"error":"Vehicle is not registered"})");
        }

        std::string databaseError;
        if (database.isEnabled() &&
            !database.insertLocation(vehicleId, latitude, longitude, speed,
                                     databaseError))
        {
            cerr << "PostgreSQL GPS location insert failed: "
                 << databaseError << '\n';
            return getResponse(
                503, R"({"success":false,"error":"GPS update could not be saved"})");
        }

        vehicle->latitude = latitude;
        vehicle->longitude = longitude;
        vehicle->speed = speed;
        vehicle->lastUpdated = getCurrentTimestamp();
        vehicle->isOnline = true;
        vehicle->lastLocationAt = time(nullptr);

        string result =
            "{\"success\":true,"
            "\"message\":\"GPS location updated\","
            "\"vehicleId\":\"" +
            vehicleId + "\","
                        "\"latitude\":" +
            to_string(latitude) + ","
                                  "\"longitude\":" +
            to_string(longitude) + ","
                                   "\"speed\":" +
            to_string(speed) + "}";

        return getResponse(200, result);
    }

    // ================= GET REGISTERED VEHICLES API =================

if (headers.find("GET /api/vehicles ") == 0)
{
    std::vector<PersistedVehicle> persistedVehicles;
    std::string databaseError;
    if (database.isEnabled() &&
        !database.loadVehicles(persistedVehicles, databaseError))
    {
        cerr << "PostgreSQL vehicle query failed: " << databaseError << '\n';
        return getResponse(
            503, R"({"success":false,"error":"Vehicle list is temporarily unavailable"})");
    }

    const size_t vehicleCount =
        database.isEnabled() ? persistedVehicles.size() : registeredVehicles.size();
    string result =
        "{\"success\":true,"
        "\"totalVehicles\":" +
        to_string(vehicleCount) +
        ",\"vehicles\":[";

    for (size_t i = 0; i < vehicleCount; i++)
    {
        const bool fromDatabase = database.isEnabled();
        const std::string &vehicleId = fromDatabase
                                           ? persistedVehicles[i].vehicleId
                                           : registeredVehicles[i].vehicleId;
        const double latitude = fromDatabase ? persistedVehicles[i].latitude
                                             : registeredVehicles[i].latitude;
        const double longitude = fromDatabase ? persistedVehicles[i].longitude
                                              : registeredVehicles[i].longitude;
        const double speed = fromDatabase ? persistedVehicles[i].speed
                                          : registeredVehicles[i].speed;
        const std::string &lastUpdated = fromDatabase
                                             ? persistedVehicles[i].lastUpdated
                                             : registeredVehicles[i].lastUpdated;
        const bool isOnline = fromDatabase
                                  ? persistedVehicles[i].isOnline
                                  : registeredVehicles[i].isOnline &&
                                        registeredVehicles[i].lastLocationAt != 0 &&
                                        difftime(time(nullptr),
                                                 registeredVehicles[i].lastLocationAt) >= 0 &&
                                        difftime(time(nullptr),
                                                 registeredVehicles[i].lastLocationAt) <=
                                            VEHICLE_OFFLINE_TIMEOUT_SECONDS;

        if (i > 0)
            result += ",";

        result +=
            "{\"vehicleId\":\"" + vehicleId + "\","
            "\"latitude\":" + to_string(latitude) + ","
            "\"longitude\":" + to_string(longitude) + ","
            "\"speed\":" + to_string(speed) + ","
            "\"lastUpdated\":\"" + lastUpdated + "\","
            "\"isOnline\":" + string(isOnline ? "true" : "false") +
            "}";
    }

    result += "]}";

    return getResponse(200, result);
}

    if (headers.find("POST /api/vehicles/sensor-data ") == 0)
    {
        const string vehicleId = readString(body, "vehicleId");
        const char *sensorFields[] = {
            "accelerationX", "accelerationY", "accelerationZ",
            "gyroscopeX", "gyroscopeY", "gyroscopeZ"};
        double sensorValues[6];
        for (size_t i = 0; i < 6; ++i)
        {
            const string field = string("\"") + sensorFields[i] + "\"";
            if (body.find(field) == string::npos)
            {
                return getResponse(
                    400, R"({"success":false,"error":"All six sensor values are required"})");
            }
            if (!readFiniteNumber(body, sensorFields[i], sensorValues[i]) ||
                std::abs(sensorValues[i]) > 100000)
            {
                return getResponse(
                    400, R"({"success":false,"error":"Invalid sensor reading"})");
            }
        }
        if (vehicleId.empty())
        {
            return getResponse(
                400, R"({"success":false,"error":"Vehicle ID is required"})");
        }
        if (!database.isEnabled())
        {
            return getResponse(
                503, R"({"success":false,"error":"Sensor storage requires PostgreSQL configuration"})");
        }

        std::string databaseError;
        if (!database.insertSensorReading(
                vehicleId, sensorValues[0], sensorValues[1], sensorValues[2],
                sensorValues[3], sensorValues[4], sensorValues[5],
                databaseError))
        {
            cerr << "PostgreSQL sensor reading insert failed: "
                 << databaseError << '\n';
            return getResponse(
                503, R"({"success":false,"error":"Sensor reading could not be saved"})");
        }
        return getResponse(
            200, R"({"success":true,"message":"Sensor reading saved"})");
    }

    if (headers.find("POST /api/accident ") != 0)
    {
        return getResponse(400, R"({"error":"Unknown endpoint"})");
    }

    // Read speeds from the JSON request body.
    double speedA = readSpeed(body, "speedA");
    double speedB = readSpeed(body, "speedB");
    double impactG = readSpeed(body, "impactG");

    // Read vehicle masses from the JSON request.
    double massA = readSpeed(body, "massA");
    double massB = readSpeed(body, "massB");

    // Read collision type.
    string collisionType = "unknown";

    if (body.find("\"collisionType\":\"head-on\"") != string::npos)
    {
        collisionType = "head-on";
    }
    else if (body.find("\"collisionType\":\"rear-end\"") != string::npos)
    {
        collisionType = "rear-end";
    }

    // Validate vehicle masses.
    if (!std::isfinite(massA) || !std::isfinite(massB) ||
        massA < 500 || massA > 3000 ||
        massB < 500 || massB > 3000)
    {
        return getResponse(400,
                           R"({"error":"Vehicle masses must be between 500 and 3000 kg"})");
    }

    // Validate collision type.
    if (collisionType == "unknown")
    {
        return getResponse(400,
                           R"({"error":"Invalid collision type"})");
    }

    // Read optional GPS coordinates.
    bool latitudeProvided =
        body.find("\"latitude\"") != string::npos;

    bool longitudeProvided =
        body.find("\"longitude\"") != string::npos;

    double latitude = readSpeed(body, "latitude");
    double longitude = readSpeed(body, "longitude");

    bool hasLocation = latitudeProvided && longitudeProvided;

    // Validate GPS coordinates if provided.
    if (latitudeProvided != longitudeProvided)
    {
        return getResponse(400,
                           R"({"error":"Both latitude and longitude are required"})");
    }

    if (hasLocation &&
        (!std::isfinite(latitude) || !std::isfinite(longitude) ||
         latitude < -90 || latitude > 90 ||
         longitude < -180 || longitude > 180))
    {
        return getResponse(400,
                           R"({"error":"Invalid GPS coordinates"})");
    }

    // Use 0 when the frontend does not send impactG yet.
    if (impactG < 0)
    {
        impactG = 0;
    }

    // Read more bytes if the request body is incomplete.
    size_t contentPos = headers.find("Content-Length:");
    if (contentPos != string::npos)
    {
        size_t lengthStart = contentPos + 15;
        while (lengthStart < headers.size() && headers[lengthStart] == ' ')
            ++lengthStart;
        size_t lengthEnd = headers.find("\r\n", lengthStart);
        int contentLength = stoi(headers.substr(lengthStart,
                                                lengthEnd - lengthStart));

        while (body.size() < static_cast<size_t>(contentLength))
        {
            // The caller normally collects the full request before processing.
            break;
        }
    }

    // Validate speed and impact sensor readings.
    if (!std::isfinite(speedA) || !std::isfinite(speedB) ||
        !std::isfinite(impactG) ||
        speedA < 0 || speedB < 0 ||
        speedA > 300 || speedB > 300 ||
        impactG < 0 || impactG > 10)
    {
        return getResponse(400,
                           R"({"error":"Speeds must be 0-300 and impactG must be 0-10"})");
    }

    // Convert vehicle speeds from km/h to m/s.
    double velocityA = speedA / 3.6;
    double velocityB = speedB / 3.6;

    // Assign directions based on collision type.
    if (collisionType == "head-on")
    {
        velocityB = -velocityB;
    }

    // Calculate combined velocity after collision.
    // Assumption: perfectly inelastic collision.
    double finalVelocity =
        (massA * velocityA + massB * velocityB) /
        (massA + massB);

    // Calculate Delta-V for both vehicles.
    double deltaVA = std::abs(finalVelocity - velocityA);
    double deltaVB = std::abs(finalVelocity - velocityB);

    // Find the maximum Delta-V.
    double maxDeltaV = (deltaVA > deltaVB) ? deltaVA : deltaVB;

    // Calculate speed-based score.
    // Calculate speed-based accident score.
    int score = min(100, static_cast<int>(
                             (speedA + speedB) * 1.25));
    // Decision Tree classification
    string severity = decisionTree(score);

    // Add the accident to the pending FIFO Queue.
    // Create a new accident record.
    AccidentEvent newEvent;

    std::string databaseError;
    if (database.isEnabled())
    {
        std::uint64_t storedId = 0;
        if (!database.insertAccident(score, severity, collisionType, hasLocation,
                                     latitude, longitude, storedId,
                                     databaseError))
        {
            cerr << "PostgreSQL accident insert failed: "
                 << databaseError << '\n';
            return getResponse(
                503, R"({"success":false,"error":"Accident could not be saved"})");
        }
        newEvent.id = storedId;
        nextAccidentId = std::max(nextAccidentId, storedId + 1);
    }
    else
    {
        newEvent.id = nextAccidentId++;
    }
    newEvent.impactScore = score;
    newEvent.severity = severity;
    newEvent.timestamp = getCurrentTimestamp();

    newEvent.latitude = latitude;
    newEvent.longitude = longitude;
    newEvent.hasLocation = hasLocation;

    newEvent.processed = false;

    // Add to pending FIFO Queue.
    accidentQueue.push(newEvent);

    // Save independently in accident history.
    if (accidentHistory.size() >= MAX_HISTORY)
    {
        accidentHistory.erase(accidentHistory.begin());
    }

    accidentHistory.push_back(newEvent);
    updatePriorityQueue();

    totalEnqueuedEvents++;

    cout << "Accident ID: " << newEvent.id
         << " | Severity: " << newEvent.severity
         << " | Status: Pending" << endl;

    bool alert = (severity == "Severe");
    string result =
        "{\"success\":true,"
        "\"impactScore\":" +
        to_string(score) + ","
                           "\"severity\":\"" +
        severity + "\","
                   "\"alertStatus\":\"" +
        string(alert ? "Emergency Alert Simulated" : "No Alert") + "\","
                                                                   "\"emergencyResponse\":{\"triggered\":" +
        string(alert ? "true" : "false") + ","
                                           "\"message\":\"" +
        string(alert ? "Simulated emergency notification generated"
                     : "No emergency notification needed") +
        "\"},"
        "\"note\":\"Simulation only. No real emergency services contacted.\"}";

    cout << "Score: " << score << " | Severity: " << severity << '\n';
    return getResponse(200, result);
}

int main()
{
    std::string databaseError;
    if (!database.connectFromEnvironment(databaseError))
    {
        cerr << "PostgreSQL startup failed: " << databaseError << '\n';
        return 1;
    }
    if (database.isEnabled())
    {
        if (!loadPersistentState(databaseError))
        {
            cerr << "Could not load PostgreSQL state. Verify that BE/schema.sql "
                    "has been applied: "
                 << databaseError << '\n';
            return 1;
        }
        cout << "PostgreSQL persistence enabled; restored "
             << registeredVehicles.size() << " vehicles and "
             << totalEnqueuedEvents
             << " accident records.\n";
    }
    else
    {
        cerr << "WARNING: PostgreSQL is not configured; running in memory-only "
                "mode. Changes will not survive a restart.\n";
    }

    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0)
    {
        cerr << "Could not initialize Windows networking.\n";
        return 1;
    }

    SOCKET serverSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (serverSocket == INVALID_SOCKET)
    {
        cerr << "Could not create server socket.\n";
        WSACleanup();
        return 1;
    }

    sockaddr_in serverAddress{};
    serverAddress.sin_family = AF_INET;
    serverAddress.sin_addr.s_addr = htonl(INADDR_ANY);
    unsigned long port = 8080;
    const char *portEnvironment = std::getenv("SAD_PORT");
    if (portEnvironment != nullptr && *portEnvironment != '\0')
    {
        char *end = nullptr;
        const unsigned long configuredPort = std::strtoul(portEnvironment, &end, 10);
        if (end == portEnvironment || *end != '\0' ||
            configuredPort == 0 || configuredPort > 65535)
        {
            cerr << "SAD_PORT must be an integer between 1 and 65535.\n";
            closesocket(serverSocket);
            WSACleanup();
            return 1;
        }
        port = configuredPort;
    }
    serverAddress.sin_port = htons(static_cast<u_short>(port));

    if (bind(serverSocket, reinterpret_cast<sockaddr *>(&serverAddress),
             sizeof(serverAddress)) == SOCKET_ERROR)
    {
        cerr << "Could not bind port 8080. Is another server using it?\n";
        closesocket(serverSocket);
        WSACleanup();
        return 1;
    }

    listen(serverSocket, SOMAXCONN);

    cout << "Smart Accident Detection Backend\n";
    cout << "Listening at http://localhost:" << port << '\n';
    cout << "Press Ctrl+C to stop.\n";

    while (true)
    {
        SOCKET client = accept(serverSocket, nullptr, nullptr);
        if (client == INVALID_SOCKET)
            continue;

        string request;
        char buffer[4096];
        int received;

        do
        {
            received = recv(client, buffer, sizeof(buffer), 0);
            if (received > 0)
            {
                request.append(buffer, received);

                size_t headerEnd = request.find("\r\n\r\n");
                if (headerEnd != string::npos)
                {
                    string headers = request.substr(0, headerEnd);
                    size_t p = headers.find("Content-Length:");
                    size_t expected = 0;

                    if (p != string::npos)
                    {
                        p += 15;
                        while (p < headers.size() && headers[p] == ' ')
                            ++p;
                        expected = static_cast<size_t>(
                            stoi(headers.substr(p)));
                    }

                    if (request.size() >= headerEnd + 4 + expected)
                        break;
                }
                else if (request.size() > 65536)
                {
                    break;
                }
            }
        } while (received > 0);

        string response = processRequest(request);
        send(client, response.c_str(), static_cast<int>(response.size()), 0);
        closesocket(client);
    }

    closesocket(serverSocket);
    WSACleanup();
    return 0;
}
