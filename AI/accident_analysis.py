import math
import os
from collections import defaultdict, deque
from copy import deepcopy
from dataclasses import dataclass
from typing import Deque, Dict, List, Tuple


NORMAL_TRAFFIC = "normal_traffic"
UNCERTAIN = "uncertain"
POTENTIAL_ACCIDENT = "potential_accident"
SUSPECTED_ACCIDENT = "suspected_accident"
CONFIRMED_ACCIDENT = "confirmed_accident"

CLASSIFICATION_LABELS = {
    NORMAL_TRAFFIC: "Normal Traffic",
    UNCERTAIN: "Uncertain (insufficient tracking evidence)",
    POTENTIAL_ACCIDENT: "Potential Accident",
    SUSPECTED_ACCIDENT: "Suspected Accident",
    CONFIRMED_ACCIDENT: "Confirmed Accident",
}

EVIDENCE_LABELS = {
    "vehicle_proximity": "Vehicles approached closely",
    "bounding_box_overlap": "Vehicle bounding boxes overlapped",
    "sudden_deceleration": "Sudden decrease in estimated speed",
    "abrupt_direction_change": "Abrupt trajectory direction change",
    "stopped_after_possible_collision": "Vehicle stopped after a close interaction",
}


@dataclass(frozen=True)
class AnalysisConfig:
    proximity_box_ratio: float = 1.0
    overlap_iou_threshold: float = 0.1
    min_moving_speed: float = 0.04
    stationary_speed: float = 0.008
    deceleration_ratio: float = 0.45
    min_deceleration: float = 0.03
    abrupt_turn_degrees: float = 120.0
    stop_duration_seconds: float = 0.8
    evidence_window_seconds: float = 2.5
    event_merge_seconds: float = 2.0
    contact_gap_seconds: float = 0.5
    max_track_gap_seconds: float = 1.0
    minimum_normal_observation_seconds: float = 1.0
    minimum_contact_observations: int = 2

    def __post_init__(self):
        positive_values = (
            self.proximity_box_ratio,
            self.min_moving_speed,
            self.stationary_speed,
            self.min_deceleration,
            self.stop_duration_seconds,
            self.evidence_window_seconds,
            self.event_merge_seconds,
            self.contact_gap_seconds,
            self.max_track_gap_seconds,
            self.minimum_normal_observation_seconds,
        )
        if not all(math.isfinite(value) and value > 0 for value in positive_values):
            raise ValueError("Analysis thresholds and durations must be finite and positive")
        if not 0 < self.overlap_iou_threshold <= 1:
            raise ValueError("overlap_iou_threshold must be between 0 and 1")
        if not 0 < self.deceleration_ratio < 1:
            raise ValueError("deceleration_ratio must be between 0 and 1")
        if self.stationary_speed >= self.min_moving_speed:
            raise ValueError("stationary_speed must be less than min_moving_speed")
        if not 0 < self.abrupt_turn_degrees <= 180:
            raise ValueError("abrupt_turn_degrees must be between 0 and 180")
        if (
            isinstance(self.minimum_contact_observations, bool)
            or not isinstance(self.minimum_contact_observations, int)
            or self.minimum_contact_observations < 2
        ):
            raise ValueError("minimum_contact_observations must be an integer of at least 2")

    @classmethod
    def from_environment(cls):
        env_names = {
            "proximity_box_ratio": "AI_PROXIMITY_BOX_RATIO",
            "overlap_iou_threshold": "AI_OVERLAP_IOU_THRESHOLD",
            "min_moving_speed": "AI_MIN_MOVING_SPEED",
            "stationary_speed": "AI_STATIONARY_SPEED",
            "deceleration_ratio": "AI_DECELERATION_RATIO",
            "min_deceleration": "AI_MIN_DECELERATION",
            "abrupt_turn_degrees": "AI_ABRUPT_TURN_DEGREES",
            "stop_duration_seconds": "AI_STOP_DURATION_SECONDS",
            "evidence_window_seconds": "AI_EVIDENCE_WINDOW_SECONDS",
            "event_merge_seconds": "AI_EVENT_MERGE_SECONDS",
            "contact_gap_seconds": "AI_CONTACT_GAP_SECONDS",
            "max_track_gap_seconds": "AI_MAX_TRACK_GAP_SECONDS",
            "minimum_normal_observation_seconds": "AI_NORMAL_OBSERVATION_SECONDS",
        }
        defaults = cls()
        configured = {
            field_name: float(os.environ[env_name])
            for field_name, env_name in env_names.items()
            if env_name in os.environ
        }
        for field_name in configured:
            if not math.isfinite(configured[field_name]):
                raise ValueError("{} must be finite".format(env_names[field_name]))
        return cls(**{
            field_name: configured.get(field_name, getattr(defaults, field_name))
            for field_name in env_names
        })


