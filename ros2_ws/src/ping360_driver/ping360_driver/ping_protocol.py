# Standalone Ping binary protocol helpers (BR + header + checksum).
# Message layouts follow https://github.com/bluerobotics/ping-protocol

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum
from typing import Callable, Optional


class ParseState(IntEnum):
    NEW_MESSAGE = 0
    WAIT_START = 1
    WAIT_HEADER = 2
    WAIT_LENGTH_L = 3
    WAIT_LENGTH_H = 4
    WAIT_MSG_ID_L = 5
    WAIT_MSG_ID_H = 6
    WAIT_SRC_ID = 7
    WAIT_DST_ID = 8
    WAIT_PAYLOAD = 9
    WAIT_CHECKSUM_L = 10
    WAIT_CHECKSUM_H = 11
    ERROR = 12


@dataclass
class PingRxMessage:
    message_id: int
    src_device_id: int
    dst_device_id: int
    payload: bytes


def checksum16(data: bytes) -> int:
    return sum(data) & 0xFFFF


def pack_message(
    message_id: int,
    payload: bytes,
    *,
    src_device_id: int = 0,
    dst_device_id: int = 1,
) -> bytes:
    plen = len(payload)
    header = struct.pack("<BBHHBB", 0x42, 0x52, plen, message_id, src_device_id, dst_device_id)
    body = header + payload
    return body + struct.pack("<H", checksum16(body))


def parse_payload_device_data(payload: bytes) -> dict:
    """Message id 2300 — device_data."""
    if len(payload) < 14:
        raise ValueError("device_data payload too short")
    mode, gain, angle, td, sp, tf, nos = struct.unpack_from("<BBHHHHH", payload, 0)
    dl = struct.unpack_from("<H", payload, 12)[0]
    data = payload[14 : 14 + dl]
    if len(data) != dl:
        raise ValueError("device_data length mismatch")
    return {
        "mode": mode,
        "gain_setting": gain,
        "angle": angle,
        "transmit_duration_us": td,
        "sample_period_25ns": sp,
        "transmit_frequency_khz": tf,
        "number_of_samples": nos,
        "data_length": dl,
        "data": data,
    }


def parse_payload_auto_device_data(payload: bytes) -> dict:
    """Message id 2301 — auto_device_data."""
    if len(payload) < 20:
        raise ValueError("auto_device_data payload too short")
    (
        mode,
        gain,
        angle,
        td,
        sp,
        tf,
        start_a,
        stop_a,
        nsteps,
        delay,
        nos,
    ) = struct.unpack_from("<BBHHHHHHBBH", payload, 0)
    dl = struct.unpack_from("<H", payload, 18)[0]
    data = payload[20 : 20 + dl]
    if len(data) != dl:
        raise ValueError("auto_device_data length mismatch")
    return {
        "mode": mode,
        "gain_setting": gain,
        "angle": angle,
        "transmit_duration_us": td,
        "sample_period_25ns": sp,
        "transmit_frequency_khz": tf,
        "start_angle": start_a,
        "stop_angle": stop_a,
        "num_steps": nsteps,
        "delay_ms": delay,
        "number_of_samples": nos,
        "data_length": dl,
        "data": data,
    }


def parse_payload_device_information(payload: bytes) -> dict:
    """Common id 4."""
    if len(payload) < 6:
        raise ValueError("device_information too short")
    dt, rev, maj, mino, patch, res = struct.unpack_from("<BBBBBB", payload, 0)
    return {
        "device_type": dt,
        "device_revision": rev,
        "firmware_version_major": maj,
        "firmware_version_minor": mino,
        "firmware_version_patch": patch,
        "reserved": res,
    }


def parse_payload_protocol_version(payload: bytes) -> dict:
    """Common id 5."""
    if len(payload) < 4:
        raise ValueError("protocol_version too short")
    maj, mino, patch, res = struct.unpack_from("<BBBB", payload, 0)
    return {
        "version_major": maj,
        "version_minor": mino,
        "version_patch": patch,
        "reserved": res,
    }


def pack_general_request(requested_message_id: int) -> bytes:
    """Common id 6 — request a get message by id."""
    return pack_message(6, struct.pack("<H", requested_message_id))


def pack_auto_transmit(
    *,
    mode: int = 1,
    gain_setting: int = 1,
    transmit_duration_us: int = 12,
    sample_period_25ns: int = 88,
    transmit_frequency_khz: int = 740,
    number_of_samples: int = 400,
    start_angle: int = 0,
    stop_angle: int = 399,
    num_steps: int = 1,
    delay_ms: int = 0,
    dst_device_id: int = 1,
) -> bytes:
    """Control id 2602 — auto_transmit (continuous scan)."""
    payload = struct.pack(
        "<BBHHHHHHBB",
        mode,
        gain_setting,
        transmit_duration_us,
        sample_period_25ns,
        transmit_frequency_khz,
        number_of_samples,
        start_angle,
        stop_angle,
        num_steps,
        delay_ms,
    )
    return pack_message(2602, payload, dst_device_id=dst_device_id)


