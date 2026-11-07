import json
import logging
import math
import queue
import threading
import time
from collections import deque
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


LOGGER = logging.getLogger(__name__)
RETRY_DELAYS_SECONDS = (0.25, 0.75)
MAX_PENDING_EVENTS = 256
MAX_REMEMBERED_EVENT_IDS = 4096


def should_forward_event(event, confidence_threshold):
    """Forward suspected events or threshold-qualified potentials only.

    The backend contract accepts qualitative confidence for suspected events.
    Potential events require a numeric confidence in [0, 1] at the shared
    AI_FORWARD_CONFIDENCE_THRESHOLD. The video analyzer currently emits only
    qualitative confidence, so its potential events remain local.
    """
    classification = event.get("classification")
    confidence = event.get("confidence_score", event.get("confidence"))
    valid_confidence = (
        isinstance(confidence, (int, float))
        and not isinstance(confidence, bool)
        and math.isfinite(confidence)
        and 0 <= confidence <= 1
    )
    if classification == "suspected_accident":
        return valid_confidence or (
            isinstance(confidence, str) and bool(confidence.strip())
        )
    if classification != "potential_accident":
        return False

    return valid_confidence and confidence >= confidence_threshold


def make_backend_payload(event):
    payload = {
        "eventId": event["event_id"],
        "timestamp": event["timestamp"],
        "vehicleIds": event.get("involved_vehicle_ids", []),
        "confidence": event.get("confidence_score", event.get("confidence")),
        "eventType": event["classification"],
        "evidence": event.get("evidence", []),
        "validated": bool(event.get("validated", False)),
    }
    if event.get("latitude") is not None and event.get("longitude") is not None:
        payload["latitude"] = event["latitude"]
        payload["longitude"] = event["longitude"]
    return payload


def _send_event(url, payload, timeout_seconds):
    request = Request(
        url,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            response.read(64 * 1024)
            return response.status
    except HTTPError as error:
        return error.code


class BackendEventForwarder:
    """Asynchronously sends eligible events with bounded retries and queue size."""

    def __init__(
        self,
        url,
        timeout_seconds=0.5,
        sender=None,
        retry_delays=RETRY_DELAYS_SECONDS,
        max_pending=MAX_PENDING_EVENTS,
    ):
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be finite and positive")
        self.url = url.rstrip("/") + "/api/ai/event"
        self.timeout_seconds = timeout_seconds
        self._sender = sender or _send_event
        self._retry_delays = tuple(retry_delays)
        self._queue = queue.Queue(maxsize=max_pending)
        self._lock = threading.Lock()
        self._stopping = False
        self._pending_ids = set()
        self._remembered_ids = set()
        self._remembered_order = deque()
        self._forwarded = 0
        self._failed = 0
        self._last_error = None
        self._worker = threading.Thread(
            target=self._run, name="ai-backend-forwarder", daemon=True
        )
        self._worker.start()

    def submit(self, event, confidence_threshold):
        if not should_forward_event(event, confidence_threshold):
            return False
        event_id = event.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            raise ValueError("eligible AI events must have a stable event_id")

        payload = make_backend_payload(event)
        with self._lock:
            if self._stopping:
                return False
            if event_id in self._remembered_ids or event_id in self._pending_ids:
                return False
            try:
                self._queue.put_nowait((event_id, payload))
            except queue.Full:
                self._failed += 1
                self._last_error = "AI-to-C++ forwarding queue is full"
                return False
            self._pending_ids.add(event_id)
        return True

    def status(self):
        with self._lock:
            return {
                "queued": self._queue.qsize(),
                "forwarded": self._forwarded,
                "failed": self._failed,
                "lastError": self._last_error,
            }

    def close(self, wait=True):
        with self._lock:
            self._stopping = True
        self._queue.put(None)
        if wait:
            self._worker.join()

    def _run(self):
        while True:
            item = self._queue.get()
            try:
                if item is None:
                    return
                event_id, payload = item
                self._deliver(event_id, payload)
            finally:
                self._queue.task_done()

    def _deliver(self, event_id, payload):
        attempts = 1 + len(self._retry_delays)
        last_error = None
        for attempt in range(attempts):
            try:
                status = self._sender(self.url, payload, self.timeout_seconds)
                if 200 <= status < 300:
                    with self._lock:
                        self._forwarded += 1
                        self._remember_event_id(event_id)
                    return
                last_error = "C++ backend returned HTTP {}".format(status)
                if status < 500:
                    break
            except (URLError, TimeoutError, OSError) as error:
                last_error = str(error)
            except Exception:
                LOGGER.exception("Unexpected AI-to-C++ forwarding failure")
                last_error = "Unexpected forwarding failure"

            if attempt < len(self._retry_delays):
                time.sleep(self._retry_delays[attempt])

        with self._lock:
            self._pending_ids.discard(event_id)
            self._failed += 1
            self._last_error = last_error
        LOGGER.warning(
            "Could not forward AI event %s after %s attempts: %s",
            event_id,
            attempts,
            last_error,
        )

    def _remember_event_id(self, event_id):
        self._pending_ids.discard(event_id)
        if event_id in self._remembered_ids:
            return
        self._remembered_ids.add(event_id)
        self._remembered_order.append(event_id)
        if len(self._remembered_order) > MAX_REMEMBERED_EVENT_IDS:
            self._remembered_ids.discard(self._remembered_order.popleft())
