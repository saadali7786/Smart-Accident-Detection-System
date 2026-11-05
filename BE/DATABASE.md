# PostgreSQL Persistence

The backend uses PostgreSQL through libpq when PostgreSQL development files are
available at configure time. `schema.sql` creates the required tables and
indexes. Vehicle GPS updates, accident simulations, and sensor readings are
stored in PostgreSQL. Accident and vehicle data are restored when the backend
starts. The in-memory FIFO queue, severe-event stack, and priority queue remain
the DSA processing structures.

If PostgreSQL is not configured, the backend prints a warning and runs in
memory-only mode. That mode is for the existing prototype and does not provide
persistence. If PostgreSQL environment variables are supplied but the database
cannot be reached or the schema is missing, backend startup fails instead of
silently switching to memory-only operation.

## Install PostgreSQL on Windows

Install PostgreSQL 16 with the official WinGet package and follow the installer
to set an administrator password:

```powershell
winget install --id PostgreSQL.PostgreSQL.16 --exact --source winget --interactive
```

In a new PowerShell window, add its command-line tools to the current session
(adjust the version directory if a different major version was installed):

```powershell
$env:Path = "C:\Program Files\PostgreSQL\16\bin;$env:Path"
```

## Create the application role and database

The following helper prompts for a password without echoing it and places it
only in the current PowerShell process environment:

```powershell
function Set-PostgresPassword {
    param([string]$VariableName)
    $secure = Read-Host "Password for $VariableName" -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        Set-Item -Path "Env:$VariableName" -Value `
            [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$env:PGHOST = "localhost"
$env:PGPORT = "5432"
$env:PGUSER = "postgres"
$env:PGDATABASE = "postgres"
Set-PostgresPassword "PGPASSWORD"

createuser --pwprompt --no-superuser --no-createdb --no-createrole sad_app
if ($LASTEXITCODE -ne 0) { throw "Could not create the sad_app role." }

createdb --owner=sad_app --username=postgres smart_accident_detection
if ($LASTEXITCODE -ne 0) { throw "Could not create the application database." }
```

`createuser --pwprompt` asks for the application role's password interactively.
Set the connection variables for the application role and apply the schema:

```powershell
$env:PGUSER = "sad_app"
$env:PGDATABASE = "smart_accident_detection"
Set-PostgresPassword "PGPASSWORD"

psql -v ON_ERROR_STOP=1 -f .\BE\schema.sql
if ($LASTEXITCODE -ne 0) { throw "Could not apply BE/schema.sql." }
```

Keep using this PowerShell session to configure, build, and run the backend.
Environment variables set this way are not persisted to source files or
machine-wide settings. For a service deployment, configure them in the service
manager's protected environment instead.

## Build and run

Run these commands from the repository root. CMake must find the PostgreSQL
installation's headers and libpq library; if automatic discovery fails, set
`CMAKE_PREFIX_PATH` to the PostgreSQL installation directory.

```powershell
cmake -S .\BE -B .\BE\build -DCMAKE_PREFIX_PATH="C:\Program Files\PostgreSQL\16"
cmake --build .\BE\build --config Release
.\BE\build\Release\accident_backend.exe
```

The backend reads `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and
optional `PGSSLMODE` using libpq's standard connection settings. Do not put
passwords in CMake arguments, scripts, or source control. For remote
connections, configure PostgreSQL and `PGSSLMODE` for the deployment's TLS
policy. The HTTP listener continues to default to port 8080; set `SAD_PORT` to
override it for local testing or deployment.

## Persisted API operations

- Existing `POST /api/vehicles/register` inserts the vehicle row.
- Existing `POST /api/vehicles/location` appends a GPS history row.
- Existing `GET /api/vehicles` reads registered active vehicles and their latest
  GPS point from PostgreSQL.
- Existing `POST /api/accident` stores the accident before adding it to the
  in-memory DSA structures.
- Existing `GET /api/accidents/history` reads the complete persisted history.
- Existing `POST /api/dsa/process` persists the processed status before
  dequeuing the incident.
- `POST /api/vehicles/sensor-data` saves six readings:

```json
{
  "vehicleId": "CAR-001",
  "accelerationX": 0.1,
  "accelerationY": 0.2,
  "accelerationZ": 9.8,
  "gyroscopeX": 0.01,
  "gyroscopeY": 0.02,
  "gyroscopeZ": 0.03
}
```

Database failures return HTTP 503 for affected operations. All data-bearing SQL
statements use libpq parameterized queries. GPS locations, accidents, and sensor
readings are append-only history; the vehicle API exposes the most recent GPS
record per active vehicle.

PostgreSQL persistence and restart recovery require libpq at build time, a
running PostgreSQL server, the environment variables above, and the schema
applied to the selected database.
