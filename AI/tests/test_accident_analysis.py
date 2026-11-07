import os
import unittest
from unittest.mock import patch

from AI.accident_analysis import (
    AnalysisConfig,
    AccidentAnalyzer,
    POTENTIAL_ACCIDENT,
    NORMAL_TRAFFIC,
    SUSPECTED_ACCIDENT,
    UNCERTAIN,
)


FRAME_SIZE = (1000, 1000)
BOX_SIZE = (40, 20)


def detection(x, y=300):
    return (x, y, BOX_SIZE[0], BOX_SIZE[1])


class AccidentAnalyzerTests(unittest.TestCase):
    def test_constant_speed_traffic_is_normal(self):
        analyzer = AccidentAnalyzer()
        for frame_index in range(30):
            analyzer.update(
                frame_index,
                25,
                FRAME_SIZE,
                {1: detection(100 + frame_index * 10)},
            )

        result = analyzer.results(25)
        self.assertEqual(result["overall_classification"], NORMAL_TRAFFIC)
        self.assertEqual(result["events"], [])

    def test_multiple_vehicles_in_separate_lanes_are_normal_traffic(self):
        analyzer = AccidentAnalyzer()
        for frame_index in range(30):
            analyzer.update(
                frame_index,
                25,
                FRAME_SIZE,
                {
                    1: detection(100 + frame_index * 10, 250),
                    2: detection(800 - frame_index * 8, 750),
                },
            )

        result = analyzer.results(25)
        self.assertEqual(result["overall_classification"], NORMAL_TRAFFIC)
        self.assertEqual(result["events"], [])

    def test_proximity_is_potential_and_not_confirmed(self):
        analyzer = AccidentAnalyzer()
        analyzer.update(30, 30, FRAME_SIZE, {1: detection(100), 2: detection(110)})
        events = analyzer.update(
            31, 30, FRAME_SIZE, {1: detection(100), 2: detection(110)}
        )

        result = analyzer.results(30)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["classification"], POTENTIAL_ACCIDENT)
        self.assertEqual(events[0]["timestamp"], "00:00:01.033")
        self.assertEqual(events[0]["involved_vehicle_ids"], [1, 2])
        self.assertEqual(result["confirmed_accident_count"], 0)

    def test_synthetic_collision_like_interaction_is_suspected_not_confirmed(self):
        analyzer = AccidentAnalyzer()
        positions_a = [100, 120, 140, 160, 180] + [180] * 25
        positions_b = [400, 380, 360, 340, 200] + [200] * 25
        for frame_index, (x_a, x_b) in enumerate(zip(positions_a, positions_b)):
            analyzer.update(
                frame_index,
                25,
                FRAME_SIZE,
                {1: detection(x_a), 2: detection(x_b)},
            )

        result = analyzer.results(25)
        self.assertEqual(result["overall_classification"], SUSPECTED_ACCIDENT)
        self.assertEqual(result["suspected_accident_count"], 1)
        self.assertEqual(len(result["events"]), 1)
        evidence_types = {item["type"] for item in result["events"][0]["evidence"]}
        self.assertIn("vehicle_proximity", evidence_types)
        self.assertIn("sudden_deceleration", evidence_types)
        self.assertIn("stopped_after_possible_collision", evidence_types)
        self.assertEqual(result["events"][0]["classification"], SUSPECTED_ACCIDENT)
        self.assertEqual(result["confirmed_accident_count"], 0)

    def test_sudden_braking_without_interaction_remains_potential(self):
        analyzer = AccidentAnalyzer()
        positions = [100, 120, 140, 160, 161, 161, 161]
        for frame_index, x in enumerate(positions):
            analyzer.update(
                frame_index,
                25,
                FRAME_SIZE,
                {1: detection(x)},
            )

        result = analyzer.results(25)
        self.assertEqual(len(result["events"]), 1)
        evidence_types = {item["type"] for item in result["events"][0]["evidence"]}
        self.assertIn("sudden_deceleration", evidence_types)
        self.assertNotIn("vehicle_proximity", evidence_types)
        self.assertEqual(result["events"][0]["classification"], POTENTIAL_ACCIDENT)
        self.assertEqual(result["confirmed_accident_count"], 0)

    def test_approaching_vehicles_without_collision_remain_potential(self):
        analyzer = AccidentAnalyzer()
        positions = [(100 + 15 * i, 300 - 15 * i) for i in range(9)]
        for frame_index, (x_a, x_b) in enumerate(positions):
            analyzer.update(
                frame_index,
                25,
                FRAME_SIZE,
                {1: detection(x_a), 2: detection(x_b)},
            )

        result = analyzer.results(25)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["involved_vehicle_ids"], [1, 2])
        self.assertIn(
            "vehicle_proximity",
            {item["type"] for item in result["events"][0]["evidence"]},
        )
        self.assertEqual(result["events"][0]["classification"], POTENTIAL_ACCIDENT)
        self.assertEqual(result["confirmed_accident_count"], 0)

    def test_one_frame_proximity_is_not_registered_as_an_interaction(self):
        analyzer = AccidentAnalyzer()
        analyzer.update(0, 25, FRAME_SIZE, {1: detection(100), 2: detection(120)})

        result = analyzer.results(25)
        self.assertEqual(result["events"], [])
        self.assertEqual(result["confirmed_accident_count"], 0)

    def test_tracking_id_loss_and_recovery_resets_motion_history(self):
        analyzer = AccidentAnalyzer()
        for frame_index, x in enumerate((100, 120, 140)):
            analyzer.update(frame_index, 25, FRAME_SIZE, {1: detection(x)})

        analyzer.update(40, 25, FRAME_SIZE, {})
        analyzer.update(41, 25, FRAME_SIZE, {1: detection(400)})
        analyzer.update(42, 25, FRAME_SIZE, {1: detection(420)})
        analyzer.update(43, 25, FRAME_SIZE, {1: detection(440)})

        result = analyzer.results(25)
        self.assertEqual(result["events"], [])
        self.assertEqual(result["confirmed_accident_count"], 0)

    def test_abrupt_turn_without_interaction_remains_potential(self):
        analyzer = AccidentAnalyzer()
        positions = [(100, 200), (150, 200), (200, 200), (150, 200)]
        for frame_index, (x, y) in enumerate(positions):
            analyzer.update(
                frame_index,
                25,
                FRAME_SIZE,
                {5: detection(x, y)},
            )

        result = analyzer.results(25)
        self.assertEqual(result["overall_classification"], POTENTIAL_ACCIDENT)
        self.assertEqual(result["events"][0]["involved_vehicle_ids"], [5])
        self.assertIn(
            "abrupt_direction_change",
            {item["type"] for item in result["events"][0]["evidence"]},
        )

    def test_persistent_close_tracking_frames_are_deduplicated(self):
        analyzer = AccidentAnalyzer()
        for frame_index in range(20):
            analyzer.update(
                frame_index,
                25,
                FRAME_SIZE,
                {1: detection(100), 2: detection(110)},
            )

        result = analyzer.results(25)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["event_id"], "AI-00001")
        proximity = next(
            item
            for item in result["events"][0]["evidence"]
            if item["type"] == "vehicle_proximity"
        )
        self.assertEqual(proximity["metrics"]["observations"], 2)

    def test_motion_speed_is_normalized_by_video_fps(self):
        speeds = []
        for fps, step in ((25, 20), (50, 10)):
            analyzer = AccidentAnalyzer()
            positions = [100, 100 + step, 100 + 2 * step, 100 + 2.1 * step]
            for frame_index, x in enumerate(positions):
                analyzer.update(
                    frame_index,
                    fps,
                    FRAME_SIZE,
                    {1: detection(x)},
                )
            evidence = analyzer.results(fps)["events"][0]["evidence"][0]
            speeds.append(
                evidence["metrics"]["previous_speed_diagonals_per_second"]
            )

        self.assertAlmostEqual(speeds[0], speeds[1], places=3)

    def test_missing_and_invalid_tracks_do_not_create_accidents(self):
        analyzer = AccidentAnalyzer()
        analyzer.update(0, 25, FRAME_SIZE, {1: detection(100)})
        analyzer.update(1, 25, FRAME_SIZE, {})
        analyzer.update(2, 25, FRAME_SIZE, {1: (float("nan"), 300, 40, 20)})

        result = analyzer.results(25)
        self.assertEqual(result["overall_classification"], UNCERTAIN)
        self.assertEqual(result["unique_tracking_ids"], 1)

    def test_no_tracks_is_uncertain_not_normal_traffic(self):
        analyzer = AccidentAnalyzer()
        analyzer.update(0, 25, FRAME_SIZE, {})

        self.assertEqual(analyzer.results(25)["overall_classification"], UNCERTAIN)

    def test_analysis_thresholds_can_be_configured_and_validated(self):
        with patch.dict(os.environ, {"AI_PROXIMITY_BOX_RATIO": "1.7"}):
            self.assertEqual(
                AnalysisConfig.from_environment().proximity_box_ratio,
                1.7,
            )
        with patch.dict(os.environ, {"AI_DECELERATION_RATIO": "1.2"}):
            with self.assertRaises(ValueError):
                AnalysisConfig.from_environment()


if __name__ == "__main__":
    unittest.main()
