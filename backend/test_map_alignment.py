import math
import unittest

import numpy as np

try:
    from .map_alignment import (
        MapAlignmentError,
        _rotate_grid,
        align_occupancy_maps,
        transform_pose_between_maps,
    )
except ImportError:
    from map_alignment import (
        MapAlignmentError,
        _rotate_grid,
        align_occupancy_maps,
        transform_pose_between_maps,
    )


def _snapshot(data, map_id, frame_id):
    height, width = data.shape
    return {
        "map": {
            "map_id": map_id,
            "version": "test-version",
            "frame_id": frame_id,
            "resolution_m": 0.1,
            "width": width,
            "height": height,
            "origin": {"x": 0.0, "y": 0.0, "yaw_rad": 0.0},
        },
        "data": data.astype(int).ravel().tolist(),
    }


class MapAlignmentTests(unittest.TestCase):
    def test_recovers_asymmetric_rotation_and_translation_and_transforms_pose(self):
        reference = np.zeros((48, 52), dtype=np.int16)
        reference[[4, 43], 4:48] = 100
        reference[4:44, [4, 47]] = 100
        reference[11:32, 13] = 100
        reference[11, 13:29] = 100
        reference[28:38, 35:39] = 100
        reference[37, 29:39] = 100
        reference[18:23, 31] = 100

        expected_rotation = math.radians(24)
        rotated_occupied, rotated_known, _, _ = _rotate_grid(
            reference >= 65,
            reference >= 0,
            expected_rotation,
        )
        active = np.full((92, 96), -1, dtype=np.int16)
        row_offset, column_offset = 13, 17
        height, width = rotated_known.shape
        active[row_offset:row_offset + height, column_offset:column_offset + width] = 0
        target_view = active[row_offset:row_offset + height, column_offset:column_offset + width]
        target_view[rotated_occupied] = 100

        reference_snapshot = _snapshot(reference, "room-a", "map")
        active_snapshot = _snapshot(active, "room-b", "active_map")
        alignment = align_occupancy_maps(reference_snapshot, active_snapshot)

        self.assertAlmostEqual(alignment["rotation_rad"], expected_rotation, delta=math.radians(3))
        self.assertGreaterEqual(alignment["score"], 0.55)
        self.assertGreaterEqual(alignment["overlap_ratio"], 0.9)
        _, _, source_center, rotated_center = _rotate_grid(
            reference >= 65,
            reference >= 0,
            expected_rotation,
        )
        expected_translation_x = (
            column_offset
            + rotated_center[0]
            - (math.cos(expected_rotation) * source_center[0] - math.sin(expected_rotation) * source_center[1])
        ) * alignment["alignment_resolution_m"]
        expected_translation_y = (
            row_offset
            + rotated_center[1]
            - (math.sin(expected_rotation) * source_center[0] + math.cos(expected_rotation) * source_center[1])
        ) * alignment["alignment_resolution_m"]
        self.assertAlmostEqual(
            alignment["translation_m"]["x"], expected_translation_x, delta=0.2
        )
        self.assertAlmostEqual(
            alignment["translation_m"]["y"], expected_translation_y, delta=0.2
        )
        pose = transform_pose_between_maps(
            {"x": 1.0, "y": 1.0, "yaw_rad": 0.5},
            reference_snapshot,
            active_snapshot,
            alignment,
        )
        self.assertTrue(math.isfinite(pose["x"]))
        self.assertTrue(math.isfinite(pose["y"]))
        self.assertAlmostEqual(pose["yaw_rad"], 0.5 + expected_rotation, delta=math.radians(3))

    def test_symmetric_map_is_rejected_as_ambiguous(self):
        symmetric = np.full((48, 48), -1, dtype=np.int16)
        symmetric[4:44, 4:44] = 0
        symmetric[[4, 43], 4:44] = 100
        symmetric[4:44, [4, 43]] = 100
        symmetric[23:25, 4:44] = 100
        symmetric[4:44, 23:25] = 100
        with self.assertRaisesRegex(MapAlignmentError, "ambiguous"):
            align_occupancy_maps(
                _snapshot(symmetric, "room", "map"),
                _snapshot(symmetric.copy(), "room", "map"),
            )

    def test_unrelated_maps_and_invalid_snapshot_fail_closed(self):
        first = np.zeros((48, 48), dtype=np.int16)
        second = np.zeros((48, 48), dtype=np.int16)
        first[4:44, [7, 13, 31, 40]] = 100
        first[[9, 17, 29, 38], 5:43] = 100
        second[5:43, [6, 12, 23, 39]] = 100
        second[[6, 15, 22, 41], 4:44] = 100
        with self.assertRaises(MapAlignmentError):
            align_occupancy_maps(_snapshot(first, "a", "map"), _snapshot(second, "b", "map"))

        invalid = _snapshot(first, "a", "map")
        invalid["data"].pop()
        with self.assertRaisesRegex(MapAlignmentError, "dimensions or occupancy length"):
            align_occupancy_maps(invalid, _snapshot(first, "a", "map"))


if __name__ == "__main__":
    unittest.main()