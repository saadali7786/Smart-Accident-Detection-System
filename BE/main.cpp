
#define _WIN32_WINNT 0x0600
#define NOMINMAX

#include "database.h"
#include "json_parser.h"

#include <iostream>
#include <algorithm>
#include <vector>
#include <stack>
#include <queue>
#include <unordered_map>
#include <mutex>
#include <thread>
#include <ctime>
#include <cmath>
#include <string>
#include <sstream>
#include <cstdint>
#include <cstdlib>
#include <cctype>
#include <atomic>
#include <limits>
#include <iterator>
#include <system_error>
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
    string sourceEventId;
    string eventType;
    string confidenceJson;
    string vehicleIdsJson;
    string evidenceJson;
};

int priorityRank(const AccidentEvent &event)
{
    if (event.severity == "Severe")
        return 4;
    if (event.severity == "Moderate")
        return 3;
    if (event.severity == "Suspected Accident")
        return 2;
    if (event.eventType == "confirmed_accident")
        return 4;
    if (event.severity == "Minor")
        return 1;
    if (event.severity == "Potential Accident")
        return 0;
    if (event.eventType == "suspected_accident")
        return 2;
    if (event.eventType == "potential_accident")
        return 0;
    return 0;
}

// Severity rank, then impact score, then older ID; the ordering is deterministic.
struct ComparePriority
{
    bool operator()(const AccidentEvent &a, const AccidentEvent &b) const
    {
        if (priorityRank(a) != priorityRank(b))
            return priorityRank(a) < priorityRank(b);
        if (a.impactScore != b.impactScore)
            return a.impactScore < b.impactScore;
        return a.id > b.id;
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
unordered_map<string, std::uint64_t> seenAIEventIds;
mutex requestMutex;
double aiForwardConfidenceThreshold = 0.8;

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
    seenAIEventIds.clear();

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
        event.sourceEventId = stored.sourceEventId;
        event.eventType = stored.eventType;
        event.confidenceJson = stored.confidenceJson;
        event.vehicleIdsJson = stored.vehicleIdsJson;
        event.evidenceJson = stored.evidenceJson;
        if (!event.sourceEventId.empty())
        {
            seenAIEventIds[event.sourceEventId] = event.id;
        }

        if (event.processed)
        {
            ++processedAccidentEvents;
        }
        else
        {
            accidentQueue.push(event);
        }
        if (event.severity == "Severe")
        {
            pushSevereEvent(event);
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

string eventJson(const AccidentEvent &event)
{
    const string confidence =
        event.confidenceJson.empty() ? "null" : event.confidenceJson;
    const string vehicleIds =
        event.vehicleIdsJson.empty() ? "[]" : event.vehicleIdsJson;
    const string evidence =
        event.evidenceJson.empty() ? "[]" : event.evidenceJson;
    return
        "{\"id\":" + to_string(event.id) +
        ",\"eventId\":" + jsonEscape(event.sourceEventId) +
        ",\"impactScore\":" + to_string(event.impactScore) +
        ",\"severity\":" + jsonEscape(event.severity) +
        ",\"timestamp\":" + jsonEscape(event.timestamp) +
        ",\"eventType\":" + jsonEscape(event.eventType) +
        ",\"confidence\":" + confidence +
        ",\"vehicleIds\":" + vehicleIds +
        ",\"evidence\":" + evidence +
        ",\"hasLocation\":" + string(event.hasLocation ? "true" : "false") +
        ",\"latitude\":" +
        (event.hasLocation ? to_string(event.latitude) : "null") +
        ",\"longitude\":" +
        (event.hasLocation ? to_string(event.longitude) : "null") +
        ",\"status\":" +
        jsonEscape(event.processed ? "Processed" : "Pending") + "}";
}

AccidentEvent fromPersistedAccident(const PersistedAccident &stored)
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
    event.sourceEventId = stored.sourceEventId;
    event.eventType = stored.eventType;
    event.confidenceJson = stored.confidenceJson;
    event.vehicleIdsJson = stored.vehicleIdsJson;
    event.evidenceJson = stored.evidenceJson;
    return event;
}

string getResponse(int status, const string &body)
{
    const char *statusText =
        status == 200 ? "OK" :
        status == 201 ? "Created" :
        status == 202 ? "Accepted" :
        status == 400 ? "Bad Request" :
        status == 404 ? "Not Found" :
        status == 409 ? "Conflict" :
        status == 413 ? "Payload Too Large" :
        status == 503 ? "Service Unavailable" :
                        "Internal Server Error";
    stringstream response;
    response << "HTTP/1.1 " << status
             << " " << statusText
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

bool readJsonNumber(const JsonValue &body, const string &key, double &value)
{
    const JsonValue *member = jsonMember(body, key);
    if (member == nullptr || member->type != JsonValue::Type::Number ||
        !std::isfinite(member->number))
        return false;
    value = member->number;
    return true;
}

string readJsonString(const JsonValue &body, const string &key)
{
    const JsonValue *member = jsonMember(body, key);
    return member != nullptr && member->type == JsonValue::Type::String
               ? member->string
               : "";
}

string processRequest(const string &request)
{
    std::lock_guard<std::mutex> requestLock(requestMutex);
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

    JsonValue requestJson;
    const bool isPost = headers.find("POST ") == 0;
    if (isPost)
    {
        const bool processingEndpoint =
            headers.find("POST /api/dsa/process ") == 0 ||
            headers.find("POST /api/dsa/process-priority ") == 0;
        const bool bodyOptional = processingEndpoint && body.empty();
        if (body.size() > 1024 * 1024)
        {
            return getResponse(
                413, R"({"success":false,"error":"JSON request body exceeds 1 MB"})");
        }
        try
        {
            requestJson = JsonParser(bodyOptional ? "{}" : body).parse();
            if (requestJson.type != JsonValue::Type::Object)
            {
                return getResponse(
                    400, R"({"success":false,"error":"JSON request body must be an object"})");
            }
        }
        catch (const std::exception &)
        {
            return getResponse(
                400, R"({"success":false,"error":"Malformed JSON request body"})");
        }
    }

    // DSA status endpoint
    if (headers.find("GET /api/dsa/status ") == 0)
    {
        string queueEvents = "[";
        queue<AccidentEvent> queueCopy = accidentQueue;
        bool first = true;
        while (!queueCopy.empty())
        {
            if (!first) queueEvents += ",";
            first = false;
            queueEvents += eventJson(queueCopy.front());
            queueCopy.pop();
        }
        queueEvents += "]";

        string stackEvents = "[";
        stack<AccidentEvent> stackCopy = severeAccidentStack;
        first = true;
        while (!stackCopy.empty())
        {
            if (!first) stackEvents += ",";
            first = false;
            stackEvents += eventJson(stackCopy.top());
            stackCopy.pop();
        }
        stackEvents += "]";

        string priorityEvents = "[";
        priority_queue<AccidentEvent, vector<AccidentEvent>, ComparePriority>
            priorityCopy = priorityAccidentQueue;
        first = true;
        while (!priorityCopy.empty())
        {
            if (!first) priorityEvents += ",";
            first = false;
            priorityEvents += eventJson(priorityCopy.top());
            priorityCopy.pop();
        }
        priorityEvents += "]";

        string historyEvents = "[";
        for (size_t index = 0; index < accidentHistory.size(); ++index)
        {
            if (index != 0) historyEvents += ",";
            historyEvents += eventJson(accidentHistory[index]);
        }
        historyEvents += "]";

        const string latestSevereEvent =
            severeAccidentStack.empty()
                ? "null"
                : eventJson(severeAccidentStack.top());
        const string highestPriorityEvent =
            priorityAccidentQueue.empty()
                ? "null"
                : eventJson(priorityAccidentQueue.top());
        const string processingStatus =
            accidentQueue.empty() ? "idle" : "pending";
        const string status =
            "{\"success\":true,"
            "\"queueSize\":" + to_string(accidentQueue.size()) +
            ",\"pendingEvents\":" + to_string(accidentQueue.size()) +
            ",\"severeStackSize\":" + to_string(severeAccidentStack.size()) +
            ",\"severeAccidentCount\":" + to_string(severeAccidentStack.size()) +
            ",\"processedEvents\":" + to_string(processedAccidentEvents) +
            ",\"totalProcessedEvents\":" + to_string(processedAccidentEvents) +
            ",\"totalEnqueuedEvents\":" + to_string(totalEnqueuedEvents) +
            ",\"totalReceivedEvents\":" + to_string(totalEnqueuedEvents) +
            ",\"processingStatus\":" + jsonEscape(processingStatus) +
            ",\"latestSevereEvent\":" + latestSevereEvent +
            ",\"queueEvents\":" + queueEvents +
            ",\"stackEvents\":" + stackEvents +
            ",\"priorityEvents\":" + priorityEvents +
            ",\"historyEvents\":" + historyEvents +
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
            if (i > 0)
            {
                history += ",";
            }
            const AccidentEvent event = database.isEnabled()
                                            ? fromPersistedAccident(persistedAccidents[i])
                                            : accidentHistory[i];
            history += eventJson(event);
        }

        history += "]}";

        return getResponse(200, history);
    }

    // Process the oldest pending accident event.
    const bool priorityProcessing =
        headers.find("POST /api/dsa/process-priority ") == 0;
    if (headers.find("POST /api/dsa/process ") == 0 || priorityProcessing)
    {

        if (accidentQueue.empty() || (priorityProcessing && priorityAccidentQueue.empty()))
        {
            return getResponse(200,
                               R"({"success":true,"message":"Queue is empty"})");
        }

        AccidentEvent currentEvent =
            priorityProcessing ? priorityAccidentQueue.top()
                               : accidentQueue.front();
        std::string databaseError;
        if (database.isEnabled() &&
            !database.updateAccidentProcessed(currentEvent.id, databaseError))
        {
            cerr << "PostgreSQL accident status update failed: "
                 << databaseError << '\n';
            return getResponse(
                503, R"({"success":false,"error":"Accident could not be processed"})");
        }
        if (!priorityProcessing)
        {
            accidentQueue.pop();
        }
        else
        {
            queue<AccidentEvent> remaining;
            while (!accidentQueue.empty())
            {
                const AccidentEvent candidate = accidentQueue.front();
                accidentQueue.pop();
                if (candidate.id != currentEvent.id)
                    remaining.push(candidate);
            }
            accidentQueue.swap(remaining);
        }

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

        string result =
            "{\"success\":true,"
            "\"message\":" +
            jsonEscape(priorityProcessing
                           ? "Highest-priority accident event processed successfully"
                           : "Oldest accident event processed successfully") +
            ","
            "\"processedEventId\":" +
            to_string(currentEvent.id) +
            "}";

        return getResponse(200, result);
    }

    // ================= VEHICLE REGISTRATION API =================

    if (headers.find("POST /api/vehicles/register ") == 0)
    {
        string vehicleId = readJsonString(requestJson, "vehicleId");

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
        string vehicleId = readJsonString(requestJson, "vehicleId");
        double latitude = 0;
        double longitude = 0;
        double speed = 0;

        if (vehicleId.empty())
        {
            return getResponse(400,
                               R"({"success":false,"error":"Vehicle ID is required"})");
        }
        if (!readJsonNumber(requestJson, "latitude", latitude) ||
            !readJsonNumber(requestJson, "longitude", longitude) ||
            !readJsonNumber(requestJson, "speed", speed))
        {
            return getResponse(
                400, R"({"success":false,"error":"Numeric latitude, longitude, and speed are required"})");
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
        const string vehicleId = readJsonString(requestJson, "vehicleId");
        const char *sensorFields[] = {
            "accelerationX", "accelerationY", "accelerationZ",
            "gyroscopeX", "gyroscopeY", "gyroscopeZ"};
        double sensorValues[6];
        for (size_t i = 0; i < 6; ++i)
        {
            if (!readJsonNumber(requestJson, sensorFields[i], sensorValues[i]) ||
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

    if (headers.find("POST /api/ai/event ") == 0)
    {
        const JsonValue *eventIdValue = jsonMember(requestJson, "eventId");
        const JsonValue *timestampValue = jsonMember(requestJson, "timestamp");
        const JsonValue *vehicleIdsValue = jsonMember(requestJson, "vehicleIds");
        const JsonValue *confidenceValue = jsonMember(requestJson, "confidence");
        const JsonValue *eventTypeValue = jsonMember(requestJson, "eventType");
        const JsonValue *evidenceValue = jsonMember(requestJson, "evidence");
        if (eventIdValue == nullptr || timestampValue == nullptr ||
            vehicleIdsValue == nullptr || confidenceValue == nullptr ||
            eventTypeValue == nullptr || evidenceValue == nullptr ||
            eventIdValue->type != JsonValue::Type::String ||
            timestampValue->type != JsonValue::Type::String ||
            eventTypeValue->type != JsonValue::Type::String ||
            vehicleIdsValue->type != JsonValue::Type::Array ||
            evidenceValue->type != JsonValue::Type::Array)
        {
            return getResponse(
                400, R"({"success":false,"error":"eventId, timestamp, vehicleIds, confidence, eventType, and evidence are required with valid types"})");
        }

        const string &eventId = eventIdValue->string;
        const string &timestamp = timestampValue->string;
        const string &eventType = eventTypeValue->string;
        if (eventId.empty() || eventId.size() > 160 ||
            timestamp.empty() || timestamp.size() > 80 ||
            vehicleIdsValue->array.empty() ||
            vehicleIdsValue->array.size() > 32 ||
            evidenceValue->array.empty() ||
            evidenceValue->array.size() > 64)
        {
            return getResponse(
                400, R"({"success":false,"error":"AI event fields exceed allowed limits or are empty"})");
        }
        for (char character : eventId)
        {
            if (!isalnum(static_cast<unsigned char>(character)) &&
                character != '-' && character != '_' &&
                character != '.' && character != ':')
            {
                return getResponse(
                    400, R"({"success":false,"error":"eventId contains unsupported characters"})");
            }
        }
        for (unsigned char character : timestamp)
        {
            if (character < 0x20)
            {
                return getResponse(
                    400, R"({"success":false,"error":"timestamp contains unsupported characters"})");
            }
        }

        const bool isNumericConfidence =
            confidenceValue->type == JsonValue::Type::Number;
        if (isNumericConfidence &&
            (confidenceValue->number < 0 || confidenceValue->number > 1))
        {
            return getResponse(
                400, R"({"success":false,"error":"Numeric confidence must be between 0 and 1"})");
        }
        if (!isNumericConfidence &&
            (confidenceValue->type != JsonValue::Type::String ||
             confidenceValue->string.empty() ||
             confidenceValue->string.size() > 40))
        {
            return getResponse(
                400, R"({"success":false,"error":"confidence must be a label or a number between 0 and 1"})");
        }
        if (eventType != "suspected_accident" &&
            eventType != "potential_accident")
        {
            return getResponse(
                400, R"({"success":false,"error":"Video-only events must remain potential or suspected; independent validation is required for confirmation"})");
        }
        if (eventType == "potential_accident" &&
            (!isNumericConfidence ||
             confidenceValue->number < aiForwardConfidenceThreshold))
        {
            return getResponse(
                400, R"({"success":false,"error":"Potential events require numeric confidence at or above the configured forwarding threshold"})");
        }

        for (const JsonValue &vehicleId : vehicleIdsValue->array)
        {
            if (vehicleId.type == JsonValue::Type::String)
            {
                if (vehicleId.string.empty() || vehicleId.string.size() > 64)
                {
                    return getResponse(
                        400, R"({"success":false,"error":"vehicleIds contain an invalid string ID"})");
                }
            }
            else if (vehicleId.type == JsonValue::Type::Number)
            {
                if (vehicleId.number < 0 || vehicleId.number > 1000000000 ||
                    std::floor(vehicleId.number) != vehicleId.number)
                {
                    return getResponse(
                        400, R"({"success":false,"error":"vehicleIds contain an invalid numeric ID"})");
                }
            }
            else
            {
                return getResponse(
                    400, R"({"success":false,"error":"vehicleIds must contain only string or nonnegative integer IDs"})");
            }
        }

        const char *allowedEvidenceTypes[] = {
            "vehicle_proximity", "bounding_box_overlap",
            "sudden_deceleration", "abrupt_direction_change",
            "stopped_after_possible_collision"};
        for (const JsonValue &evidence : evidenceValue->array)
        {
            const JsonValue *typeValue = jsonMember(evidence, "type");
            if (typeValue == nullptr ||
                typeValue->type != JsonValue::Type::String ||
                std::find(std::begin(allowedEvidenceTypes),
                          std::end(allowedEvidenceTypes),
                          typeValue->string) == std::end(allowedEvidenceTypes))
            {
                return getResponse(
                    400, R"({"success":false,"error":"evidence must contain recognized evidence types"})");
            }
        }

        const JsonValue *validatedValue = jsonMember(requestJson, "validated");
        if (validatedValue != nullptr &&
            (validatedValue->type != JsonValue::Type::Boolean ||
             validatedValue->boolean))
        {
            return getResponse(
                400, R"({"success":false,"error":"Video-only AI events cannot be marked as independently validated"})");
        }

        const JsonValue *latitudeValue = jsonMember(requestJson, "latitude");
        const JsonValue *longitudeValue = jsonMember(requestJson, "longitude");
        const bool hasLatitude =
            latitudeValue != nullptr && latitudeValue->type != JsonValue::Type::Null;
        const bool hasLongitude =
            longitudeValue != nullptr && longitudeValue->type != JsonValue::Type::Null;
        if (hasLatitude != hasLongitude)
        {
            return getResponse(
                400, R"({"success":false,"error":"Both GPS coordinates are required when location is provided"})");
        }
        const bool hasLocation = hasLatitude && hasLongitude;
        double latitude = 0;
        double longitude = 0;
        if (hasLocation)
        {
            if (latitudeValue->type != JsonValue::Type::Number ||
                longitudeValue->type != JsonValue::Type::Number ||
                latitudeValue->number < -90 || latitudeValue->number > 90 ||
                longitudeValue->number < -180 || longitudeValue->number > 180)
            {
                return getResponse(
                    400, R"({"success":false,"error":"GPS coordinates are outside valid ranges"})");
            }
            latitude = latitudeValue->number;
            longitude = longitudeValue->number;
        }

        const auto existingEvent = seenAIEventIds.find(eventId);
        if (existingEvent != seenAIEventIds.end())
        {
            return getResponse(
                200, "{\"success\":true,\"duplicate\":true,\"eventId\":" +
                         jsonEscape(eventId) + ",\"id\":" +
                         to_string(existingEvent->second) + "}");
        }

        AccidentEvent newEvent{};
        newEvent.impactScore = 0;
        newEvent.severity =
            eventType == "suspected_accident"
                ? "Suspected Accident"
                : "Potential Accident";
        newEvent.timestamp = timestamp;
        newEvent.latitude = latitude;
        newEvent.longitude = longitude;
        newEvent.hasLocation = hasLocation;
        newEvent.processed = false;
        newEvent.sourceEventId = eventId;
        newEvent.eventType = eventType;
        newEvent.confidenceJson = serializeJson(*confidenceValue);
        newEvent.vehicleIdsJson = serializeJson(*vehicleIdsValue);
        newEvent.evidenceJson = serializeJson(*evidenceValue);

        std::string databaseError;
        if (database.isEnabled())
        {
            bool inserted = false;
            if (!database.insertAiAccident(
                    eventId, timestamp, eventType, newEvent.severity,
                    newEvent.confidenceJson, newEvent.vehicleIdsJson,
                    newEvent.evidenceJson, hasLocation, latitude, longitude,
                    newEvent.id, inserted, databaseError))
            {
                cerr << "PostgreSQL AI event insert failed: "
                     << databaseError << '\n';
                return getResponse(
                    503, R"({"success":false,"error":"AI event could not be saved"})");
            }
            nextAccidentId = std::max(nextAccidentId, newEvent.id + 1);
            if (!inserted)
            {
                seenAIEventIds[eventId] = newEvent.id;
                return getResponse(
                    200, "{\"success\":true,\"duplicate\":true,\"eventId\":" +
                             jsonEscape(eventId) + ",\"id\":" +
                             to_string(newEvent.id) + "}");
            }
        }
        else
        {
            newEvent.id = nextAccidentId++;
        }

        seenAIEventIds[eventId] = newEvent.id;
        accidentQueue.push(newEvent);
        if (accidentHistory.size() >= MAX_HISTORY)
        {
            accidentHistory.erase(accidentHistory.begin());
        }
        accidentHistory.push_back(newEvent);
        updatePriorityQueue();
        ++totalEnqueuedEvents;

        return getResponse(
            201, "{\"success\":true,\"duplicate\":false,\"event\":" +
                     eventJson(newEvent) + "}");
    }

    if (headers.find("POST /api/accident ") != 0)
    {
        return getResponse(404, R"({"success":false,"error":"Unknown endpoint"})");
    }

    double speedA = 0;
    double speedB = 0;
    double massA = 0;
    double massB = 0;
    double impactG = 0;
    if (!readJsonNumber(requestJson, "speedA", speedA) ||
        !readJsonNumber(requestJson, "speedB", speedB) ||
        !readJsonNumber(requestJson, "massA", massA) ||
        !readJsonNumber(requestJson, "massB", massB))
    {
        return getResponse(
            400, R"({"success":false,"error":"Numeric speedA, speedB, massA, and massB fields are required"})");
    }
    const JsonValue *impactValue = jsonMember(requestJson, "impactG");
    if (impactValue != nullptr &&
        !readJsonNumber(requestJson, "impactG", impactG))
    {
        return getResponse(
            400, R"({"success":false,"error":"impactG must be a finite number"})");
    }

    const string collisionType = readJsonString(requestJson, "collisionType");

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
    const bool latitudeProvided =
        jsonMember(requestJson, "latitude") != nullptr;
    const bool longitudeProvided =
        jsonMember(requestJson, "longitude") != nullptr;
    double latitude = 0;
    double longitude = 0;

    bool hasLocation = latitudeProvided && longitudeProvided;

    // Validate GPS coordinates if provided.
    if (latitudeProvided != longitudeProvided)
    {
        return getResponse(400,
                           R"({"error":"Both latitude and longitude are required"})");
    }

    if (hasLocation &&
        (!readJsonNumber(requestJson, "latitude", latitude) ||
         !readJsonNumber(requestJson, "longitude", longitude) ||
         latitude < -90 || latitude > 90 ||
         longitude < -180 || longitude > 180))
    {
        return getResponse(400,
                           R"({"error":"Invalid GPS coordinates"})");
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
    newEvent.eventType = collisionType;
    newEvent.confidenceJson = "null";
    newEvent.evidenceJson = "[]";
    JsonValue vehicleIds;
    vehicleIds.type = JsonValue::Type::Array;
    for (const char *vehicleField : {"vehicleAId", "vehicleBId"})
    {
        const JsonValue *vehicleId = jsonMember(requestJson, vehicleField);
        if (vehicleId != nullptr &&
            (vehicleId->type == JsonValue::Type::String ||
             vehicleId->type == JsonValue::Type::Number))
        {
            vehicleIds.array.push_back(*vehicleId);
        }
    }
    newEvent.vehicleIdsJson = serializeJson(vehicleIds);

    // Add to pending FIFO Queue.
    accidentQueue.push(newEvent);
    if (newEvent.severity == "Severe")
    {
        pushSevereEvent(newEvent);
    }

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

std::atomic<unsigned> activeClients{0};
const unsigned MAX_CONCURRENT_CLIENTS = 64;

bool readHttpContentLength(const string &headers, size_t &contentLength)
{
    contentLength = 0;
    std::istringstream lines(headers);
    string line;
    bool firstLine = true;
    bool foundLength = false;
    while (std::getline(lines, line))
    {
        if (!line.empty() && line.back() == '\r')
            line.pop_back();
        if (firstLine)
        {
            firstLine = false;
            continue;
        }
        const size_t colon = line.find(':');
        if (colon == string::npos)
            return false;
        string name = line.substr(0, colon);
        std::transform(name.begin(), name.end(), name.begin(),
                       [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
        if (name == "transfer-encoding")
            return false;
        if (name != "content-length")
            continue;
        if (foundLength)
            return false;
        foundLength = true;
        size_t start = colon + 1;
        while (start < line.size() &&
               std::isspace(static_cast<unsigned char>(line[start])))
            ++start;
        size_t end = line.size();
        while (end > start &&
               std::isspace(static_cast<unsigned char>(line[end - 1])))
            --end;
        if (start == end)
            return false;
        for (size_t index = start; index < end; ++index)
        {
            if (line[index] < '0' || line[index] > '9')
                return false;
            const size_t digit = static_cast<size_t>(line[index] - '0');
            if (contentLength > (std::numeric_limits<size_t>::max() - digit) / 10)
                return false;
            contentLength = contentLength * 10 + digit;
        }
    }
    return true;
}

void sendSocketResponse(SOCKET client, const string &response)
{
    size_t sent = 0;
    while (sent < response.size())
    {
        const int count = send(
            client, response.data() + sent,
            static_cast<int>(response.size() - sent), 0);
        if (count <= 0)
            return;
        sent += static_cast<size_t>(count);
    }
}

void handleClient(SOCKET client)
{
    DWORD timeoutMilliseconds = 2000;
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO,
               reinterpret_cast<const char *>(&timeoutMilliseconds),
               sizeof(timeoutMilliseconds));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO,
               reinterpret_cast<const char *>(&timeoutMilliseconds),
               sizeof(timeoutMilliseconds));

    string request;
    char buffer[4096];
    bool rejected = false;
    while (true)
    {
        const int received = recv(client, buffer, sizeof(buffer), 0);
        if (received <= 0)
            break;
        request.append(buffer, static_cast<size_t>(received));
        const size_t headerEnd = request.find("\r\n\r\n");
        if (headerEnd == string::npos)
        {
            if (request.size() > 64 * 1024)
            {
                sendSocketResponse(
                    client, getResponse(
                                413, R"({"success":false,"error":"HTTP headers are too large"})"));
                rejected = true;
                break;
            }
            continue;
        }

        const string headers = request.substr(0, headerEnd);
        size_t expectedBodySize = 0;
        if (!readHttpContentLength(headers, expectedBodySize))
        {
            sendSocketResponse(
                client, getResponse(
                            400, R"({"success":false,"error":"Invalid or unsupported HTTP headers"})"));
            rejected = true;
            break;
        }
        if (expectedBodySize > 1024 * 1024)
        {
            sendSocketResponse(
                client, getResponse(
                            413, R"({"success":false,"error":"Request body exceeds 1 MB"})"));
            rejected = true;
            break;
        }
        if (request.size() >= headerEnd + 4 + expectedBodySize)
            break;
        if (request.size() > 64 * 1024 + 1024 * 1024)
        {
            sendSocketResponse(
                client, getResponse(
                            413, R"({"success":false,"error":"HTTP request is too large"})"));
            rejected = true;
            break;
        }
    }

    if (!rejected)
    {
        try
        {
            const string response = processRequest(request);
            sendSocketResponse(client, response);
        }
        catch (const std::exception &error)
        {
            cerr << "Request processing failed: " << error.what() << '\n';
            sendSocketResponse(
                client, getResponse(
                            500, R"({"success":false,"error":"Internal request processing error"})"));
        }
    }
    closesocket(client);
}

int main()
{
    const char *confidenceThreshold =
        std::getenv("AI_FORWARD_CONFIDENCE_THRESHOLD");
    if (confidenceThreshold != nullptr && *confidenceThreshold != '\0')
    {
        char *end = nullptr;
        const double configuredThreshold =
            std::strtod(confidenceThreshold, &end);
        if (end == confidenceThreshold || *end != '\0' ||
            !std::isfinite(configuredThreshold) ||
            configuredThreshold < 0 || configuredThreshold > 1)
        {
            cerr << "AI_FORWARD_CONFIDENCE_THRESHOLD must be between 0 and 1.\n";
            return 1;
        }
        aiForwardConfidenceThreshold = configuredThreshold;
    }

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
        cerr << "Could not bind port " << port
             << ". Is another server using it?\n";
        closesocket(serverSocket);
        WSACleanup();
        return 1;
    }

    if (listen(serverSocket, SOMAXCONN) == SOCKET_ERROR)
    {
        cerr << "Could not listen on the configured port.\n";
        closesocket(serverSocket);
        WSACleanup();
        return 1;
    }

    cout << "Smart Accident Detection Backend\n";
    cout << "Listening at http://localhost:" << port << '\n';
    cout << "Press Ctrl+C to stop.\n";

    while (true)
    {
        SOCKET client = accept(serverSocket, nullptr, nullptr);
        if (client == INVALID_SOCKET)
            continue;
        unsigned currentClients = activeClients.load();
        while (currentClients < MAX_CONCURRENT_CLIENTS &&
               !activeClients.compare_exchange_weak(
                   currentClients, currentClients + 1))
        {
        }
        if (currentClients >= MAX_CONCURRENT_CLIENTS)
        {
            sendSocketResponse(
                client, getResponse(
                            503, R"({"success":false,"error":"Backend is handling the maximum number of concurrent requests"})"));
            closesocket(client);
            continue;
        }
        try
        {
            std::thread([client]()
                        {
                            handleClient(client);
                            activeClients.fetch_sub(1);
                        })
                .detach();
        }
        catch (const std::system_error &error)
        {
            activeClients.fetch_sub(1);
            cerr << "Could not start request worker: " << error.what() << '\n';
            closesocket(client);
        }
    }

    closesocket(serverSocket);
    WSACleanup();
    return 0;
}
