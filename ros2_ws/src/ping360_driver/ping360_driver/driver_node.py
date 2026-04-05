#!/usr/bin/env python3
"""ROS 2 node: Ping360 USB serial, auto_transmit mode, full topic set."""

from __future__ import annotations

import math
import queue
import threading
import time
from typing import Optional

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy

from geometry_msgs.msg import TransformStamped
from sensor_msgs.msg import Image
from std_msgs.msg import Header

from ping360_msgs.msg import (
    Ping360AutoDeviceData,
    Ping360Derived,
    Ping360DeviceData,
    Ping360DeviceInformation,
    Ping360ProtocolVersion,
    Ping360ScanImageMeta,
    Ping360Status,
)

from ping360_driver.ping_protocol import (
    PingParser,
    PingRxMessage,
    feed_bytes,
    pack_auto_transmit,
    pack_general_request,
    pack_motor_off,
    parse_payload_auto_device_data,
    parse_payload_device_data,
    parse_payload_device_information,
    parse_payload_protocol_version,
)

try:
    import serial
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("Install pyserial (apt ros-humble-python3-serial or pip pyserial)") from exc

from tf2_ros import StaticTransformBroadcaster


GRADIANS_FULL_CIRCLE = 400


def _qos_sensor() -> QoSProfile:
    return QoSProfile(
        reliability=ReliabilityPolicy.BEST_EFFORT,
        durability=DurabilityPolicy.VOLATILE,
        history=HistoryPolicy.KEEP_LAST,
        depth=10,
    )


def _qos_latched() -> QoSProfile:
    return QoSProfile(
        reliability=ReliabilityPolicy.RELIABLE,
        durability=DurabilityPolicy.TRANSIENT_LOCAL,
        history=HistoryPolicy.KEEP_LAST,
        depth=1,
    )


