# ping360_driver

**ROS 2 Humble** package: USB serial driver for the **Blue Robotics Ping360** scanning imaging sonar, optional **bag recorder** services, and a **browser-based viewer** (static HTML + roslibjs + rosbridge).

The driver implements Ping **binary protocol framing and parsing** in Python (`ping360_driver/ping_protocol.py`). It does **not** depend on the `brping` Python library.

---

## Table of contents

1. [What this package provides](#what-this-package-provides)
2. [Repository layout](#repository-layout)
3. [Requirements](#requirements)
4. [Build and installation](#build-and-installation)
5. [Hardware and permissions](#hardware-and-permissions)
6. [Quick start](#quick-start)
7. [Architecture](#architecture)
8. [Nodes](#nodes)
9. [Published topics (driver)](#published-topics-driver)
10. [Custom messages (`ping360_msgs`)](#custom-messages-ping360_msgs)
11. [Standard messages used](#standard-messages-used)
12. [Services](#services)
13. [Parameters (driver node)](#parameters-driver-node)
14. [Scan image and coordinates](#scan-image-and-coordinates)
15. [Derived range math](#derived-range-math)
16. [Optional static TF](#optional-static-tf)
17. [Recorder node (bags)](#recorder-node-bags)
18. [Web UI and rosbridge](#web-ui-and-rosbridge)
19. [Browser UI — files, features, and URL parameters](#browser-ui--files-features-and-url-parameters)
20. [Bag playback without hardware](#bag-playback-without-hardware)
21. [Running components separately](#running-components-separately)
22. [Troubleshooting](#troubleshooting)
23. [License](#license)

---

## What this package provides

| Component | Purpose |
|-----------|---------|
| **`ping360_driver_node`** | Opens serial, initializes device, enables **auto_transmit** sweep, parses Ping messages, publishes `/ping360/*` topics. |
| **`ping360_recorder_node`** | ROS services to **start/stop** `ros2 bag record` with a sensible default topic list. |
| **`launch/`** | `ping360_bringup.launch.py` (driver + recorder + rosapi + optional rosbridge + HTTP), `ping360_web_only.launch.py` (UI only for bags). |
| **`web/`** | Static **topic explorer** + **polar/rect** visualization (turbo colormap, CLAHE, montage) served over HTTP; talks to ROS via **WebSocket** (rosbridge). |

---

## Repository layout

Typical colcon workspace:

```
ros2_ws/src/
├── ping360_msgs/          # Interfaces: .msg and .srv definitions
└── ping360_driver/        # This package
    ├── ping360_driver/    # Python package (driver, protocol, recorder entry points)
    ├── launch/
    ├── web/               # Installed to share/ping360_driver/web
    ├── package.xml
    ├── setup.py
    └── README.md            # This file
```

---

## Requirements

- **OS**: Ubuntu 22.04 with **ROS 2 Humble** (`/opt/ros/humble`).
- **Python**: `rclpy`, `sensor_msgs`, `geometry_msgs`, `tf2_ros`, **`python3-serial`** (declared as `exec_depend` in `package.xml`).
- **Ping360** connected via USB (often `/dev/ttyUSB0` or `/dev/ttyACM*`).
- **Optional (web UI live data)**:
  - `sudo apt install ros-humble-rosbridge-suite`
  - `rosapi` is pulled in by the launch file for topic listing in the browser.

---

## Build and installation

From your workspace root (the directory that contains `src/`):

```bash
source /opt/ros/humble/setup.bash
cd /path/to/ros2_ws
colcon build --packages-select ping360_msgs ping360_driver
source install/setup.bash
```

Verify executables:

```bash
ros2 pkg executables ping360_driver
# Expect: ping360_driver_node, ping360_recorder_node
```

---

## Hardware and permissions

- Ensure the device appears as a serial port (check `dmesg` when plugging in).
- Your user may need dialout: `sudo usermod -aG dialout $USER` (log out/in).
- If the port is not `/dev/ttyUSB0`, override **`serial_port`** (see [Parameters](#parameters-driver-node)).

---

## Quick start

**Terminal 1 — full stack (driver + recorder + rosapi + HTTP + rosbridge if installed):**

```bash
source /opt/ros/humble/setup.bash
source install/setup.bash
ros2 launch ping360_driver ping360_bringup.launch.py
```

**Browser:** open **http://127.0.0.1:8765** (static UI). Live plots need **rosbridge** on **ws://127.0.0.1:9090** (default in the page).

**Override serial port** — easiest is to run the driver node directly:

```bash
ros2 run ping360_driver ping360_driver_node --ros-args -p serial_port:=/dev/ttyACM0
```

Or copy `launch/ping360_bringup.launch.py` and edit the `parameters={...}` dict for `serial_port`, `baud_rate`, etc. You can also load a **YAML** parameters file with `ros2 run ... --ros-args --params-file /path/to/params.yaml`.

---

## Architecture

```text
┌─────────────────┐     USB serial      ┌──────────────────────┐
│   Ping360       │◄──────────────────►│  ping360_driver_node │
│   (auto_transmit)│                   │  (parse + publish)   │
└─────────────────┘                   └──────────┬───────────┘
                                               │
                    ROS 2 topics /tf           │
                    ┌──────────────────────────┼──────────────────────────┐
                    ▼                          ▼                          ▼
            /ping360/scan_image        /ping360/auto_device_data   /ping360/status
            /ping360/derived           /ping360/device_information  (1 Hz health)
                    │                          │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │  ping360_recorder_node   │──► ros2 bag record (via service)
                    └──────────────────────────┘

  Browser ◄── HTTP :8765 (static web/) ──► rosbridge :9090 ◄──► rosapi + ROS graph
```

---

## Nodes

### `ping360_driver` (`ping360_driver_node`)

- **Input:** Raw bytes from serial; internal Ping frame parser.
- **Output:** Topics under `/ping360/…` (see below); optional `/tf_static`.
- **Threads:** Background **read** thread pushes payloads into a queue; main thread **drains** the queue on a short timer and processes messages.
- **Init sequence:** Optional UART break/newline (`send_init_break`), then general requests for device info (id 4) and protocol version (id 5), then **`pack_auto_transmit`** with ROS parameters.
- **Shutdown:** Sends **motor off** Ping command when the node is destroyed (best-effort).

### `ping360_recorder` (`ping360_recorder_node`)

- **Input:** Service calls only (no subscriptions).
- **Output:** Spawns **`ros2 bag record`** as a subprocess with a chosen topic list.

---

## Published topics (driver)

All topic names are **absolute** and grouped under **`/ping360/`** (except optional TF).

| Topic | Message type | QoS profile | Description |
|-------|----------------|-------------|-------------|
| `/ping360/auto_device_data` | `ping360_msgs/msg/Ping360AutoDeviceData` | Sensor: **best effort**, volatile, depth 10 | **Primary streaming data.** One message per **auto_transmit** ping (Ping protocol id **2301**). Contains current **angle**, timing, and **`data`** echo profile. |
| `/ping360/device_data` | `ping360_msgs/msg/Ping360DeviceData` | Same | Published when the device sends **device_data** (id **2300**). Common setups only use auto mode; this may appear rarely or never. |
| `/ping360/derived` | `ping360_msgs/msg/Ping360Derived` | Same | **Per-ping** summary derived from the latest auto sample: bearing, peak bin index/value, **range to peak (m)**, speed of sound used. |
| `/ping360/scan_image` | `sensor_msgs/msg/Image` | Same | **Full-scan raster image** built from successive pings. See [Scan image and coordinates](#scan-image-and-coordinates). |
| `/ping360/scan_image_meta` | `ping360_msgs/msg/Ping360ScanImageMeta` | Same | Metadata for `scan_image` (dimensions, sweep config). |
| `/ping360/status` | `ping360_msgs/msg/Ping360Status` | Same | Published at **1 Hz**: serial **connected** flag, last error string, estimated **auto** rate, parse counters, checksum errors, last Ping **message id**. |
| `/ping360/device_information` | `ping360_msgs/msg/Ping360DeviceInformation` | **Latched**: reliable, **transient local**, depth 1 | Device type and firmware (from Ping id **4**). New subscribers get the last message. |
| `/ping360/protocol_version` | `ping360_msgs/msg/Ping360ProtocolVersion` | Latched | Protocol version (Ping id **5**). |

**Optional TF**

| Topic | Type | When |
|-------|------|------|
| `/tf_static` | `geometry_msgs/msg/TransformStamped` (via `tf2_ros` static broadcaster) | Only if `publish_tf_static` is **true**. |

---

## Custom messages (`ping360_msgs`)

### `Ping360AutoDeviceData`

Echo of Ping **auto_device_data**: mode, gain, **angle** (gradians), transmit duration, **sample_period_25ns**, frequency, **start_angle**, **stop_angle**, **num_steps**, **delay_ms**, **number_of_samples**, **data_length**, **`data`** (uint8 array — amplitude vs range bin for this ping).

### `Ping360DeviceData`

Similar payload for **device_data** (manual / non-auto) without the extra sweep fields in the auto message layout (see `.msg` files for exact fields).

### `Ping360Derived`

- **`angle_gradians` / `angle_rad`:** Bearing for **this** ping (400 gradians = full circle).
- **`peak_index` / `peak_value`:** Index and value of the **maximum** sample in **`data`** for this ping.
- **`range_to_peak_m`:** Range in meters to that peak (see [Derived range math](#derived-range-math)).
- **`speed_of_sound_mps`:** Copy of the driver parameter used for range.

### `Ping360ScanImageMeta`

- **`width` / `height`:** Image size (width = range bins, height = angular steps, typically 400).
- **`start_angle_gradians` / `stop_angle_gradians` / `num_steps`:** From the active configuration.
- **`samples_per_ping`:** Same as image width when one row = one ping profile.
- **`encoding_note`:** `0` means **rows = angle (bearing), columns = range**.

### `Ping360Status`

- **`connected`:** Whether the serial port is currently open and reading.
- **`last_error`:** Last serial exception string (may be empty when healthy).
- **`auto_data_rate_hz`:** Smoothed estimate of auto ping rate.
- **`messages_parsed_ok`:** Cumulative count of successfully parsed Ping payloads.
- **`checksum_errors`:** Parser checksum failure count (from `PingParser`).
- **`serial_read_errors`:** Reserved / zero in current implementation.
- **`last_message_id`:** Last Ping **message id** processed (e.g. **2301** for auto data, **4**/**5** for info/version).

### `Ping360DeviceInformation` / `Ping360ProtocolVersion`

Device identity and protocol version as reported by the sensor (see comments in `.msg` files; device type **2** = Ping360).

---

## Standard messages used

- **`sensor_msgs/Image`** on `/ping360/scan_image`: **`encoding`** `mono8` (or `8UC1` treated the same in tools), **`step`** = width for mono8.
- **`std_msgs/Header`** on image and several custom messages: **`frame_id`** = driver `frame_id` parameter (default `ping360_link`).

---

## Services

### Recorder (`ping360_recorder_node`)

| Service | Type | Description |
|---------|------|-------------|
| `/ping360/recorder/start` | `ping360_msgs/srv/StartRecording` | Starts `ros2 bag record`. Request: **`output_directory`**, optional **`bag_name_prefix`**, optional **`topics`** (empty = built-in default list). Response: **`success`**, **`message`**, **`bag_path`**. |
| `/ping360/recorder/stop` | `ping360_msgs/srv/StopRecording` | Stops the active recording (SIGINT to the bag process). Response: **`success`**, **`message`**. |

**Default recorded topics** (if `topics` is empty):

`/ping360/auto_device_data`, `/ping360/device_data`, `/ping360/derived`, `/ping360/scan_image`, `/ping360/scan_image_meta`, `/ping360/status`, `/ping360/device_information`, `/ping360/protocol_version`, `/tf`, `/tf_static`

---

## Parameters (driver node)

| Parameter | Type | Default | Meaning |
|-----------|------|---------|---------|
| `serial_port` | string | `/dev/ttyUSB0` | Serial device path. |
| `baud_rate` | int | `115200` | UART baud rate (device-dependent). |
| `frame_id` | string | `ping360_link` | `header.frame_id` for published messages and TF child. |
| `publish_tf_static` | bool | `false` | Publish static transform from `tf_parent_frame` to `frame_id`. |
| `tf_parent_frame` | string | `base_link` | Parent frame if TF is enabled. |
| `tf_translation_xyz` | float[3] | `[0,0,0]` | Translation (meters). |
| `tf_rotation_rpy_deg` | float[3] | `[0,0,0]` | Roll, pitch, yaw in **degrees**. |
| `speed_of_sound_mps` | float | `1500.0` | Used for **`range_to_peak_m`** in `/ping360/derived`. |
| `device_dst_id` | int | `1` | Ping protocol destination device id. |
| `gain_setting` | int | `1` | Auto transmit gain. |
| `transmit_duration_us` | int | `12` | Transmit pulse length (µs). |
| `sample_period_25ns` | int | `88` | Sample period in **25 ns** units (range resolution). |
| `transmit_frequency_khz` | int | `740` | Transmit frequency. |
| `number_of_samples` | int | `400` | Range bins per ping (image **width**). |
| `start_angle_gradians` | int | `0` | Sweep start (gradians). |
| `stop_angle_gradians` | int | `399` | Sweep stop (gradians); 400 steps ≈ full circle. |
| `num_steps` | int | `1` | Angle increment per step (gradians) in protocol. |
| `delay_ms` | int | `0` | Inter-ping delay. |
| `send_init_break` | bool | `true` | Send newline / break before requests (helps some adapters). |
| `reopen_serial_period_s` | float | `3.0` | Retry delay after serial failure. |

**Launch file** (`ping360_bringup.launch.py`) passes a subset; override with `ros2 param` / YAML / CLI as needed.

---

## Scan image and coordinates

- The driver maintains a buffer of size **`height × width`** = **`400 × number_of_samples`** (default **400 × 400**).
- Each incoming **auto_device_data** ping has an **`angle`** in **gradians** (0–399 for full sweep). The driver writes the **`data`** row at **`row = angle % 400`**.
- **`sensor_msgs/Image`:**
  - **`height`** = 400 (angular index).
  - **`width`** = `number_of_samples` (range bins).
  - **`encoding`** = `mono8`.
  - **`step`** = `width` (bytes per row).

**Interpretation:**  
- **Column index** ↔ range bin (together with `sample_period_25ns` and sound speed → physical range).  
- **Row index** ↔ bearing (gradians; 400 gradians = 360°).  

The **web UI** maps this to a **polar fan** (0° typically up, clockwise) using the same convention as documented in `web/viz.js`.

**Important:** `/ping360/derived` refers to **one ping’s** `data` and **current angle**. The **scan_image** is built over **many** pings; the “brightest pixel” in the **image** may not match the latest **derived** message at the same ROS time—tools should document which source they use.

---

## Derived range math

For each auto ping, the driver finds **`peak_index`** = index of maximum value in **`data`**. With **`sample_period_25ns`** = \(T_{25}\):

\[
\text{time\_to\_bin} = \text{peak\_index} \times T_{25} \times 25 \times 10^{-9}\ \text{s}
\]

\[
\text{range\_to\_peak\_m} = \text{time\_to\_bin} \times \text{speed\_of\_sound\_mps} \times 0.5
\]

The factor **0.5** accounts for **round-trip** time (sound travels to the reflector and back). Adjust **`speed_of_sound_mps`** for water conditions if you need more accurate absolute range.

---

## Optional static TF

If **`publish_tf_static`** is **true**, the driver publishes **one** static transform:

- **`header.frame_id`** = `tf_parent_frame` (e.g. `base_link`)
- **`child_frame_id`** = `frame_id` (e.g. `ping360_link`)

Use this to place the sonar in your robot model or RViz. Translation and rotation use **`tf_translation_xyz`** and **`tf_rotation_rpy_deg`**.

---

## Recorder node (bags)

1. Start the stack (or at least the recorder node).
2. Call **`/ping360/recorder/start`** with a directory (and optional prefix / topic list).
3. Call **`/ping360/recorder/stop`** when finished.

Example (CLI):

```bash
ros2 service call /ping360/recorder/start ping360_msgs/srv/StartRecording \
  "{output_directory: '/home/user/rosbags', bag_name_prefix: 'trial', topics: []}"
```

Empty **`topics`** uses the **default** list (see [Services](#services)).

---

## Web UI and rosbridge

| Port | Role |
|------|------|
| **8765** | Static files from `share/ping360_driver/web` (Python `http.server` in launch). |
| **9090** | **rosbridge** WebSocket (if `ros-humble-rosbridge-suite` is installed). |

The page uses **roslibjs** to subscribe to topics (e.g. `/ping360/scan_image`) and **rosapi** to list topics. Without rosbridge, the HTML may load but **live** plots will not update.

---

## Browser UI — files, features, and URL parameters

The UI is **static JavaScript** shipped in `ping360_driver/web/` and installed to  
`share/ping360_driver/web/` so the launch file can serve it with `python3 -m http.server`.

### Files in `web/`

| File | Role |
|------|------|
| `index.html` | Page layout: topic explorer, image controls, polar + rectangular canvases, montage, JSON panel, recorder fields. |
| `app.js` | Roslib connection, topic subscription, **polar fan** + **CLAHE rect** rendering, **montage** buffer, **range/bearing** readout, optional subscriptions to `/ping360/derived` and `/ping360/auto_device_data`. |
| `viz.js` | **Turbo** colormap polar fan, CLAHE / histogram equalization, **annulus-aligned** polar grid, degree and normalized range labels. |
| `turbo_lut.js` | Lookup table for the **turbo** colormap. |
| `topic_explorer.js` | Lists topics via **rosapi** (`/rosapi/topics`); pick a topic to preview. |
| `message_viz.js` | Chooses JSON vs image vs LaserScan visualization mode from message type. |
| `styles.css` | Layout and styling. |

**External scripts (CDN):** `eventemitter2`, **roslib** (roslibjs). These require network access in the browser unless you vendor them.

### Features (when rosbridge + rosapi are running)

- **Topic table** with refresh, filter, and approximate **Hz**; manual topic/type entry.
- **`sensor_msgs/Image`** (`mono8` / `8UC1`): **polar fan** (turbo), optional **CLAHE** on polar, **polar skip bins** (range gate), **bearing °** and **0.2–1.0** range labels, **grid**.
- **Rectangular** view: **CLAHE + turbo** heatmap; optional raw gray strip.
- **3×4 polar montage** of recent scans (sampled in time).
- **Range & bearing** panel: uses image peak; prefers **`/ping360/derived`** and **`/ping360/auto_device_data`** when available.
- **Recorder** panel: calls **`/ping360/recorder/start`** and **`/ping360/recorder/stop`** (same services as CLI).
- **Last message JSON** for debugging.

### URL query parameters

| Parameter | Example | Meaning |
|-----------|---------|---------|
| `ws` | `?ws=ws://127.0.0.1:9090` | **Rosbridge WebSocket URL** (default `ws://127.0.0.1:9090`). |
| `topic` | `?topic=/ping360/scan_image` | **Auto-select** this topic after the topic list loads (if it exists). |

Example: `http://127.0.0.1:8765/?topic=/ping360/scan_image&ws=ws://192.168.1.10:9090`

### What works without rosbridge

- The HTML/CSS/JS **load** from port **8765**.
- **No live ROS data** (connection pill stays disconnected) until **rosbridge** is running and reachable at the configured **`ws`** URL.

---

## Bag playback without hardware

1. Launch UI-only:

   ```bash
   ros2 launch ping360_driver ping360_web_only.launch.py
   ```

2. In another terminal, play a bag and **remap** old topic names if needed:

   ```bash
   ros2 bag play your_bag.mcap --remap /scan_image:=/ping360/scan_image
   ```

3. Open **http://127.0.0.1:8765** and select **`/ping360/scan_image`** (or use URL `?topic=/ping360/scan_image`).

---

## Running components separately

```bash
# Driver only
ros2 run ping360_driver ping360_driver_node --ros-args -p serial_port:=/dev/ttyUSB0

# Recorder only
ros2 run ping360_driver ping360_recorder_node

# Rosbridge (if installed)
ros2 run rosbridge_server rosbridge_websocket --ros-args -p port:=9090

# Rosapi (for topic list in browser)
ros2 run rosapi rosapi_node
```

---

## Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| Serial open errors | Port path, `dialout` group, cable, another process using the port. |
| No `/ping360/*` traffic | Device powered, correct baud, **`send_init_break`**, USB adapter. |
| `checksum_errors` increasing | Electrical noise, bad cable, baud mismatch. |
| Empty or stale `scan_image` | Wait for a **full rotation**; image fills as angles arrive. |
| Web UI disconnected | **`rosbridge`** installed and running; firewall; correct **WebSocket URL** in the page. |
| Recorder fails to start | **`ros2` on PATH** (source ROS setup in the same environment as the node). |

Logs: watch the driver node **screen** output for `Serial open`, `Sent protocol request + auto_transmit`, and warnings.

---

## License

See `package.xml` (**Apache-2.0** unless you change it).

---

## See also

- `ping360_msgs/msg/*.msg` and `srv/*.srv` — field-level definitions.
- `ping360_driver/driver_node.py` — implementation details.
- `ping360_driver/ping_protocol.py` — framing and payload layout.
