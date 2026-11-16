# Local demo startup

From the repository root, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-demo.ps1
```

The script builds the Windows C++ backend when its sources are newer, provisions
the AI service in `AI\.venv` with Python 3.12 on first run, installs missing
frontend/notification dependencies, starts the services, and checks their health
before opening the dashboard at `http://127.0.0.1:5173`.

Required tools are `g++`, `uv`, Node.js, and npm. The YOLO11n model must be at
the repository root or in `AI\models`. The script reuses a service only when
its health endpoint identifies the expected service; it never terminates or
replaces a process occupying a required port. Logs are written to
`BE\build\demo\logs`.

The C++ backend runs in memory-only mode unless built and configured with
PostgreSQL. Its health response and the Overview page identify that mode;
accident records will not survive a backend restart without PostgreSQL.
Notification test mode is loaded from `BE\notify\.env`; in that mode no SMS is
sent. The system is a demonstration and does not dispatch emergency services.

Health endpoints:

- Backend: `http://127.0.0.1:8080/api/health`
- AI: `http://127.0.0.1:5001/api/ai/status`
- Notifications: `http://127.0.0.1:3001/api/health`
