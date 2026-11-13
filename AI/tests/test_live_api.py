
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np
from fastapi.testclient import TestClient


class FakeYOLO:
    def __init__(self):
        self.predictor = None
        self.track_calls = 0

    def track(self, frame, **kwargs):
        self.track_calls += 1
        return [SimpleNamespace(boxes=None)]


class FakeBackendForwarder:
    def __init__(self, *args, **kwargs):
        self.submitted = []

    def submit(self, event, threshold):
        self.submitted.append(event)
        return False

    def status(self):
        return {
            "queue_size": 0,
            "queued": 0,
            "sent": 0,
            "failed": 0,
        }


# Prevent real model loading and backend worker creation during import.
with (
    patch("ultralytics.YOLO", return_value=FakeYOLO()),
    patch(
        "AI.backend_forwarder.BackendEventForwarder",
        FakeBackendForwarder,
    ),
):
    from AI import api as ai_api


class TestLiveAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(ai_api.app)

    def setUp(self):
        ai_api.processing_state.update({
            "is_processing": False,
            "is_uploading": False,
            "progress": 0,
            "total_frames": 0,
            "processed_frames": 0,
            "status": "idle",
            "error": None,
            "last_result": None,
        })

        ai_api.live_state.update({
            "active": False,
            "stopping": False,
            "session_id": None,
            "frame_index": 0,
            "processed_frames": 0,
            "started_at": None,
            "analyzer": None,
            "width": 0,
            "height": 0,
            "total_vehicle_detections": 0,
            "detected_ids": set(),
        })

        ai_api.model = FakeYOLO()
        ai_api.BACKEND_FORWARDER = FakeBackendForwarder()

    def start_session(self):
        response = self.client.post("/api/ai/live/start")
        self.assertEqual(response.status_code, 200)
        return response.json()["session_id"]

    def make_jpeg(self):
        frame = np.zeros((240, 320, 3), dtype=np.uint8)
        success, encoded = cv2.imencode(".jpg", frame)
        self.assertTrue(success)
        return encoded.tobytes()

    def test_start_rejects_duplicate_session(self):
        self.start_session()

        response = self.client.post("/api/ai/live/start")

        self.assertEqual(response.status_code, 409)
        self.assertTrue(ai_api.live_state["active"])

    def test_frame_rejects_invalid_jpeg(self):
        session_id = self.start_session()

        response = self.client.post(
            "/api/ai/live/frame",
            params={"session_id": session_id},
            content=b"not-a-jpeg",
            headers={"Content-Type": "image/jpeg"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(ai_api.model.track_calls, 0)

    def test_frame_rejects_invalid_session(self):
        self.start_session()

        response = self.client.post(
            "/api/ai/live/frame",
            params={"session_id": "invalid-session"},
            content=self.make_jpeg(),
            headers={"Content-Type": "image/jpeg"},
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(ai_api.model.track_calls, 0)

    def test_valid_frame_is_processed(self):
        session_id = self.start_session()

        response = self.client.post(
            "/api/ai/live/frame",
            params={"session_id": session_id},
            content=self.make_jpeg(),
            headers={"Content-Type": "image/jpeg"},
        )

        self.assertEqual(response.status_code, 200)

        result = response.json()
        self.assertTrue(result["success"])
        self.assertEqual(result["session_id"], session_id)
        self.assertEqual(result["processed_frames"], 1)
        self.assertEqual(ai_api.model.track_calls, 1)

    def test_stop_clears_session(self):
        session_id = self.start_session()

        response = self.client.post(
            "/api/ai/live/stop",
            params={"session_id": session_id},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        self.assertFalse(ai_api.live_state["active"])
        self.assertFalse(ai_api.live_state["stopping"])
        self.assertIsNone(ai_api.live_state["session_id"])
        self.assertIsNone(ai_api.live_state["analyzer"])

    def test_stop_rejects_wrong_session(self):
        self.start_session()

        response = self.client.post(
            "/api/ai/live/stop",
            params={"session_id": "wrong-session"},
        )

        self.assertEqual(response.status_code, 409)
        self.assertTrue(ai_api.live_state["active"])

    def test_upload_is_rejected_during_live_monitoring(self):
        self.start_session()

        response = self.client.post(
            "/api/ai/upload",
            files={
                "file": (
                    "test.mp4",
                    b"fake-video-data",
                    "video/mp4",
                )
            },
        )

        self.assertEqual(response.status_code, 409)
        self.assertTrue(ai_api.live_state["active"])

    def test_recorded_detection_is_rejected_during_live_monitoring(self):
        self.start_session()

        response = self.client.post("/api/ai/detect")

        self.assertEqual(response.status_code, 409)
        self.assertTrue(ai_api.live_state["active"])


if __name__ == "__main__":
    unittest.main()



