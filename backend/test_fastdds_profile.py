import unittest
import xml.etree.ElementTree as ET

try:
    from .ros.fastdds_profile import FAST_DDS_NAMESPACE, build_fastdds_profile
except ImportError:
    from ros.fastdds_profile import FAST_DDS_NAMESPACE, build_fastdds_profile


class FastDdsProfileTests(unittest.TestCase):
    def test_profile_limits_ros_udp_to_selected_robot_interface(self):
        root = ET.fromstring(build_fastdds_profile("192.168.123.164"))
        ns = {"dds": FAST_DDS_NAMESPACE}

        self.assertEqual(
            root.findtext(
                "dds:transport_descriptors/dds:transport_descriptor/"
                "dds:interfaceWhiteList/dds:address",
                namespaces=ns,
            ),
            "192.168.123.164",
        )
        self.assertEqual(
            root.findtext(
                "dds:participant/dds:rtps/dds:useBuiltinTransports",
                namespaces=ns,
            ),
            "false",
        )

    def test_profile_rejects_non_ipv4_and_nonroutable_interfaces(self):
        for address in ("not-an-ip", "127.0.0.1", "169.254.1.2", "0.0.0.0"):
            with self.subTest(address=address), self.assertRaises(ValueError):
                build_fastdds_profile(address)


if __name__ == "__main__":
    unittest.main()