@dataclass(frozen=True)
class TrackSample:
    frame: int
    timestamp_seconds: float
    center_x: float
    center_y: float
    width: float
    height: float


class AccidentAnalyzer:
    """Conservative video-only indicators; visual evidence never confirms a crash."""

    def __init__(self, config=None):
        self.config = config or AnalysisConfig.from_environment()
        self._tracks: Dict[int, Deque[TrackSample]] = defaultdict(
            lambda: deque(maxlen=64)
        )
        self._recent_motion: Dict[int, Deque[dict]] = defaultdict(
            lambda: deque(maxlen=32)
        )
        self._last_moving_at: Dict[int, float] = {}
        self._stopped_since: Dict[int, float] = {}
        self._contacts: Dict[Tuple[int, int], dict] = {}
        self._events: List[dict] = []
        self._next_event_id = 1

    def update(self, frame_index, fps, frame_size, detections):
        if frame_index < 0 or not math.isfinite(fps) or fps <= 0:
            raise ValueError("frame_index and fps must be valid")

        frame_width, frame_height = frame_size
        frame_diagonal = math.hypot(frame_width, frame_height)
        if frame_width <= 0 or frame_height <= 0 or frame_diagonal <= 0:
            raise ValueError("frame_size must contain positive dimensions")

        timestamp = frame_index / fps
        current_samples = {}
        for track_id, box in detections.items():
            sample = self._make_sample(
                track_id, box, frame_index, timestamp, frame_diagonal
            )
            if sample is not None:
                current_samples[int(track_id)] = sample

        for track_id, sample in current_samples.items():
            history = self._tracks[track_id]
            if history and sample.timestamp_seconds - history[-1].timestamp_seconds > self.config.max_track_gap_seconds:
                history.clear()
                self._recent_motion[track_id].clear()
                self._stopped_since.pop(track_id, None)
                self._last_moving_at.pop(track_id, None)
            if not history or history[-1].frame != frame_index:
                history.append(sample)

        motion_signals = {}
        stop_states = {}
        for track_id in current_samples:
            metrics = self._motion_metrics(self._tracks[track_id])
            signals = self._signals_for_track(track_id, metrics, timestamp, frame_index)
            motion_signals[track_id] = signals
            stop_states[track_id] = self._stop_state(track_id, metrics, timestamp)
            for signal in signals:
                self._recent_motion[track_id].append(signal)

        pair_evidence = defaultdict(list)
        connected_tracks = set()
        track_ids = list(current_samples)
        for index, track_a in enumerate(track_ids):
            for track_b in track_ids[index + 1:]:
                pair = tuple(sorted((track_a, track_b)))
                sample_a = current_samples[track_a]
                sample_b = current_samples[track_b]
                distance_ratio = self._distance_ratio(sample_a, sample_b)
                overlap = self._intersection_over_union(sample_a, sample_b)
                is_close = distance_ratio <= self.config.proximity_box_ratio
                is_overlapping = overlap >= self.config.overlap_iou_threshold
                if not is_close and not is_overlapping:
                    continue

                connected_tracks.update(pair)
                contact = self._contacts.get(pair)
                new_contact = (
                    contact is None
                    or timestamp - contact["last_seen_seconds"] > self.config.contact_gap_seconds
                )
                if new_contact:
                    contact = {
                        "first_seen_seconds": timestamp,
                        "last_seen_seconds": timestamp,
                        "observations": 1,
                        "proximity_recorded": False,
                        "frame": frame_index,
                        "distance_ratio": distance_ratio,
                        "intersection_over_union": overlap,
                    }
                    self._contacts[pair] = contact
                else:
                    contact["last_seen_seconds"] = timestamp
                    contact["observations"] += 1
                    contact["distance_ratio"] = min(contact["distance_ratio"], distance_ratio)
                    contact["intersection_over_union"] = max(
                        contact["intersection_over_union"], overlap
                    )

                if contact["observations"] < self.config.minimum_contact_observations:
                    continue

                if not contact["proximity_recorded"]:
                    contact["proximity_recorded"] = True
                    pair_evidence[pair].append({
                        "type": "vehicle_proximity",
                        "frame": frame_index,
                        "timestamp_seconds": timestamp,
                        "metrics": {
                            "center_distance_over_mean_box_diagonal": round(distance_ratio, 4),
                            "proximity_threshold": self.config.proximity_box_ratio,
                            "observations": contact["observations"],
                            "duration_seconds": round(
                                timestamp - contact["first_seen_seconds"], 3
                            ),
                        },
                    })

                if is_overlapping:
                    pair_evidence[pair].append({
                        "type": "bounding_box_overlap",
                        "frame": frame_index,
                        "timestamp_seconds": timestamp,
                        "metrics": {"intersection_over_union": round(overlap, 4)},
                    })

                for track_id in pair:
                    for signal in self._recent_signals(track_id, timestamp):
                        if signal["timestamp_seconds"] >= contact["first_seen_seconds"]:
                            pair_evidence[pair].append(signal)

        self._prune_contacts(timestamp)
        for pair, contact in self._contacts.items():
            for track_id in pair:
                stop = stop_states.get(track_id)
                if stop is None:
                    continue
                stop_started_at = stop["started_at"]
                if (
                    contact["first_seen_seconds"] <= stop_started_at
                    and stop_started_at - contact["last_seen_seconds"] <= self.config.evidence_window_seconds
                    and timestamp - stop_started_at >= self.config.stop_duration_seconds
                ):
                    pair_evidence[pair].append({
                        "type": "stopped_after_possible_collision",
                        "frame": frame_index,
                        "timestamp_seconds": timestamp,
                        "metrics": {
                            "stopped_duration_seconds": round(timestamp - stop_started_at, 3),
                            "contact_last_seen_seconds": round(contact["last_seen_seconds"], 3),
                        },
                    })

        updated_events = {}
        for pair, evidence in pair_evidence.items():
            if evidence:
                event = self._record_event(pair, evidence, frame_index, timestamp)
                updated_events[event["event_id"]] = event

        for track_id, signals in motion_signals.items():
            if track_id in connected_tracks:
                continue
            independent_signals = [
                signal for signal in signals
                if signal["type"] in ("sudden_deceleration", "abrupt_direction_change")
            ]
            if independent_signals:
                event = self._record_event(
                    (track_id,), independent_signals, frame_index, timestamp
                )
                updated_events[event["event_id"]] = event

        return list(updated_events.values())

    def results(self, fps, fps_estimated=False, total_vehicle_detections=0):
        events = deepcopy(self._events)
        for event in events:
            event.pop("last_evidence_seconds", None)
        suspected_count = sum(
            event["classification"] == SUSPECTED_ACCIDENT for event in events
        )
        potential_count = sum(
            event["classification"] == POTENTIAL_ACCIDENT for event in events
        )
        confirmed_count = sum(
            event["classification"] == CONFIRMED_ACCIDENT for event in events
        )
        adequately_observed = any(
            len(history) >= 3
            and history[-1].timestamp_seconds - history[0].timestamp_seconds
            >= self.config.minimum_normal_observation_seconds
            for history in self._tracks.values()
        )
        if confirmed_count:
            overall_classification = CONFIRMED_ACCIDENT
        elif suspected_count:
            overall_classification = SUSPECTED_ACCIDENT
        elif potential_count:
            overall_classification = POTENTIAL_ACCIDENT
        else:
            overall_classification = NORMAL_TRAFFIC if adequately_observed else UNCERTAIN

        return {
            "overall_classification": overall_classification,
            "overall_classification_label": CLASSIFICATION_LABELS[overall_classification],
            "total_vehicle_detections": total_vehicle_detections,
            "unique_tracking_ids": len(self._tracks),
            "potential_accident_count": potential_count,
            "suspected_accident_count": suspected_count,
            "confirmed_accident_count": confirmed_count,
            "fps": round(fps, 3),
            "fps_estimated": fps_estimated,
            "timestamp_method": "frame_index / video_fps",
            "thresholds": {
                "proximity_box_ratio": self.config.proximity_box_ratio,
                "overlap_iou_threshold": self.config.overlap_iou_threshold,
                "minimum_moving_speed_diagonals_per_second": self.config.min_moving_speed,
                "stationary_speed_diagonals_per_second": self.config.stationary_speed,
                "deceleration_ratio": self.config.deceleration_ratio,
                "minimum_deceleration_diagonals_per_second": self.config.min_deceleration,
                "abrupt_turn_degrees": self.config.abrupt_turn_degrees,
                "stop_duration_seconds": self.config.stop_duration_seconds,
                "evidence_window_seconds": self.config.evidence_window_seconds,
                "event_merge_seconds": self.config.event_merge_seconds,
                "minimum_normal_observation_seconds": self.config.minimum_normal_observation_seconds,
                "minimum_contact_observations": self.config.minimum_contact_observations,
            },
            "events": events,
            "note": (
                "YOLO and tracking provide visual indicators only. "
                "No video-only event is confirmed without independent validation."
            ),
        }

    def _make_sample(self, track_id, box, frame_index, timestamp, frame_diagonal):
        try:
            x, y, width, height = (float(value) for value in box[:4])
            track_id = int(track_id)
        except (TypeError, ValueError, IndexError):
            return None
        if (
            not all(math.isfinite(value) for value in (x, y, width, height))
            or width <= 0
            or height <= 0
        ):
            return None
        return TrackSample(
            frame=frame_index,
            timestamp_seconds=timestamp,
            center_x=x / frame_diagonal,
            center_y=y / frame_diagonal,
            width=width / frame_diagonal,
            height=height / frame_diagonal,
        )

    @staticmethod
    def _motion_metrics(history):
        if len(history) < 2:
            return None

        previous, current = history[-2], history[-1]
        elapsed = current.timestamp_seconds - previous.timestamp_seconds
        if elapsed <= 0:
            return None
        dx = current.center_x - previous.center_x
        dy = current.center_y - previous.center_y
        speed = math.hypot(dx, dy) / elapsed
        metrics = {
            "speed": speed,
            "direction": (dx / elapsed, dy / elapsed),
            "previous_speed": None,
            "turn_degrees": None,
        }
        if len(history) >= 3:
            earlier = history[-3]
            previous_elapsed = previous.timestamp_seconds - earlier.timestamp_seconds
            if previous_elapsed > 0:
                previous_dx = previous.center_x - earlier.center_x
                previous_dy = previous.center_y - earlier.center_y
                previous_speed = math.hypot(previous_dx, previous_dy) / previous_elapsed
                metrics["previous_speed"] = previous_speed
                if previous_speed > 0 and speed > 0:
                    dot = (
                        previous_dx * dx + previous_dy * dy
                    ) / (math.hypot(previous_dx, previous_dy) * math.hypot(dx, dy))
                    metrics["turn_degrees"] = math.degrees(
                        math.acos(max(-1.0, min(1.0, dot)))
                    )
        return metrics

    def _signals_for_track(self, track_id, metrics, timestamp, frame_index):
        if metrics is None:
            return []
        signals = []
        previous_speed = metrics["previous_speed"]
        if (
            previous_speed is not None
            and previous_speed >= self.config.min_moving_speed
            and metrics["speed"] <= previous_speed * self.config.deceleration_ratio
            and previous_speed - metrics["speed"] >= self.config.min_deceleration
        ):
            signals.append({
                "type": "sudden_deceleration",
                "track_id": track_id,
                "frame": frame_index,
                "timestamp_seconds": timestamp,
                "metrics": {
                    "previous_speed_diagonals_per_second": round(previous_speed, 4),
                    "current_speed_diagonals_per_second": round(metrics["speed"], 4),
                    "speed_ratio": round(metrics["speed"] / previous_speed, 4),
                },
            })

        turn = metrics["turn_degrees"]
        if (
            turn is not None
            and metrics["previous_speed"] >= self.config.min_moving_speed
            and metrics["speed"] >= self.config.min_moving_speed
            and turn >= self.config.abrupt_turn_degrees
        ):
            signals.append({
                "type": "abrupt_direction_change",
                "track_id": track_id,
                "frame": frame_index,
                "timestamp_seconds": timestamp,
                "metrics": {
                    "direction_change_degrees": round(turn, 2),
                    "speed_diagonals_per_second": round(metrics["speed"], 4),
                },
            })
        return signals

    def _stop_state(self, track_id, metrics, timestamp):
        if metrics is None:
            return None
        speed = metrics["speed"]
        if speed >= self.config.min_moving_speed:
            self._last_moving_at[track_id] = timestamp
            self._stopped_since.pop(track_id, None)
            return None
        if speed > self.config.stationary_speed:
            self._stopped_since.pop(track_id, None)
            return None

        stopped_since = self._stopped_since.setdefault(track_id, timestamp)
        last_moving = self._last_moving_at.get(track_id)
        if (
            last_moving is not None
            and timestamp - last_moving <= self.config.evidence_window_seconds
            and timestamp - stopped_since >= self.config.stop_duration_seconds
        ):
            return {"started_at": stopped_since}
        return None

    def _recent_signals(self, track_id, timestamp):
        recent = self._recent_motion.get(track_id, ())
        return [
            signal
            for signal in recent
            if timestamp - signal["timestamp_seconds"] <= self.config.evidence_window_seconds
        ]


    def _record_event(self, track_ids, evidence, frame_index, timestamp):
        track_ids = set(track_ids)
        existing = None

        for event in reversed(self._events):
            if timestamp - event["last_evidence_seconds"] > self.config.event_merge_seconds:
                continue
            if track_ids.intersection(event["trackIds"]):
                existing = event
                break

        if existing is None:
            event_id = "AI-{:05d}".format(self._next_event_id)
            self._next_event_id += 1

            existing = {
                "event_id": event_id,
                "id": event_id,
                "frame": frame_index,
                "timestamp_seconds": round(timestamp, 3),
                "timestamp": format_timestamp(timestamp),
                "trackIds": [],
                "involved_vehicle_ids": [],
                "classification": POTENTIAL_ACCIDENT,
                "classification_label": CLASSIFICATION_LABELS[POTENTIAL_ACCIDENT],
                "confidence": "low",
                "evidence": [],
                "reason": "",
                "label": "Potential Accident indicators",
                "validated": False,
                "validation_status": "requires_independent_validation",
                "last_evidence_seconds": timestamp,
            }
            self._events.append(existing)

        all_track_ids = sorted(track_ids.union(existing["trackIds"]))
        existing["trackIds"] = all_track_ids
        existing["involved_vehicle_ids"] = all_track_ids
        existing["last_evidence_seconds"] = timestamp

        evidence_by_type = {
            entry["type"]: entry for entry in existing["evidence"]
        }

        for item in evidence:
            evidence_type = item["type"]

            if evidence_type in evidence_by_type:
                stored = evidence_by_type[evidence_type]

                # Count each evidence type at most once per frame.
                if item["frame"] > stored["last_frame"]:
                    stored["last_frame"] = item["frame"]
                    stored["last_timestamp_seconds"] = round(
                        item["timestamp_seconds"], 3
                    )
                    stored["observations"] += 1
                    stored["metrics"] = item.get(
                        "metrics", stored["metrics"]
                    )

            else:
                stored = {
                    "type": evidence_type,
                    "label": EVIDENCE_LABELS[evidence_type],
                    "first_frame": item["frame"],
                    "last_frame": item["frame"],
                    "first_timestamp_seconds": round(
                        item["timestamp_seconds"], 3
                    ),
                    "last_timestamp_seconds": round(
                        item["timestamp_seconds"], 3
                    ),
                    "observations": 1,
                    "metrics": item.get("metrics", {}),
                }

                existing["evidence"].append(stored)
                evidence_by_type[evidence_type] = stored

        evidence_types = {
            entry["type"] for entry in existing["evidence"]
        }

        has_interaction = bool(
            evidence_types.intersection(
                ("vehicle_proximity", "bounding_box_overlap")
            )
        )

        has_collision_response = bool(
            "stopped_after_possible_collision" in evidence_types
        )

        if existing["validated"]:
            classification = CONFIRMED_ACCIDENT
        elif has_interaction and has_collision_response:
            classification = SUSPECTED_ACCIDENT
        else:
            classification = POTENTIAL_ACCIDENT

        existing["classification"] = classification
        existing["classification_label"] = CLASSIFICATION_LABELS[
            classification
        ]
        existing["confidence"] = (
            "medium"
            if classification == SUSPECTED_ACCIDENT
            else "low"
        )
        existing["label"] = "{} indicators".format(
            CLASSIFICATION_LABELS[classification]
        )
        existing["reason"] = "; ".join(
            entry["label"] for entry in existing["evidence"]
        )

        return existing

    @staticmethod
    def _distance_ratio(sample_a, sample_b):
        distance = math.hypot(
            sample_a.center_x - sample_b.center_x,
            sample_a.center_y - sample_b.center_y,
        )
        mean_diagonal = (
            math.hypot(sample_a.width, sample_a.height)
            + math.hypot(sample_b.width, sample_b.height)
        ) / 2
        return distance / mean_diagonal if mean_diagonal else math.inf

    @staticmethod
    def _intersection_over_union(sample_a, sample_b):
        a_left = sample_a.center_x - sample_a.width / 2
        a_right = sample_a.center_x + sample_a.width / 2
        a_top = sample_a.center_y - sample_a.height / 2
        a_bottom = sample_a.center_y + sample_a.height / 2
        b_left = sample_b.center_x - sample_b.width / 2
        b_right = sample_b.center_x + sample_b.width / 2
        b_top = sample_b.center_y - sample_b.height / 2
        b_bottom = sample_b.center_y + sample_b.height / 2
        intersection_width = max(0.0, min(a_right, b_right) - max(a_left, b_left))
        intersection_height = max(0.0, min(a_bottom, b_bottom) - max(a_top, b_top))
        intersection = intersection_width * intersection_height
        union = sample_a.width * sample_a.height + sample_b.width * sample_b.height - intersection
        return intersection / union if union > 0 else 0.0

    def _prune_contacts(self, timestamp):
        expiry = max(
            self.config.evidence_window_seconds,
            self.config.event_merge_seconds,
        )
        for pair, contact in list(self._contacts.items()):
            if timestamp - contact["last_seen_seconds"] > expiry:
                del self._contacts[pair]


def format_timestamp(timestamp_seconds):
    milliseconds = int(round(timestamp_seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return "{:02d}:{:02d}:{:02d}.{:03d}".format(
        hours, minutes, seconds, milliseconds
    )
