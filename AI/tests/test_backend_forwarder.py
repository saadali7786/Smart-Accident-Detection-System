import unittest
import socket
import time

from AI.backend_forwarder import BackendEventForwarder, should_forward_event


THRESHOLD = 0.8


def event(classification, confidence="low", confidence_score=None):
    result = {
        "event_id": "run-AI-00001",
        "timestamp": "00:00:01.250",
        "classification": classification,
        "confidence": confidence,
        "involved_vehicle_ids": [12, 34],
        "evidence": [{"type": "vehicle_proximity"}],
    }
    if confidence_score is not None:
        result["confidence_score"] = confidence_score
    return result


class BackendForwarderTests(unittest.TestCase):
    def test_each_classification_obeys_the_shared_event_contract(self):
        self.assertFalse(should_forward_event(event("normal_traffic"), THRESHOLD))
        self.assertFalse(should_forward_event(event("uncertain"), THRESHOLD))
        self.assertFalse(
            should_forward_event(event("confirmed_accident", "high"), THRESHOLD)
        )
        self.assertFalse(
            should_forward_event(event("potential_accident", "low"), THRESHOLD)
        )
        self.assertFalse(
            should_forward_event(
                event("potential_accident", confidence_score=0.79), THRESHOLD
            )
        )
        self.assertTrue(
            should_forward_event(
                event("potential_accident", confidence_score=THRESHOLD), THRESHOLD
            )
        )
        self.assertTrue(
            should_forward_event(
                event("potential_accident", confidence_score=0.95), THRESHOLD
            )
        )
        self.assertFalse(
            should_forward_event(
                event("potential_accident", confidence_score=1.01), THRESHOLD
            )
        )
        self.assertFalse(
            should_forward_event(
                event("potential_accident", confidence_score=float("nan")),
                THRESHOLD,
            )
        )
        self.assertTrue(
            should_forward_event(
                event("suspected_accident", confidence="medium"), THRESHOLD
            )
        )
        self.assertTrue(
            should_forward_event(
                event("suspected_accident", confidence_score=0.5), THRESHOLD
            )
        )
        self.assertFalse(
            should_forward_event(
                event("suspected_accident", confidence_score=1.01), THRESHOLD
            )
        )

    def test_retries_reuse_id_and_successful_event_is_not_queued_twice(self):
        calls = []

        def sender(url, payload, timeout):
            calls.append((url, payload, timeout))
            return 503 if len(calls) == 1 else 200

        forwarder = BackendEventForwarder(
            "http://127.0.0.1:8080", sender=sender, retry_delays=(0,)
        )
        try:
            eligible = event("suspected_accident")
            self.assertTrue(forwarder.submit(eligible, THRESHOLD))
            forwarder._queue.join()
            self.assertFalse(forwarder.submit(eligible, THRESHOLD))
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][1]["eventId"], "run-AI-00001")
            self.assertEqual(calls[1][1]["eventId"], "run-AI-00001")
            self.assertEqual(calls[1][1]["timestamp"], "00:00:01.250")
            self.assertEqual(calls[1][1]["vehicleIds"], [12, 34])
            self.assertEqual(forwarder.status()["forwarded"], 1)
        finally:
            forwarder.close()

    def test_offline_backend_has_bounded_attempts_and_does_not_raise(self):
        calls = []

        def offline_sender(url, payload, timeout):
            calls.append(payload["eventId"])
            raise TimeoutError("backend offline")

        forwarder = BackendEventForwarder(
            "http://127.0.0.1:8080",
            sender=offline_sender,
            retry_delays=(0, 0),
        )
        try:
            self.assertTrue(
                forwarder.submit(event("suspected_accident"), THRESHOLD)
            )
            forwarder._queue.join()
            self.assertEqual(calls, ["run-AI-00001"] * 3)
            status = forwarder.status()
            self.assertEqual(status["failed"], 1)
            self.assertEqual(status["queued"], 0)
            self.assertIn("offline", status["lastError"])
        finally:
            forwarder.close()

    def test_real_offline_backend_does_not_block_submitter(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        forwarder = BackendEventForwarder(
            "http://127.0.0.1:{}".format(port),
            timeout_seconds=0.2,
            retry_delays=(0, 0),
        )
        started = time.monotonic()
        try:
            self.assertTrue(
                forwarder.submit(event("suspected_accident"), THRESHOLD)
            )
            self.assertLess(time.monotonic() - started, 0.1)
            forwarder._queue.join()
            self.assertEqual(forwarder.status()["failed"], 1)
            self.assertEqual(forwarder.status()["queued"], 0)
        finally:
            forwarder.close()


if __name__ == "__main__":
    unittest.main()