def pack_motor_off(dst_device_id: int = 1) -> bytes:
    """Control id 2903 — motor_off (empty payload)."""
    return pack_message(2903, b"", dst_device_id=dst_device_id)


class PingParser:
    """Incremental stream parser (same state machine as ping-python)."""

    __slots__ = ("buf", "state", "payload_length", "message_id", "errors", "parsed", "rx_msg")

    def __init__(self) -> None:
        self.buf = bytearray()
        self.state = ParseState.WAIT_START
        self.payload_length = 0
        self.message_id = 0
        self.errors = 0
        self.parsed = 0
        self.rx_msg: Optional[PingRxMessage] = None

    def parse_byte(self, b: int) -> Optional[int]:
        if self.state == ParseState.WAIT_START:
            self._wait_start(b)
        elif self.state == ParseState.WAIT_HEADER:
            self._wait_header(b)
        elif self.state == ParseState.WAIT_LENGTH_L:
            self._wait_length_l(b)
        elif self.state == ParseState.WAIT_LENGTH_H:
            self._wait_length_h(b)
        elif self.state == ParseState.WAIT_MSG_ID_L:
            self._wait_msg_id_l(b)
        elif self.state == ParseState.WAIT_MSG_ID_H:
            self._wait_msg_id_h(b)
        elif self.state == ParseState.WAIT_SRC_ID:
            self._wait_src_id(b)
        elif self.state == ParseState.WAIT_DST_ID:
            self._wait_dst_id(b)
        elif self.state == ParseState.WAIT_PAYLOAD:
            self._wait_payload(b)
        elif self.state == ParseState.WAIT_CHECKSUM_L:
            self._wait_checksum_l(b)
        elif self.state == ParseState.WAIT_CHECKSUM_H:
            return self._wait_checksum_h(b)
        return None

    def _wait_start(self, msg_byte: int) -> None:
        self.buf = bytearray()
        if msg_byte == ord("B"):
            self.buf.append(msg_byte)
            self.state = ParseState.WAIT_HEADER

    def _wait_header(self, msg_byte: int) -> None:
        if msg_byte == ord("R"):
            self.buf.append(msg_byte)
            self.state = ParseState.WAIT_LENGTH_L
        else:
            self.state = ParseState.WAIT_START

    def _wait_length_l(self, msg_byte: int) -> None:
        self.payload_length = msg_byte
        self.buf.append(msg_byte)
        self.state = ParseState.WAIT_LENGTH_H

    def _wait_length_h(self, msg_byte: int) -> None:
        self.payload_length |= msg_byte << 8
        self.buf.append(msg_byte)
        self.state = ParseState.WAIT_MSG_ID_L

    def _wait_msg_id_l(self, msg_byte: int) -> None:
        self.message_id = msg_byte
        self.buf.append(msg_byte)
        self.state = ParseState.WAIT_MSG_ID_H

    def _wait_msg_id_h(self, msg_byte: int) -> None:
        self.message_id |= msg_byte << 8
        self.buf.append(msg_byte)
        self.state = ParseState.WAIT_SRC_ID

    def _wait_src_id(self, msg_byte: int) -> None:
        self.buf.append(msg_byte)
        self.state = ParseState.WAIT_DST_ID

    def _wait_dst_id(self, msg_byte: int) -> None:
        self.buf.append(msg_byte)
        if self.payload_length == 0:
            self.state = ParseState.WAIT_CHECKSUM_L
        else:
            self.state = ParseState.WAIT_PAYLOAD

    def _wait_payload(self, msg_byte: int) -> None:
        self.buf.append(msg_byte)
        self.payload_length -= 1
        if self.payload_length == 0:
            self.state = ParseState.WAIT_CHECKSUM_L

    def _wait_checksum_l(self, msg_byte: int) -> None:
        self.buf.append(msg_byte)
        self.state = ParseState.WAIT_CHECKSUM_H

    def _wait_checksum_h(self, msg_byte: int) -> Optional[int]:
        self.state = ParseState.WAIT_START
        self.buf.append(msg_byte)
        plen = 0
        mid = 0
        if len(self.buf) >= 8:
            plen = struct.unpack_from("<H", self.buf, 2)[0]
            mid = struct.unpack_from("<H", self.buf, 4)[0]
        cksum = struct.unpack_from("<H", self.buf, 8 + plen)[0]
        body = self.buf[: 8 + plen]
        calc = checksum16(body)
        src_id = self.buf[6]
        dst_id = self.buf[7]
        payload = bytes(self.buf[8 : 8 + plen])
        self.rx_msg = PingRxMessage(
            message_id=mid,
            src_device_id=src_id,
            dst_device_id=dst_id,
            payload=payload,
        )
        if cksum == calc:
            self.parsed += 1
            return ParseState.NEW_MESSAGE
        self.errors += 1
        return ParseState.ERROR


def feed_bytes(parser: PingParser, data: bytes, on_message: Callable[[PingRxMessage], None]) -> None:
    for byte in data:
        r = parser.parse_byte(byte)
        if r == ParseState.NEW_MESSAGE and parser.rx_msg is not None:
            on_message(parser.rx_msg)
