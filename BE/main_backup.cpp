
#define _WIN32_WINNT 0x0600

#include <iostream>
#include <ctime>
#include <string>
#include <sstream>
#include <algorithm>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <queue>
#include <stack>
#include <vector>

#pragma comment(lib, "ws2_32.lib")

using namespace std;
// ================= DSA: ACCIDENT EVENT MANAGEMENT =================

struct AccidentEvent
{
    unsigned long id;
    int impactScore;
    string severity;
    string timestamp;
    bool processed;
};

// Queue: processes accident events in FIFO order.
queue<AccidentEvent> accidentQueue;

// Stack: stores the most recent severe accident events.
stack<AccidentEvent> severeAccidentStack;

// Stores accident records independently of the Queue.
vector<AccidentEvent> accidentHistory;

// Accident IDs start from 1.
unsigned long nextAccidentId = 1;

// Maximum number of records retained in memory.
const size_t MAX_HISTORY = 100;

unsigned long processedAccidentEvents = 0;
unsigned long totalEnqueuedEvents = 0;

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

// Decision Tree: classifies accident severity.
string decisionTree(int score)
{
    if (score >= 75)
    {
        return "Severe";
    }
    else if (score >= 42)
    {
        return "Moderate";
    }
    else if (score >= 18)
    {
        return "Minor";
    }
    else
    {
        return "No Accident";
    }
}

// Keep only the 20 most recent severe events.
void pushSevereEvent(const AccidentEvent &event)
{
    vector<AccidentEvent> temporary;

    while (!severeAccidentStack.empty())
    {
        temporary.push_back(severeAccidentStack.top());
        severeAccidentStack.pop();
    }

    // The last item is the oldest event.
    if (temporary.size() >= 20)
    {
        temporary.pop_back();
    }

    // Rebuild the stack in its original order.
    for (vector<AccidentEvent>::reverse_iterator it = temporary.rbegin();
         it != temporary.rend(); ++it)
    {
        severeAccidentStack.push(*it);
    }

    severeAccidentStack.push(event);
}

string getResponse(int status, const string &body)
{
    stringstream response;
    response << "HTTP/1.1 " << status
             << (status == 200 ? " OK" : " Bad Request") << "\r\n"
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
        ",\"stackEvents\":" + stackEvents + "}";

    return getResponse(200, status);
}
    // GET: Accident History
if (headers.find("GET /api/accidents/history ") == 0) {

    string history = "{\"success\":true,\"totalRecords\":" +
        to_string(accidentHistory.size()) +
        ",\"accidents\":[";

    for (size_t i = 0; i < accidentHistory.size(); i++) {

        const AccidentEvent& event = accidentHistory[i];

        if (i > 0) {
            history += ",";
        }

        history +=
            "{\"id\":" + to_string(event.id) +
            ",\"impactScore\":" + to_string(event.impactScore) +
            ",\"severity\":\"" + event.severity + "\"" +
            ",\"timestamp\":\"" + event.timestamp + "\"" +
            ",\"status\":\"" +
            string(event.processed ? "Processed" : "Pending") +
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

        // Store severe events in the LIFO stack.
        if (currentEvent.severity == "Severe")
        {
            pushSevereEvent(currentEvent);
        }

        string result =
            "{\"success\":true,"
            "\"message\":\"Event processed successfully\","
            "\"impactScore\":" +
            to_string(currentEvent.impactScore) + ","
                                                  "\"severity\":\"" +
            currentEvent.severity + "\","
                                    "\"remainingQueueSize\":" +
            to_string(accidentQueue.size()) +
            "}";

        return getResponse(200, result);
    }

    if (headers.find("GET /api/health ") == 0)
    {
        return getResponse(200,
                           R"({"status":"ok","message":"Backend is running"})");
    }

    if (headers.find("POST /api/accident ") != 0)
    {
        return getResponse(400, R"({"error":"Unknown endpoint"})");
    }

    // Read speeds from the JSON request body.
    double speedA = readSpeed(body, "speedA");
    double speedB = readSpeed(body, "speedB");

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

    if (speedA < 0 || speedB < 0 ||
        speedA > 300 || speedB > 300)
    {
        return getResponse(400,
                           R"({"error":"Provide speedA and speedB between 0 and 300"})");
    }

    int score = min(100, static_cast<int>((speedA + speedB) * 1.25));

    // Decision Tree classification
    string severity = decisionTree(score);

    // Add the accident to the pending FIFO Queue.
    // Create a new accident record.
    AccidentEvent newEvent;

    newEvent.id = nextAccidentId++;
    newEvent.impactScore = score;
    newEvent.severity = severity;
    newEvent.timestamp = getCurrentTimestamp();
    newEvent.processed = false;

    // Add to pending FIFO Queue.
    accidentQueue.push(newEvent);

    // Save independently in accident history.
    if (accidentHistory.size() >= MAX_HISTORY)
    {
        accidentHistory.erase(accidentHistory.begin());
    }

    accidentHistory.push_back(newEvent);

    totalEnqueuedEvents++;

    cout << "Accident ID: " << newEvent.id
         << " | Severity: " << newEvent.severity
         << " | Status: Pending" << endl;

    bool alert = score >= 18;

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
    serverAddress.sin_port = htons(8080);

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
    cout << "Listening at http://localhost:8080\n";
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
