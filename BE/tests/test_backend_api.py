import json
import os
import socket
import subprocess
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from AI.backend_forwarder import BackendEventForwarder


ROOT = Path(__file__).resolve().parents[2]
BACKEND_EXE = Path(
    os.environ.get(
        "SAD_BACKEND_EXE",
        str(ROOT / "BE" / "build" / "Release" / "accident_backend.exe"),
    )
)


def reserve_local_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class CppBackendApiTests(unittest.TestCase):
    def setUp(self):
        if not BACKEND_EXE.is_file():
            self.skipTest(
                "Build the C++ backend first: cmake --build BE/build --config Release"
            )
        self.port = reserve_local_port()
        self.base_url = "http://127.0.0.1:{}".format(self.port)
        environment = os.environ.copy()
        for key in (
            "PGHOST",
            "PGPORT",
            "PGDATABASE",
            "PGUSER",
            "PGPASSWORD",
            "PGSSLMODE",
        ):
            environment.pop(key, None)
        environment["SAD_PORT"] = str(self.port)
        environment["AI_FORWARD_CONFIDENCE_THRESHOLD"] = "0.8"
        self.process = subprocess.Popen(
            [str(BACKEND_EXE)],
            cwd=str(ROOT),
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail("C++ backend exited during startup")
            try:
                response = self.request("GET", "/api/dsa/status")
                if response[0] == 200:
                    return
            except (URLError, TimeoutError):
                time.sleep(0.1)
        self.fail("C++ backend did not become ready")

    def tearDown(self):
        process = getattr(self, "process", None)
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def request(self, method, path, payload=None, raw=None):
        data = raw
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(
            self.base_url + path,
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    @staticmethod
    def ai_event(event_id=None, event_type="suspected_accident", confidence="medium"):
        return {
            "eventId": event_id or "test-{}".format(uuid.uuid4().hex),
            "timestamp": "00:00:01.250",
            "vehicleIds": [12, 34],
            "confidence": confidence,
            "eventType": event_type,
            "evidence": [
                {"type": "vehicle_proximity", "label": "Vehicles approached closely"},
                {"type": "sudden_deceleration", "label": "Sudden decrease in speed"},
            ],
            "latitude": 24.86,
            "longitude": 67.001,
            "validated": False,
        }

    def add_simulated_collision(self, speed):
        return self.request(
            "POST",
            "/api/accident",
            payload={
                "speedA": speed,
                "speedB": speed,
                "massA": 1500,
                "massB": 1500,
                "collisionType": "rear-end",
                "impactG": 1.0,
            },
        )

    def test_dsa_status_matches_frontend_contract_when_empty(self):
        code, status = self.request("GET", "/api/dsa/status")
        self.assertEqual(code, 200)
        for field in (
            "pendingEvents",
            "severeAccidentCount",
            "totalProcessedEvents",
            "totalReceivedEvents",
            "processingStatus",
            "queueEvents",
            "stackEvents",
            "priorityEvents",
            "historyEvents",
        ):
            with self.subTest(field=field):
                self.assertIn(field, status)
        self.assertEqual(status["processingStatus"], "idle")
        self.assertEqual(status["queueEvents"], [])
        self.assertEqual(status["stackEvents"], [])
        self.assertEqual(status["priorityEvents"], [])
        self.assertEqual(status["historyEvents"], [])

    def test_fifo_processes_oldest_and_keeps_history_consistent(self):
        first_status, first = self.request(
            "POST", "/api/ai/event", self.ai_event()
        )
        second_status, second = self.request(
            "POST", "/api/ai/event", self.ai_event()
        )
        self.assertEqual((first_status, second_status), (201, 201))
        first_id = first["event"]["id"]
        second_id = second["event"]["id"]

        status_code, status = self.request("GET", "/api/dsa/status")
        self.assertEqual(status_code, 200)
        self.assertEqual(
            [event["id"] for event in status["queueEvents"]],
            [first_id, second_id],
        )

        process_code, processed = self.request("POST", "/api/dsa/process")
        self.assertEqual(process_code, 200)
        self.assertEqual(processed["processedEventId"], first_id)
        _, refreshed = self.request("GET", "/api/dsa/status")
        self.assertEqual([event["id"] for event in refreshed["queueEvents"]], [second_id])
        self.assertEqual(refreshed["historyEvents"][0]["status"], "Processed")
        self.assertEqual(refreshed["historyEvents"][0]["eventId"], first["event"]["eventId"])
        self.assertEqual(refreshed["totalProcessedEvents"], 1)

    def test_severe_events_are_displayed_in_lifo_order(self):
        first_code, first = self.add_simulated_collision(40)
        second_code, second = self.add_simulated_collision(45)
        self.assertEqual((first_code, second_code), (200, 200))
        _, status = self.request("GET", "/api/dsa/status")
        self.assertEqual(status["stackEvents"][0]["id"], 2)
        self.assertEqual(status["stackEvents"][1]["id"], 1)
        self.assertEqual(first["severity"], "Severe")
        self.assertEqual(second["severity"], "Severe")

    def test_priority_queue_orders_by_severity_and_priority_processes_top(self):
        low_code, low = self.add_simulated_collision(10)
        high_code, high = self.add_simulated_collision(40)
        self.assertEqual((low_code, high_code), (200, 200))
        _, status = self.request("GET", "/api/dsa/status")
        highest_id = status["highestPriorityEvent"]["id"]
        self.assertEqual(status["priorityEvents"][0]["id"], highest_id)
        self.assertEqual(highest_id, 2)

        code, result = self.request("POST", "/api/dsa/process-priority")
        self.assertEqual(code, 200)
        self.assertEqual(result["processedEventId"], highest_id)
        self.assertEqual(low["severity"], "Minor")

    def test_priority_ties_are_broken_by_arrival_id(self):
        first_code, first = self.request(
            "POST", "/api/ai/event", self.ai_event()
        )
        second_code, second = self.request(
            "POST", "/api/ai/event", self.ai_event()
        )
        self.assertEqual((first_code, second_code), (201, 201))
        _, status = self.request("GET", "/api/dsa/status")
        self.assertEqual(
            [event["id"] for event in status["priorityEvents"]],
            [first["event"]["id"], second["event"]["id"]],
        )

    def test_potential_event_below_configured_threshold_is_rejected(self):
        code, response = self.request(
            "POST",
            "/api/ai/event",
            self.ai_event(
                event_type="potential_accident", confidence=0.79
            ),
        )
        self.assertEqual(code, 400)
        self.assertIn("threshold", response["error"])

    def test_ai_event_classification_contract(self):
        cases = (
            ("suspected_accident", "medium", 201),
            ("suspected_accident", 0.5, 201),
            ("potential_accident", 0.79, 400),
            ("potential_accident", 0.8, 201),
            ("potential_accident", 1.01, 400),
            ("potential_accident", "low", 400),
            ("normal_traffic", 0.99, 400),
            ("uncertain", 0.99, 400),
            ("confirmed_accident", "high", 400),
        )
        for event_type, confidence, expected_status in cases:
            with self.subTest(event_type=event_type, confidence=confidence):
                code, response = self.request(
                    "POST",
                    "/api/ai/event",
                    self.ai_event(
                        event_type=event_type,
                        confidence=confidence,
                    ),
                )
                self.assertEqual(code, expected_status, response)

    def test_vector_history_preserves_ai_event_metadata_and_timestamp(self):
        payload = self.ai_event()
        code, created = self.request("POST", "/api/ai/event", payload)
        self.assertEqual(code, 201)
        _, status = self.request("GET", "/api/dsa/status")
        stored = status["historyEvents"][0]
        self.assertEqual(stored["eventId"], payload["eventId"])
        self.assertEqual(stored["timestamp"], payload["timestamp"])
        self.assertEqual(stored["vehicleIds"], payload["vehicleIds"])
        self.assertEqual(stored["confidence"], payload["confidence"])
        self.assertEqual(stored["evidence"], payload["evidence"])
        self.assertTrue(stored["hasLocation"])
        self.assertEqual(stored["latitude"], payload["latitude"])
        self.assertEqual(stored["longitude"], payload["longitude"])
        self.assertEqual(stored["status"], "Pending")

        _, history = self.request("GET", "/api/accidents/history")
        self.assertEqual(history["totalRecords"], 1)
        self.assertEqual(history["accidents"][0], created["event"])
        self.assertEqual(history["accidents"][0], stored)

    def test_missing_location_and_valid_zero_coordinates_are_distinct(self):
        missing_location = self.ai_event()
        missing_location.pop("latitude")
        missing_location.pop("longitude")
        missing_code, missing_result = self.request(
            "POST", "/api/ai/event", missing_location
        )
        self.assertEqual(missing_code, 201)
        self.assertFalse(missing_result["event"]["hasLocation"])
        self.assertIsNone(missing_result["event"]["latitude"])
        self.assertIsNone(missing_result["event"]["longitude"])

        zero_location = self.ai_event()
        zero_location["eventId"] = "test-zero-coordinate-{}".format(uuid.uuid4().hex)
        zero_location["latitude"] = 0
        zero_location["longitude"] = 0
        zero_code, zero_result = self.request(
            "POST", "/api/ai/event", zero_location
        )
        self.assertEqual(zero_code, 201)
        self.assertTrue(zero_result["event"]["hasLocation"])
        self.assertEqual(zero_result["event"]["latitude"], 0)
        self.assertEqual(zero_result["event"]["longitude"], 0)

        _, history = self.request("GET", "/api/accidents/history")
        self.assertFalse(history["accidents"][0]["hasLocation"])
        self.assertIsNone(history["accidents"][0]["latitude"])
        self.assertIsNone(history["accidents"][0]["longitude"])
        self.assertTrue(history["accidents"][1]["hasLocation"])
        self.assertEqual(history["accidents"][1]["latitude"], 0)
        self.assertEqual(history["accidents"][1]["longitude"], 0)

    def test_duplicate_ai_event_does_not_duplicate_any_structure(self):
        payload = self.ai_event()
        first_code, first = self.request("POST", "/api/ai/event", payload)
        duplicate_code, duplicate = self.request("POST", "/api/ai/event", payload)
        self.assertEqual(first_code, 201)
        self.assertEqual(duplicate_code, 200)
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(first["event"]["id"], duplicate["id"])
        _, status = self.request("GET", "/api/dsa/status")
        self.assertEqual(status["totalReceivedEvents"], 1)
        self.assertEqual(status["queueSize"], 1)
        self.assertEqual(len(status["historyEvents"]), 1)

    def test_malformed_json_returns_400(self):
        code, response = self.request(
            "POST", "/api/ai/event", raw=b'{"eventId":'
        )
        self.assertEqual(code, 400)
        self.assertIn("error", response)

    def test_missing_ai_event_fields_returns_400(self):
        code, response = self.request("POST", "/api/ai/event", payload={})
        self.assertEqual(code, 400)
        self.assertIn("required", response["error"])

    def test_concurrent_unique_events_are_inserted_once(self):
        events = [self.ai_event() for _ in range(12)]
        with ThreadPoolExecutor(max_workers=12) as executor:
            responses = list(
                executor.map(
                    lambda event: self.request("POST", "/api/ai/event", event),
                    events,
                )
            )
        self.assertEqual([code for code, _ in responses], [201] * len(events))
        _, status = self.request("GET", "/api/dsa/status")
        self.assertEqual(status["totalReceivedEvents"], len(events))
        self.assertEqual(status["queueSize"], len(events))
        self.assertEqual(len({event["eventId"] for event in status["queueEvents"]}), len(events))

    def test_python_forwarder_sends_preserved_event_to_cpp(self):
        payload = self.ai_event()
        event = {
            "event_id": payload["eventId"],
            "timestamp": payload["timestamp"],
            "classification": payload["eventType"],
            "confidence": payload["confidence"],
            "involved_vehicle_ids": payload["vehicleIds"],
            "evidence": payload["evidence"],
            "validated": False,
            "latitude": payload["latitude"],
            "longitude": payload["longitude"],
        }
        forwarder = BackendEventForwarder(
            self.base_url, timeout_seconds=1, retry_delays=(0,)
        )
        try:
            self.assertTrue(forwarder.submit(event, 0.8))
            forwarder._queue.join()
            self.assertEqual(forwarder.status()["forwarded"], 1)
        finally:
            forwarder.close()

        _, status = self.request("GET", "/api/dsa/status")
        stored = status["historyEvents"][0]
        self.assertEqual(stored["eventId"], payload["eventId"])
        self.assertEqual(stored["timestamp"], payload["timestamp"])
        self.assertEqual(stored["vehicleIds"], payload["vehicleIds"])
        self.assertEqual(stored["latitude"], payload["latitude"])

    def test_python_forwarder_sends_threshold_qualified_potential_to_cpp(self):
        event = {
            "event_id": "potential-{}".format(uuid.uuid4().hex),
            "timestamp": "00:00:02.500",
            "classification": "potential_accident",
            "confidence": "low",
            "confidence_score": 0.8,
            "involved_vehicle_ids": [7, 8],
            "evidence": [{"type": "vehicle_proximity"}],
        }
        forwarder = BackendEventForwarder(
            self.base_url, timeout_seconds=1, retry_delays=(0,)
        )
        try:
            self.assertTrue(forwarder.submit(event, 0.8))
            forwarder._queue.join()
            self.assertEqual(forwarder.status()["forwarded"], 1)
        finally:
            forwarder.close()

        _, status = self.request("GET", "/api/dsa/status")
        self.assertEqual(status["historyEvents"][0]["eventType"], "potential_accident")
        self.assertEqual(status["historyEvents"][0]["confidence"], 0.8)


if __name__ == "__main__":
    unittest.main()