class Ping360DriverNode(Node):
    def __init__(self) -> None:
        super().__init__("ping360_driver")

        self.declare_parameter("serial_port", "/dev/ttyUSB0")
        self.declare_parameter("baud_rate", 115200)
        self.declare_parameter("frame_id", "ping360_link")
        self.declare_parameter("publish_tf_static", False)
        self.declare_parameter("tf_parent_frame", "base_link")
        self.declare_parameter("tf_translation_xyz", [0.0, 0.0, 0.0])
        self.declare_parameter("tf_rotation_rpy_deg", [0.0, 0.0, 0.0])
        self.declare_parameter("speed_of_sound_mps", 1500.0)
        self.declare_parameter("device_dst_id", 1)

        self.declare_parameter("gain_setting", 1)
        self.declare_parameter("transmit_duration_us", 12)
        self.declare_parameter("sample_period_25ns", 88)
        self.declare_parameter("transmit_frequency_khz", 740)
        self.declare_parameter("number_of_samples", 400)
        self.declare_parameter("start_angle_gradians", 0)
        self.declare_parameter("stop_angle_gradians", 399)
        self.declare_parameter("num_steps", 1)
        self.declare_parameter("delay_ms", 0)

        self.declare_parameter("send_init_break", True)
        self.declare_parameter("reopen_serial_period_s", 3.0)

        port = self.get_parameter("serial_port").get_parameter_value().string_value
        self._frame_id = self.get_parameter("frame_id").get_parameter_value().string_value
        self._speed_of_sound = float(self.get_parameter("speed_of_sound_mps").value)
        self._dst = int(self.get_parameter("device_dst_id").value)

        self._pub_auto = self.create_publisher(Ping360AutoDeviceData, "/ping360/auto_device_data", _qos_sensor())
        self._pub_dev = self.create_publisher(Ping360DeviceData, "/ping360/device_data", _qos_sensor())
        self._pub_derived = self.create_publisher(Ping360Derived, "/ping360/derived", _qos_sensor())
        self._pub_img = self.create_publisher(Image, "/ping360/scan_image", _qos_sensor())
        self._pub_meta = self.create_publisher(Ping360ScanImageMeta, "/ping360/scan_image_meta", _qos_sensor())
        self._pub_status = self.create_publisher(Ping360Status, "/ping360/status", _qos_sensor())
        self._pub_dev_info = self.create_publisher(Ping360DeviceInformation, "/ping360/device_information", _qos_latched())
        self._pub_proto = self.create_publisher(Ping360ProtocolVersion, "/ping360/protocol_version", _qos_latched())

        self._tf_broadcaster: Optional[StaticTransformBroadcaster] = None
        if self.get_parameter("publish_tf_static").value:
            self._tf_broadcaster = StaticTransformBroadcaster(self)
            self._publish_static_tf()

        self._parser = PingParser()
        self._rx_queue: queue.SimpleQueue[tuple[int, bytes]] = queue.SimpleQueue()
        self._serial_lock = threading.Lock()
        self._ser: Optional[serial.Serial] = None
        self._running = True
        self._last_auto_time: Optional[float] = None
        self._auto_times: list[float] = []
        self._rate_ema: float = 0.0
        self._msgs_ok = 0
        self._last_message_id = 0
        self._last_err = ""
        self._connected = False

        self._scan_buf: Optional[bytearray] = None
        self._scan_w = 0
        self._scan_h = GRADIANS_FULL_CIRCLE

        self._read_thread = threading.Thread(target=self._read_loop, args=(port,), daemon=True)
        self._read_thread.start()

        self._status_timer = self.create_timer(1.0, self._publish_status)
        self._init_timer = self.create_timer(0.5, self._try_init_once)
        self._init_sent = False
        self._drain_timer = self.create_timer(0.002, self._drain_rx_queue)

        self.get_logger().info(
            f"Ping360 driver: port={port} frame_id={self._frame_id} "
            f"(topics under ~/ping360/*)"
        )

    def _publish_static_tf(self) -> None:
        xyz = list(self.get_parameter("tf_translation_xyz").value)
        rpy_deg = list(self.get_parameter("tf_rotation_rpy_deg").value)
        parent = self.get_parameter("tf_parent_frame").value
        t = TransformStamped()
        t.header.stamp = self.get_clock().now().to_msg()
        t.header.frame_id = parent
        t.child_frame_id = self._frame_id
        t.transform.translation.x = float(xyz[0])
        t.transform.translation.y = float(xyz[1])
        t.transform.translation.z = float(xyz[2])
        roll = math.radians(float(rpy_deg[0]))
        pitch = math.radians(float(rpy_deg[1]))
        yaw = math.radians(float(rpy_deg[2]))
        cy = math.cos(yaw * 0.5)
        sy = math.sin(yaw * 0.5)
        cp = math.cos(pitch * 0.5)
        sp = math.sin(pitch * 0.5)
        cr = math.cos(roll * 0.5)
        sr = math.sin(roll * 0.5)
        t.transform.rotation.x = sr * cp * cy - cr * sp * sy
        t.transform.rotation.y = cr * sp * cy + sr * cp * sy
        t.transform.rotation.z = cr * cp * sy - sr * sp * cy
        t.transform.rotation.w = cr * cp * cy + sr * sp * sy
        if self._tf_broadcaster is not None:
            self._tf_broadcaster.sendTransform(t)

    def _try_init_once(self) -> None:
        if self._init_sent:
            return
        if not self._connected or self._ser is None:
            return
        self._init_sent = True
        try:
            if self.get_parameter("send_init_break").value:
                with self._serial_lock:
                    self._ser.reset_input_buffer()
                    self._ser.write(b"\n")
                time.sleep(0.15)
            with self._serial_lock:
                self._ser.write(pack_general_request(5))
                time.sleep(0.05)
                self._ser.write(pack_general_request(4))
                time.sleep(0.05)
                p = self._auto_transmit_payload()
                self._ser.write(p)
            self.get_logger().info("Sent protocol request + auto_transmit")
            self._init_timer.cancel()
        except Exception as exc:  # noqa: BLE001
            self.get_logger().error(f"Init sequence failed: {exc}")
            self._init_sent = False

    def _auto_transmit_payload(self) -> bytes:
        return pack_auto_transmit(
            gain_setting=int(self.get_parameter("gain_setting").value),
            transmit_duration_us=int(self.get_parameter("transmit_duration_us").value),
            sample_period_25ns=int(self.get_parameter("sample_period_25ns").value),
            transmit_frequency_khz=int(self.get_parameter("transmit_frequency_khz").value),
            number_of_samples=int(self.get_parameter("number_of_samples").value),
            start_angle=int(self.get_parameter("start_angle_gradians").value),
            stop_angle=int(self.get_parameter("stop_angle_gradians").value),
            num_steps=int(self.get_parameter("num_steps").value),
            delay_ms=int(self.get_parameter("delay_ms").value),
            dst_device_id=self._dst,
        )

    def destroy_node(self) -> bool:
        self._running = False
        try:
            if self._ser is not None and self._ser.is_open:
                with self._serial_lock:
                    self._ser.write(pack_motor_off(dst_device_id=self._dst))
        except Exception:  # noqa: BLE001
            pass
        return super().destroy_node()

    def _read_loop(self, port: str) -> None:
        reopen = float(self.get_parameter("reopen_serial_period_s").value)
        baud = int(self.get_parameter("baud_rate").value)
        while self._running and rclpy.ok():
            try:
                self._ser = serial.Serial(port, baud, timeout=0.2)
                self._connected = True
                self._last_err = ""
                self.get_logger().info(f"Serial open {port} @ {baud}")
                self._parser = PingParser()
                while self._running and rclpy.ok() and self._ser is not None and self._ser.is_open:
                    chunk = self._ser.read(4096)
                    if chunk:
                        feed_bytes(self._parser, chunk, self._enqueue_rx)
                self._connected = False
            except serial.SerialException as exc:
                self._connected = False
                self._last_err = str(exc)
                self.get_logger().warning(f"Serial error: {exc}; retry in {reopen}s")
            finally:
                if self._ser is not None and self._ser.is_open:
                    try:
                        self._ser.close()
                    except Exception:  # noqa: BLE001
                        pass
                self._ser = None
            time.sleep(reopen)

    def _enqueue_rx(self, msg: PingRxMessage) -> None:
        self._rx_queue.put((msg.message_id, bytes(msg.payload)))

    def _drain_rx_queue(self) -> None:
        processed = 0
        max_burst = 200
        while processed < max_burst:
            try:
                mid, payload = self._rx_queue.get_nowait()
            except queue.Empty:
                break
            self._process_message(mid, payload)
            processed += 1

    def _process_message(self, mid: int, payload: bytes) -> None:
        self._msgs_ok += 1
        self._last_message_id = int(mid)
        try:
            if mid == 4:
                d = parse_payload_device_information(payload)
                m = Ping360DeviceInformation()
                m.device_type = int(d["device_type"])
                m.device_revision = int(d["device_revision"])
                m.firmware_version_major = int(d["firmware_version_major"])
                m.firmware_version_minor = int(d["firmware_version_minor"])
                m.firmware_version_patch = int(d["firmware_version_patch"])
                m.reserved = int(d["reserved"])
                if m.device_type != 0 and m.device_type != 2:
                    self.get_logger().warning(
                        f"Device reports type {m.device_type} (expected 2 Ping360)"
                    )
                self._pub_dev_info.publish(m)
            elif mid == 5:
                d = parse_payload_protocol_version(payload)
                p = Ping360ProtocolVersion()
                p.version_major = int(d["version_major"])
                p.version_minor = int(d["version_minor"])
                p.version_patch = int(d["version_patch"])
                p.reserved = int(d["reserved"])
                self._pub_proto.publish(p)
            elif mid == 2300:
                d = parse_payload_device_data(payload)
                self._publish_device_data(d)
            elif mid == 2301:
                d = parse_payload_auto_device_data(payload)
                self._publish_auto(d)
            elif mid in (1, 2, 3, 6):
                pass
            else:
                self.get_logger().debug(f"Ignored message id {mid}")
        except Exception as exc:  # noqa: BLE001
            self.get_logger().warning(f"Payload parse error mid={mid}: {exc}")

    def _stamp(self) -> Header:
        h = Header()
        h.stamp = self.get_clock().now().to_msg()
        h.frame_id = self._frame_id
        return h

    def _publish_device_data(self, d: dict) -> None:
        m = Ping360DeviceData()
        m.header = self._stamp()
        m.mode = int(d["mode"])
        m.gain_setting = int(d["gain_setting"])
        m.angle = int(d["angle"])
        m.transmit_duration_us = int(d["transmit_duration_us"])
        m.sample_period_25ns = int(d["sample_period_25ns"])
        m.transmit_frequency_khz = int(d["transmit_frequency_khz"])
        m.number_of_samples = int(d["number_of_samples"])
        m.data_length = int(d["data_length"])
        m.data = list(d["data"])
        self._pub_dev.publish(m)

    def _publish_auto(self, d: dict) -> None:
        now = time.monotonic()
        if self._last_auto_time is not None:
            dt = now - self._last_auto_time
            if dt > 0:
                inst = 1.0 / dt
                self._rate_ema = 0.9 * self._rate_ema + 0.1 * inst if self._rate_ema > 0 else inst
        self._last_auto_time = now

        m = Ping360AutoDeviceData()
        m.header = self._stamp()
        m.mode = int(d["mode"])
        m.gain_setting = int(d["gain_setting"])
        m.angle = int(d["angle"])
        m.transmit_duration_us = int(d["transmit_duration_us"])
        m.sample_period_25ns = int(d["sample_period_25ns"])
        m.transmit_frequency_khz = int(d["transmit_frequency_khz"])
        m.start_angle = int(d["start_angle"])
        m.stop_angle = int(d["stop_angle"])
        m.num_steps = int(d["num_steps"])
        m.delay_ms = int(d["delay_ms"])
        m.number_of_samples = int(d["number_of_samples"])
        m.data_length = int(d["data_length"])
        m.data = list(d["data"])
        self._pub_auto.publish(m)

        data = d["data"]
        peak_idx = 0
        peak_val = 0
        if data:
            peak_val = max(data)
            peak_idx = int(data.index(peak_val))

        sp = int(d["sample_period_25ns"])
        dt_s = peak_idx * sp * 25e-9
        rng = dt_s * float(self._speed_of_sound) * 0.5

        ang_g = int(d["angle"])
        der = Ping360Derived()
        der.header = self._stamp()
        der.angle_gradians = ang_g
        der.angle_rad = float(ang_g) * (2.0 * math.pi / float(GRADIANS_FULL_CIRCLE))
        der.peak_index = peak_idx
        der.peak_value = int(peak_val)
        der.range_to_peak_m = float(rng)
        der.speed_of_sound_mps = float(self._speed_of_sound)
        self._pub_derived.publish(der)

        self._update_scan_image(d)

    def _update_scan_image(self, d: dict) -> None:
        w = int(d["number_of_samples"])
        if w <= 0:
            return
        if self._scan_buf is None or self._scan_w != w:
            self._scan_w = w
            self._scan_buf = bytearray(self._scan_h * w)

        row = int(d["angle"]) % self._scan_h
        raw = d["data"]
        if len(raw) >= w:
            chunk = raw[:w]
        else:
            chunk = raw + bytes([0] * (w - len(raw)))

        offset = row * w
        self._scan_buf[offset : offset + w] = chunk

        img = Image()
        img.header = self._stamp()
        img.height = self._scan_h
        img.width = w
        img.encoding = "mono8"
        img.is_bigendian = 0
        img.step = w
        img.data = bytes(self._scan_buf)

        meta = Ping360ScanImageMeta()
        meta.header = img.header
        meta.width = w
        meta.height = self._scan_h
        meta.start_angle_gradians = int(d["start_angle"])
        meta.stop_angle_gradians = int(d["stop_angle"])
        meta.num_steps = int(d["num_steps"])
        meta.samples_per_ping = w
        meta.encoding_note = 0

        self._pub_img.publish(img)
        self._pub_meta.publish(meta)

    def _publish_status(self) -> None:
        s = Ping360Status()
        s.stamp = self.get_clock().now().to_msg()
        s.connected = self._connected
        s.last_error = self._last_err
        s.auto_data_rate_hz = float(self._rate_ema)
        s.messages_parsed_ok = int(self._msgs_ok)
        s.checksum_errors = int(self._parser.errors)
        s.serial_read_errors = 0
        s.last_message_id = int(self._last_message_id)
        self._pub_status.publish(s)


def main() -> None:
    rclpy.init()
    node = Ping360DriverNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
