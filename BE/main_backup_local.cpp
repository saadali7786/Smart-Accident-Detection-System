
#define _WIN32_WINNT 0x0600

#include <iostream>
#include <string>
#include <sstream>
#include <algorithm>
#include <winsock2.h>
#include <ws2tcpip.h>

#pragma comment(lib, "ws2_32.lib")

using namespace std;

string getResponse(int status, const string& body) {
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

double readSpeed(const string& body, const string& key) {
    size_t pos = body.find("\"" + key + "\"");
    if (pos == string::npos) return -1;

    pos = body.find(':', pos);
    if (pos == string::npos) return -1;

    try {
        return stod(body.substr(pos + 1));
    } catch (...) {
        return -1;
    }
}

string processRequest(const string& request) {
    size_t headerEnd = request.find("\r\n\r\n");
    if (headerEnd == string::npos) {
        return getResponse(400, R"({"error":"Invalid HTTP request"})");
    }

    string headers = request.substr(0, headerEnd);
    string body = request.substr(headerEnd + 4);

    if (headers.find("OPTIONS ") == 0) {
        return getResponse(200, "{}");
    }

    if (headers.find("GET /api/health ") == 0) {
        return getResponse(200,
            R"({"status":"ok","message":"Backend is running"})");
    }

    if (headers.find("POST /api/accident ") != 0) {
        return getResponse(400, R"({"error":"Unknown endpoint"})");
    }

    // Read speeds from the JSON request body.
    double speedA = readSpeed(body, "speedA");
    double speedB = readSpeed(body, "speedB");

    // Read more bytes if the request body is incomplete.
    size_t contentPos = headers.find("Content-Length:");
    if (contentPos != string::npos) {
        size_t lengthStart = contentPos + 15;
        while (lengthStart < headers.size() && headers[lengthStart] == ' ')
            ++lengthStart;
        size_t lengthEnd = headers.find("\r\n", lengthStart);
        int contentLength = stoi(headers.substr(lengthStart,
            lengthEnd - lengthStart));

        while (body.size() < static_cast<size_t>(contentLength)) {
            // The caller normally collects the full request before processing.
            break;
        }
    }

    if (speedA < 0 || speedB < 0 ||
        speedA > 300 || speedB > 300) {
        return getResponse(400,
            R"({"error":"Provide speedA and speedB between 0 and 300"})");
    }

    int score = min(100, static_cast<int>((speedA + speedB) * 1.25));

    string severity;
    if (score >= 75) severity = "Severe";
    else if (score >= 42) severity = "Moderate";
    else if (score >= 18) severity = "Minor";
    else severity = "No Accident";

    bool alert = score >= 18;

    string result =
        "{\"success\":true,"
        "\"impactScore\":" + to_string(score) + ","
        "\"severity\":\"" + severity + "\","
        "\"alertStatus\":\"" +
        string(alert ? "Emergency Alert Simulated" : "No Alert") + "\","
        "\"emergencyResponse\":{\"triggered\":" +
        string(alert ? "true" : "false") + ","
        "\"message\":\"" +
        string(alert ? "Simulated emergency notification generated"
                     : "No emergency notification needed") + "\"},"
        "\"note\":\"Simulation only. No real emergency services contacted.\"}";

    cout << "Score: " << score << " | Severity: " << severity << '\n';
    return getResponse(200, result);
}

int main() {
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        cerr << "Could not initialize Windows networking.\n";
        return 1;
    }

    SOCKET serverSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (serverSocket == INVALID_SOCKET) {
        cerr << "Could not create server socket.\n";
        WSACleanup();
        return 1;
    }

    sockaddr_in serverAddress{};
    serverAddress.sin_family = AF_INET;
    serverAddress.sin_addr.s_addr = htonl(INADDR_ANY);
    serverAddress.sin_port = htons(8080);

    if (bind(serverSocket, reinterpret_cast<sockaddr*>(&serverAddress),
             sizeof(serverAddress)) == SOCKET_ERROR) {
        cerr << "Could not bind port 8080. Is another server using it?\n";
        closesocket(serverSocket);
        WSACleanup();
        return 1;
    }

    listen(serverSocket, SOMAXCONN);

    cout << "Smart Accident Detection Backend\n";
    cout << "Listening at http://localhost:8080\n";
    cout << "Press Ctrl+C to stop.\n";

    while (true) {
        SOCKET client = accept(serverSocket, nullptr, nullptr);
        if (client == INVALID_SOCKET) continue;

        string request;
        char buffer[4096];
        int received;

         do {
            received = recv(client, buffer, sizeof(buffer), 0);
            if (received > 0) {
                request.append(buffer, received);

                size_t headerEnd = request.find("\r\n\r\n");
                if (headerEnd != string::npos) {
                    string headers = request.substr(0, headerEnd);
                    size_t p = headers.find("Content-Length:");
                    size_t expected = 0;

                    if (p != string::npos) {
                        p += 15;
                        while (p < headers.size() && headers[p] == ' ') ++p;
                        expected = static_cast<size_t>(
                            stoi(headers.substr(p)));
                    }

                    if (request.size() >= headerEnd + 4 + expected)
                        break;
                } else if (request.size() > 65536) {
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
