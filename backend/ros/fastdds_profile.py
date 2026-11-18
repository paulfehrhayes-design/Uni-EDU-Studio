#!/usr/bin/env python3

import ipaddress
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


FAST_DDS_NAMESPACE = "http://www.eprosima.com/XMLSchemas/fastRTPS_Profiles"
ET.register_namespace("", FAST_DDS_NAMESPACE)


def _qualified_name(name: str) -> str:
    return f"{{{FAST_DDS_NAMESPACE}}}{name}"


def build_fastdds_profile(interface_address: str) -> bytes:
    address = ipaddress.IPv4Address(interface_address)
    if address.is_loopback or address.is_link_local or address.is_unspecified:
        raise ValueError("ROS interface address must be a usable non-loopback IPv4 address.")

    profiles = ET.Element(_qualified_name("profiles"))
    transports = ET.SubElement(profiles, _qualified_name("transport_descriptors"))
    transport = ET.SubElement(transports, _qualified_name("transport_descriptor"))
    ET.SubElement(transport, _qualified_name("transport_id")).text = "uni_edu_sensor_udp"
    ET.SubElement(transport, _qualified_name("type")).text = "UDPv4"
    whitelist = ET.SubElement(transport, _qualified_name("interfaceWhiteList"))
    ET.SubElement(whitelist, _qualified_name("address")).text = str(address)

    participant = ET.SubElement(
        profiles,
        _qualified_name("participant"),
        {"profile_name": "uni_edu_sensor_profile", "is_default_profile": "true"},
    )
    rtps = ET.SubElement(participant, _qualified_name("rtps"))
    ET.SubElement(rtps, _qualified_name("useBuiltinTransports")).text = "false"
    user_transports = ET.SubElement(rtps, _qualified_name("userTransports"))
    ET.SubElement(user_transports, _qualified_name("transport_id")).text = "uni_edu_sensor_udp"
    return ET.tostring(profiles, encoding="utf-8", xml_declaration=True)


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: fastdds_profile.py <interface-ipv4> <output-path>", file=sys.stderr)
        return 2
    try:
        profile = build_fastdds_profile(sys.argv[1])
        Path(sys.argv[2]).write_bytes(profile)
    except (OSError, ValueError) as error:
        print(f"Could not configure Fast DDS interface: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
