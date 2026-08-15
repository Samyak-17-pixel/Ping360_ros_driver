/* global MediaRecorder */

const $ = (id) => document.getElementById(id);

const ROSBRIDGE_LINK_KEY = "ping360_rosbridge_link";

/** Large rosbridge messages (SonarEcho, Image, big LaserScan) arrive as multiple `fragment` ops; must reassemble. */
const rosbridgeFragmentBuffers = new Map();

async function rosbridgePayloadToString(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder("utf-8").decode(data);
  if (ArrayBuffer.isView(data)) {
    const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new TextDecoder("utf-8").decode(u8);
  }
  if (data instanceof Blob) return data.text();
  return null;
}

function clearRosbridgeFragments() {
  rosbridgeFragmentBuffers.clear();
}

/**
 * @param {object} msg parsed top-level rosbridge object
 * @param {(msg:object)=>void} onTopicsResponse
 * @param {(msg:object)=>void} onPublish
 */
function dispatchRosbridgeMessage(msg, onTopicsResponse, onPublish) {
  if (!msg || typeof msg !== "object") return;

  if (msg.op === "fragment") {
    const { id, data: chunk, num, total } = msg;
    if (id == null || chunk == null || num == null || total == null) return;
    let buf = rosbridgeFragmentBuffers.get(id);
    if (!buf || buf.total !== total) {
      buf = { total, parts: new Array(total) };
      rosbridgeFragmentBuffers.set(id, buf);
    }
    buf.parts[num] = chunk;
    if (buf.parts.every((p) => p != null && p !== undefined)) {
      rosbridgeFragmentBuffers.delete(id);
      try {
        const inner = JSON.parse(buf.parts.join(""));
        dispatchRosbridgeMessage(inner, onTopicsResponse, onPublish);
      } catch (e) {
        console.warn("Ping360 Viewer: fragment reassembly JSON parse failed", e);
      }
    }
    return;
  }

  if (msg.op === "service_response" && String(msg.id || "").startsWith("topics_")) {
    onTopicsResponse(msg);
    return;
  }

  if (msg.op === "publish" && msg.topic && msg.msg) {
    onPublish(msg);
  }
}

const state = {
  me: null,
  connected: false,
  /** When true, keep (re)connecting after WiFi drops; when false, stay disconnected. */
  rosbridgeLinkEnabled: true,
  /** UI phase: off | connecting | connected | detached */
  rosPhase: "off",
  ws: null,
  wsBackoffMs: 250,
  wsReconnectTimer: null,
  wsConnectSeq: 0,
  tab: "raw",
  frame: 0,
  latest: null,
  latestKind: null, // "image" | "laserscan" | "sonarecho"
  latestMeta: null,
  topics: [], // [{name,type}]
  topicFilter: "ping360",
  currentTopic: null,
  currentTopicType: null,
  lastMsgAt: 0,
  fovDeg: 360,
  rangeMaxM: 10,
  bearingOffsetDeg: 0,
  recorder: null,
  recordingChunks: [],
  jetsonPassword: null,
  /** Last topic we successfully subscribed on the current WebSocket (for reconnect). */
  wsSubscribedTopic: null,
  /** CLAHE (rectangular view): clip limit and tile size in pixels. */
  claheClip: 3,
  claheTile: 48,
  showPolarGrid: true,
  showPolarLabels: true,
  showRangeLabels: true,
};

function setRosbridgeStatus(phase, headline, detail, sensorLine) {
  state.rosPhase = phase;
  state.connected = phase === "connected";

  const dot = $("connDot");
  dot.classList.remove("ok", "bad", "warn", "idle");
  if (phase === "connected") dot.classList.add("ok");
  else if (phase === "off") dot.classList.add("idle");
  else if (phase === "connecting" || phase === "detached") dot.classList.add("warn");
  else dot.classList.add("bad");

  $("connText").textContent = headline;
  $("rosbridgeDetail").textContent = detail;
  if (sensorLine != null) $("sensorStreamLine").textContent = sensorLine;
  document.body.classList.toggle("app-live", phase === "connected");
}

function updateSensorStatus() {
  if (!state.rosbridgeLinkEnabled) {
    $("sensorStreamLine").textContent = "Sensor: — (rosbridge link off)";
    return;
  }
  if (state.rosPhase === "off") {
    $("sensorStreamLine").textContent = "Sensor: —";
    return;
  }
  if (state.rosPhase === "connecting") {
    $("sensorStreamLine").textContent = "Sensor: connecting…";
    return;
  }
  if (state.rosPhase === "detached") {
    $("sensorStreamLine").textContent = "Sensor: detached — no stream until link returns";
    return;
  }
  // connected
  const ws = state.ws;
  const open = ws && ws.readyState === WebSocket.OPEN;
  if (!open) {
    $("sensorStreamLine").textContent = "Sensor: —";
    return;
  }
  if (!state.currentTopic) {
    $("sensorStreamLine").textContent = "Sensor: linked — pick a topic";
    return;
  }
  if (state.frame > 0) {
    $("sensorStreamLine").textContent = `Sensor: live · ${state.currentTopic} · ${state.frame} updates`;
  } else {
    $("sensorStreamLine").textContent = `Sensor: linked · waiting for data on ${state.currentTopic}`;
  }
}

function applyRosbridgeReachability(me) {
  const wrap = $("rosbridgeFixWrap");
  const explain = $("rosbridgeFixExplain");
  const urlInput = $("rosbridgeFixUrl");
  if (!wrap || !explain) return;
  if (me && me.rosbridge_reachable === false && me.rosbridge_target) {
    wrap.style.display = "";
    explain.textContent =
      `TCP from this viewer app to ${me.rosbridge_target} failed (saved URL: ${me.rosbridge}). `
      + "A GUI on the robot can still use rosbridge on 127.0.0.1; this server must use an address it can reach "
      + "(Jetson LAN IP, or SSH tunnel with 127.0.0.1:PORT on the machine running Ping360 Viewer).";
    if (urlInput && me.rosbridge) urlInput.value = me.rosbridge;
  } else {
    wrap.style.display = "none";
  }
}

function disconnectRosbridgeSoft() {
  state.wsConnectSeq++;
  const seq = state.wsConnectSeq;
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }
  if (state.ws) {
    try { state.ws.close(); } catch (_) {}
    state.ws = null;
  }
  state.wsBackoffMs = 250;
  state.connected = false;
  state.wsSubscribedTopic = null;
  setRosbridgeStatus(
    "off",
    "Rosbridge · off",
    "Switch is off — no connection attempts. Turn it on to link; while on, brief WiFi loss only pauses the stream and retries.",
    "Sensor: — (rosbridge off)",
  );
  const tgl = $("rosbridgeToggle");
  if (tgl) tgl.setAttribute("aria-checked", "false");
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function deg(x) { return x * 180 / Math.PI; }

function bearingFromX(x, w) {
  const fov = state.fovDeg;
  const u = (w <= 1) ? 0 : x / (w - 1);
  const b = (u * fov) - (fov / 2) + state.bearingOffsetDeg;
  // Normalize to [-180, 180)
  let bn = ((b + 180) % 360 + 360) % 360 - 180;
  return bn;
}

function rangeFromY(y, h) {
  const u = (h <= 1) ? 0 : y / (h - 1);
  // y=0 at top -> near. y=h-1 -> far.
  return u * state.rangeMaxM;
}

function grayFromImageMsg(msg) {
  // msg: sensor_msgs/Image in rosbridge JSON
  const { width: w, height: h, encoding, step, data } = msg;
  // rosbridge encodes uint8[] as base64 string by default for binary fields.
  // Sometimes it is an array; handle both.
  let bytes;
  if (typeof data === "string") {
    const bin = atob(data);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else if (Array.isArray(data)) {
    bytes = new Uint8Array(data);
  } else {
    bytes = new Uint8Array(0);
  }

  // Common cases:
  // - mono8: 1 byte per pixel
  // - 8UC1: treat as mono8
  // - rgb8/bgr8: 3 bytes per pixel -> convert
  const enc = (encoding || "").toLowerCase();
  let gray = new Uint8ClampedArray(w * h);

  if ((enc.includes("mono8") || enc.includes("8uc1")) && bytes.length >= w * h) {
    gray.set(bytes.subarray(0, w * h));
  } else if ((enc.includes("rgb8") || enc.includes("bgr8")) && bytes.length >= w * h * 3) {
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
      const r = enc.includes("bgr8") ? bytes[j + 2] : bytes[j + 0];
      const g = bytes[j + 1];
      const b = enc.includes("bgr8") ? bytes[j + 0] : bytes[j + 2];
      gray[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
    }
  } else {
    // Fallback: best-effort using step/row packing; take first byte per pixel.
    if (step && bytes.length >= step * h) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          gray[y * w + x] = bytes[y * step + x] || 0;
        }
      }
    }
  }

  return { w, h, encoding, step, grayU8: gray };
}

/** Google Turbo colormap (d3-scale-chromatic style), t ∈ [0,1] → RGB 0–255 */
function turboRgb01(t) {
  t = Math.max(0, Math.min(1, t));
  const r = Math.max(
    0,
    Math.min(255, Math.round(34.61 + t * (1172.33 - t * (10793.56 - t * (33300.12 - t * (38394.49 - t * 14825.05)))))),
  );
  const g = Math.max(
    0,
    Math.min(255, Math.round(23.31 + t * (557.33 + t * (1225.33 - t * (3574.96 - t * (1073.77 + t * 707.56)))))),
  );
  const b = Math.max(
    0,
    Math.min(255, Math.round(27.2 + t * (3211.1 - t * (15327.97 - t * (27814 - t * (22569.18 - t * 6838.66)))))),
  );
  return [r, g, b];
}

const TURBO_LUT = new Uint8ClampedArray(256 * 3);
(function buildTurboLut() {
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = turboRgb01(i / 255);
    TURBO_LUT[i * 3] = r;
    TURBO_LUT[i * 3 + 1] = g;
    TURBO_LUT[i * 3 + 2] = b;
  }
}());

/**
 * CLAHE on mono8 image; returns new Uint8ClampedArray length w*h.
 */
function claheGrayU8(grayU8, w, h, tileSize, clipLimit) {
  const ts = Math.max(8, Math.min(128, tileSize | 0));
  const clip = Math.max(1, clipLimit);
  const tw = Math.ceil(w / ts);
  const th = Math.ceil(h / ts);
  const maps = [];

  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const x0 = tx * ts;
      const y0 = ty * ts;
      const x1 = Math.min(w, x0 + ts);
      const y1 = Math.min(h, y0 + ts);
      const hist = new Uint32Array(256);
      let np = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          hist[grayU8[y * w + x]]++;
          np++;
        }
      }
      const limit = Math.max(1, Math.floor((clip * np) / 256));
      let clipped = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] > limit) {
          clipped += hist[i] - limit;
          hist[i] = limit;
        }
      }
      const add = Math.floor(clipped / 256);
      let rem = clipped - add * 256;
      for (let i = 0; i < 256; i++) {
        hist[i] += add + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
      }
      const cdf = new Uint32Array(256);
      cdf[0] = hist[0];
      for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
      const cdfMin = cdf[0];
      const denom = np - cdfMin;
      const map = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        map[i] = denom > 0 ? Math.round(((cdf[i] - cdfMin) / denom) * 255) : 0;
      }
      maps.push(map);
    }
  }

  const out = new Uint8ClampedArray(w * h);
  const fxAt = (x) => (x + 0.5) / ts - 0.5;
  const fyAt = (y) => (y + 0.5) / ts - 0.5;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = fxAt(x);
      const fy = fyAt(y);
      const tx0 = clamp(Math.floor(fx), 0, tw - 1);
      const ty0 = clamp(Math.floor(fy), 0, th - 1);
      const tx1 = clamp(tx0 + 1, 0, tw - 1);
      const ty1 = clamp(ty0 + 1, 0, th - 1);
      const ax = fx - tx0;
      const ay = fy - ty0;
      const v = grayU8[y * w + x];
      const m00 = maps[ty0 * tw + tx0][v];
      const m10 = maps[ty0 * tw + tx1][v];
      const m01 = maps[ty1 * tw + tx0][v];
      const m11 = maps[ty1 * tw + tx1][v];
      const m0 = m00 * (1 - ax) + m10 * ax;
      const m1 = m01 * (1 - ax) + m11 * ax;
      out[y * w + x] = Math.round(m0 * (1 - ay) + m1 * ay);
    }
  }
  return out;
}

function drawPolarFanTurbo(ctx, img) {
  const { w, h, grayU8 } = img;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = "#0a0618";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const cx = ctx.canvas.width / 2;
  const cy = ctx.canvas.height / 2;
  const R = Math.min(cx, cy) * 0.92;
  const fov = state.fovDeg * Math.PI / 180;
  const start = -fov / 2 + (state.bearingOffsetDeg * Math.PI / 180);
  const end = fov / 2 + (state.bearingOffsetDeg * Math.PI / 180);

  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const id = ctx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const dx = px - cx;
      const dy = py - cy;
      const rr = Math.sqrt(dx * dx + dy * dy);
      if (rr > R) continue;
      const a = Math.atan2(dy, dx);
      if (!angleWithin(a, start, end)) continue;
      const u = (a - start) / (end - start);
      const v = rr / R;
      const sx = clamp(Math.round(u * (w - 1)), 0, w - 1);
      const sy = clamp(Math.round(v * (h - 1)), 0, h - 1);
      const val = grayU8[sy * w + sx] & 255;
      const i = (py * W + px) * 4;
      const j = val * 3;
      id.data[i] = TURBO_LUT[j];
      id.data[i + 1] = TURBO_LUT[j + 1];
      id.data[i + 2] = TURBO_LUT[j + 2];
      id.data[i + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);

  if (state.showPolarGrid) {
    ctx.strokeStyle = "rgba(255,255,255,.22)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (i / 4) * R, start, end);
      ctx.stroke();
    }
    for (let i = 0; i <= 8; i++) {
      const ang = start + (i / 8) * (end - start);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
      ctx.stroke();
    }
  }

  if (state.showPolarLabels) {
    ctx.font = "11px var(--mono, ui-monospace, monospace)";
    ctx.fillStyle = "rgba(232,238,252,.88)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < 8; i++) {
      const ang = start + ((i + 0.5) / 8) * (end - start);
      const u = (i + 0.5) / 8;
      const bearingDeg = state.bearingOffsetDeg + (u - 0.5) * state.fovDeg;
      const bd = ((bearingDeg % 360) + 360) % 360;
      const lx = cx + Math.cos(ang) * (R - 14);
      const ly = cy + Math.sin(ang) * (R - 14);
      ctx.fillText(`${Math.round(bd)}°`, lx, ly);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  if (state.showRangeLabels) {
    ctx.font = "10px var(--mono, ui-monospace, monospace)";
    ctx.fillStyle = "rgba(155,176,227,.9)";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    for (let i = 1; i <= 4; i++) {
      const ri = (i / 4) * R;
      const rm = (i / 4) * state.rangeMaxM;
      ctx.fillText(`${rm.toFixed(1)}m`, cx + 6, cy - ri + 4);
    }
  }

  ctx.fillStyle = "rgba(232,238,252,.9)";
  ctx.font = "12px var(--mono, ui-monospace, monospace)";
  ctx.textAlign = "left";
  ctx.fillText("Polar fan · TURBO colormap", 18, 22);
}

function drawRectClaheTurbo(ctx, img) {
  const { w, h, grayU8 } = img;
  const eq = claheGrayU8(grayU8, w, h, state.claheTile, state.claheClip);
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const j = (eq[i] & 255) * 3;
    id.data[i * 4] = TURBO_LUT[j];
    id.data[i * 4 + 1] = TURBO_LUT[j + 1];
    id.data[i * 4 + 2] = TURBO_LUT[j + 2];
    id.data[i * 4 + 3] = 255;
  }
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  off.getContext("2d").putImageData(id, 0, 0);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = "#12081f";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const scale = Math.min(ctx.canvas.width / w, ctx.canvas.height / h);
  const dw = Math.floor(w * scale);
  const dh = Math.floor(h * scale);
  const dx = Math.floor((ctx.canvas.width - dw) / 2);
  const dy = Math.floor((ctx.canvas.height - dh) / 2);
  ctx.drawImage(off, dx, dy, dw, dh);
  ctx.fillStyle = "rgba(232,238,252,.92)";
  ctx.font = "12px var(--mono, ui-monospace, monospace)";
  ctx.textAlign = "left";
  ctx.fillText("Rectangular CLAHE + TURBO · Equalized + colormap", 18, 22);
  ctx.restore();
}

function updateViewLabel() {
  const el = $("viewLabel");
  if (!el) return;
  const labels = {
    raw: "Raw",
    polar: "Polar",
    polar_turbo: "Polar TURBO",
    rect_clahe: "CLAHE + TURBO",
    bearing: "Bearing peaks",
    hist: "Histogram",
  };
  el.textContent = labels[state.tab] || state.tab;
}

function updateVizToolbarVisibility() {
  const tb = $("vizToolbar");
  if (!tb) return;
  const t = state.tab;
  tb.querySelectorAll(".viz-opt").forEach((el) => {
    el.style.display = t === "rect_clahe" ? "" : "none";
  });
  const polar = t === "polar" || t === "polar_turbo";
  tb.querySelectorAll(".viz-chk").forEach((el) => {
    el.style.display = polar ? "" : "none";
  });
}

function u8FromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function kindFromMsg(m) {
  if (!m || typeof m !== "object") return null;
  if (typeof m.width === "number" && typeof m.height === "number" && m.data != null) return "image";
  if (Array.isArray(m.ranges) && typeof m.angle_increment === "number") return "laserscan";
  if ((typeof m.angle === "number") && (typeof m.number_of_samples === "number") && (m.intensities != null)) return "sonarecho";
  return null;
}

function drawRaw(ctx, img) {
  const { w, h, grayU8 } = img;
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = grayU8[i];
    id.data[i * 4 + 0] = v;
    id.data[i * 4 + 1] = v;
    id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  // draw to offscreen at native size, then scale to canvas
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  off.getContext("2d").putImageData(id, 0, 0);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const scale = Math.min(ctx.canvas.width / w, ctx.canvas.height / h);
  const dw = Math.floor(w * scale);
  const dh = Math.floor(h * scale);
  const dx = Math.floor((ctx.canvas.width - dw) / 2);
  const dy = Math.floor((ctx.canvas.height - dh) / 2);
  ctx.drawImage(off, dx, dy, dw, dh);
  ctx.restore();
}

function drawLaserScanPolar(ctx, scan) {
  // Render scan.ranges as polar points; color by intensity if available.
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#050813";
  ctx.fillRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2;
  const R = Math.min(cx, cy) * 0.92;

  // Grid
  ctx.strokeStyle = "rgba(255,255,255,.10)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, (i / 4) * R, 0, 2 * Math.PI);
    ctx.stroke();
  }

  const ranges = scan.ranges || [];
  const intens = scan.intensities || [];
  const a0 = scan.angle_min || -Math.PI;
  const da = scan.angle_increment || (2 * Math.PI / Math.max(1, ranges.length));
  const rmax = (scan.range_max && scan.range_max > 0) ? scan.range_max : state.rangeMaxM;

  ctx.fillStyle = "rgba(76,201,240,.95)";
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (!r || r <= 0) continue;
    const a = a0 + i * da + (state.bearingOffsetDeg * Math.PI / 180);
    const rr = clamp(r / rmax, 0, 1) * R;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    const iv = (i < intens.length) ? intens[i] : 0;
    const alpha = intens.length ? clamp((iv / 255), 0.15, 1.0) : 0.8;
    ctx.fillStyle = `rgba(76,201,240,${alpha})`;
    ctx.fillRect(x, y, 2, 2);
  }

  ctx.fillStyle = "rgba(232,238,252,.85)";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace";
  ctx.fillText("LaserScan polar view", 18, 22);
}

function drawSonarEchoAScan(ctx, echo) {
  // Plot intensities vs range along the beam (A-scan).
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#050813";
  ctx.fillRect(0, 0, W, H);

  const pad = 32;
  const w = W - pad * 2;
  const h = H - pad * 2;
  ctx.strokeStyle = "rgba(255,255,255,.15)";
  ctx.strokeRect(pad, pad, w, h);

  const n = echo.number_of_samples || 0;
  let bytes;
  if (typeof echo.intensities === "string") bytes = u8FromBase64(echo.intensities);
  else if (Array.isArray(echo.intensities)) bytes = new Uint8Array(echo.intensities);
  else bytes = new Uint8Array(0);

  const maxRange = (typeof echo.range === "number" && echo.range > 0) ? echo.range : state.rangeMaxM;
  const angleDeg = (typeof echo.angle === "number") ? (echo.angle * 180 / Math.PI) : 0;

  ctx.strokeStyle = "rgba(70,211,154,.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < Math.min(n, bytes.length); i++) {
    const x = pad + (i / Math.max(1, n - 1)) * w;
    const v = bytes[i] / 255;
    const y = pad + (1 - v) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = "rgba(232,238,252,.85)";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace";
  ctx.fillText(`SonarEcho A-scan  angle=${angleDeg.toFixed(1)}°  range=${maxRange}m`, pad, pad - 8);
}

function drawHistogram(ctx, img) {
  const { grayU8 } = img;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < grayU8.length; i++) hist[grayU8[i]]++;
  const max = Math.max(...hist, 1);

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = "#050813";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const pad = 28;
  const w = ctx.canvas.width - pad * 2;
  const h = ctx.canvas.height - pad * 2;
  ctx.strokeStyle = "rgba(255,255,255,.15)";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad, pad, w, h);

  ctx.fillStyle = "rgba(76,201,240,.85)";
  for (let i = 0; i < 256; i++) {
    const x = pad + (i / 256) * w;
    const bh = (hist[i] / max) * h;
    ctx.fillRect(x, pad + (h - bh), Math.max(1, w / 256), bh);
  }

  ctx.fillStyle = "rgba(232,238,252,.85)";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace";
  ctx.fillText("Intensity histogram", pad, pad - 8);
}

function computeBearingPeaks(img) {
  const { w, h, grayU8 } = img;
  const peaks = new Array(w);
  for (let x = 0; x < w; x++) {
    let maxV = -1;
    let maxY = 0;
    for (let y = 0; y < h; y++) {
      const v = grayU8[y * w + x];
      if (v > maxV) { maxV = v; maxY = y; }
    }
    peaks[x] = { y: maxY, v: maxV };
  }
  return peaks;
}

function drawBearingPeaks(ctx, img) {
  const { w, h } = img;
  const peaks = computeBearingPeaks(img);

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = "#050813";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const pad = 28;
  const W = ctx.canvas.width - pad * 2;
  const H = ctx.canvas.height - pad * 2;
  ctx.strokeStyle = "rgba(255,255,255,.15)";
  ctx.strokeRect(pad, pad, W, H);

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(70,211,154,.9)";
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const px = pad + (x / (w - 1)) * W;
    const r = rangeFromY(peaks[x].y, h) / state.rangeMaxM; // 0..1
    const py = pad + r * H;
    if (x === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  ctx.fillStyle = "rgba(232,238,252,.85)";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace";
  ctx.fillText("Peak range per bearing (derived)", pad, pad - 8);
}

function drawPolar(ctx, img) {
  // Approximate polar: map image columns to bearing, rows to range.
  // Renders to a circular sector (full 360° by default).
  const { w, h, grayU8 } = img;

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = "#050813";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const cx = ctx.canvas.width / 2;
  const cy = ctx.canvas.height / 2;
  const R = Math.min(cx, cy) * 0.92;
  const fov = state.fovDeg * Math.PI / 180;
  const start = -fov / 2 + (state.bearingOffsetDeg * Math.PI / 180);
  const end = fov / 2 + (state.bearingOffsetDeg * Math.PI / 180);

  // Draw rings
  ctx.strokeStyle = "rgba(255,255,255,.10)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, (i / 4) * R, start, end);
    ctx.stroke();
  }
  // Draw rays
  for (let i = 0; i <= 8; i++) {
    const a = start + (i / 8) * (end - start);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.stroke();
  }

  // Render by sampling into an offscreen image at canvas size
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const id = ctx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const dx = px - cx;
      const dy = py - cy;
      const rr = Math.sqrt(dx * dx + dy * dy);
      if (rr > R) continue;
      let a = Math.atan2(dy, dx); // [-pi,pi]
      // keep within sector
      // Normalize a to be comparable; we check using wrapped difference.
      const within = angleWithin(a, start, end);
      if (!within) continue;

      const u = (a - start) / (end - start); // 0..1
      const v = rr / R; // 0..1 range

      const sx = clamp(Math.round(u * (w - 1)), 0, w - 1);
      const sy = clamp(Math.round(v * (h - 1)), 0, h - 1);
      const val = grayU8[sy * w + sx];

      const i = (py * W + px) * 4;
      // simple colormap: dark -> cyan -> white
      const t = val / 255;
      const r = Math.round(20 + 235 * Math.pow(t, 1.4));
      const g = Math.round(50 + 205 * Math.pow(t, 1.1));
      const b = Math.round(80 + 175 * Math.pow(t, 1.0));
      id.data[i + 0] = r;
      id.data[i + 1] = g;
      id.data[i + 2] = b;
      id.data[i + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);

  ctx.fillStyle = "rgba(232,238,252,.85)";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace";
  ctx.fillText("Polar view (approximate)", 18, 22);
}

function angleWithin(a, start, end) {
  // Full 360°: never normalize -π and π to the same value (that would collapse the sector to a ray).
  if (end - start >= 2 * Math.PI - 1e-5) return true;
  const norm = (x) => {
    let y = x;
    while (y <= -Math.PI) y += 2 * Math.PI;
    while (y > Math.PI) y -= 2 * Math.PI;
    return y;
  };
  const aa = norm(a), s = norm(start), e = norm(end);
  if (s <= e) return aa >= s && aa <= e;
  return aa >= s || aa <= e;
}

/** Map canvas pixel (polar view) back to image column/row; null if outside sector/disk. */
function imageCoordsFromPolarCanvas(px, py, cw, ch, img) {
  const { w, h } = img;
  const cx = cw / 2;
  const cy = ch / 2;
  const R = Math.min(cx, cy) * 0.92;
  const fov = state.fovDeg * Math.PI / 180;
  const start = -fov / 2 + (state.bearingOffsetDeg * Math.PI / 180);
  const end = fov / 2 + (state.bearingOffsetDeg * Math.PI / 180);
  const dx = px - cx;
  const dy = py - cy;
  const rr = Math.sqrt(dx * dx + dy * dy);
  if (rr > R) return null;
  const ang = Math.atan2(dy, dx);
  if (!angleWithin(ang, start, end)) return null;
  const u = (ang - start) / (end - start);
  const v = rr / R;
  return {
    ix: clamp(Math.round(u * (w - 1)), 0, w - 1),
    iy: clamp(Math.round(v * (h - 1)), 0, h - 1),
  };
}

function render() {
  const canvas = $("mainCanvas");
  const ctx = canvas.getContext("2d");
  const v = state.latest;
  const kind = state.latestKind;
  if (!v || !kind) {
    updateViewLabel();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#050813";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(232,238,252,.75)";
    ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace";
    ctx.fillText(`Waiting for ${state.currentTopic || "selected topic"}…`, 18, 26);
    return;
  }

  if (kind === "image") {
    const img = v;
    updateViewLabel();
    if (state.tab === "raw") drawRaw(ctx, img);
    else if (state.tab === "polar") drawPolar(ctx, img);
    else if (state.tab === "polar_turbo") drawPolarFanTurbo(ctx, img);
    else if (state.tab === "rect_clahe") drawRectClaheTurbo(ctx, img);
    else if (state.tab === "bearing") drawBearingPeaks(ctx, img);
    else if (state.tab === "hist") drawHistogram(ctx, img);
    return;
  }

  if (kind === "laserscan") {
    updateViewLabel();
    drawLaserScanPolar(ctx, v);
    return;
  }

  if (kind === "sonarecho") {
    updateViewLabel();
    drawSonarEchoAScan(ctx, v);
  }
}

function isPing360LikeTopic(t) {
  const name = (t.name || "").toLowerCase();
  const type = (t.type || "").toLowerCase();
  if (type.includes("ping360")) return true;
  if (name.includes("scan_echo") || name.includes("ping360")) return true;
  if (name === "/scan") return true;
  if (name === "/scan_image" || name === "/ping360/scan_image") return true;
  return false;
}

function updateTopicSelect() {
  const sel = $("topicSelect");
  const filter = $("topicFilter").value;
  state.topicFilter = filter;
  const topics = (filter === "ping360")
    ? state.topics.filter(isPing360LikeTopic)
    : state.topics.slice();

  sel.innerHTML = "";
  for (const t of topics) {
    const o = document.createElement("option");
    o.value = t.name;
    o.textContent = `${t.name}  (${t.type || "?"})`;
    sel.appendChild(o);
  }

  // Keep current selection if possible, else pick best default.
  const names = topics.map((t) => t.name);
  let pick = state.currentTopic;
  if (!pick || !names.includes(pick)) {
    pick = names.includes("/scan_echo") ? "/scan_echo"
      : (names.includes("/ping360/scan_image") ? "/ping360/scan_image"
      : (names.includes("/scan_image") ? "/scan_image"
      : (names.includes("/scan") ? "/scan" : (names[0] || null))));
  }
  if (pick) {
    sel.value = pick;
    setCurrentTopic(pick);
  }
}

function setCurrentTopic(topic) {
  const ws = state.ws;
  const tinfo = state.topics.find((t) => t.name === topic);
  state.currentTopicType = tinfo ? tinfo.type : null;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    state.currentTopic = topic;
    state.wsSubscribedTopic = null;
    state.latest = null;
    state.latestKind = null;
    updateSensorStatus();
    render();
    return;
  }

  if (state.currentTopic === topic && state.wsSubscribedTopic === topic) {
    return;
  }

  const subId = "ping360_viewer_main";
  if (state.wsSubscribedTopic) {
    ws.send(JSON.stringify({ op: "unsubscribe", id: subId, topic: state.wsSubscribedTopic }));
  }
  state.currentTopic = topic;
  state.latest = null;
  state.latestKind = null;
  state.lastMsgAt = 0;
  state.frame = 0;
  $("frameReadout").textContent = "0";
  $("imgMeta").textContent = "";
  ws.send(JSON.stringify({
    op: "subscribe",
    id: subId,
    topic,
    type: state.currentTopicType || undefined,
    throttle_rate: 0,
    queue_length: 8,
    compression: "none",
  }));
  state.wsSubscribedTopic = topic;
  updateSensorStatus();
  render();
}

function connectRosbridgeProxy() {
  if (!state.rosbridgeLinkEnabled) {
    return;
  }

  state.wsConnectSeq++;
  const seq = state.wsConnectSeq;

  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }

  if (state.ws) {
    try { state.ws.close(); } catch (_) {}
    state.ws = null;
  }
  state.wsSubscribedTopic = null;
  clearRosbridgeFragments();

  const proto = (location.protocol === "https:") ? "wss" : "ws";
  const wsUrl = `${proto}://${location.host}/ws/rosbridge`;

  setRosbridgeStatus(
    "connecting",
    "Connecting…",
    "Opening WebSocket to this viewer, then to rosbridge on the vehicle.",
    null,
  );
  updateSensorStatus();

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  let linkLostHandled = false;
  let openWatchdog = null;
  const clearOpenWatchdog = () => {
    if (openWatchdog) {
      clearTimeout(openWatchdog);
      openWatchdog = null;
    }
  };
  openWatchdog = setTimeout(() => {
    if (seq !== state.wsConnectSeq) return;
    if (ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(4000, "open watchdog"); } catch (_) {}
    }
  }, 20000);

  let topicsWatchdog = null;
  const clearTopicsWatchdog = () => {
    if (topicsWatchdog) {
      clearTimeout(topicsWatchdog);
      topicsWatchdog = null;
    }
  };

  const scheduleReconnectAfterDetach = (reason) => {
    if (!state.rosbridgeLinkEnabled) return;
    if (seq !== state.wsConnectSeq) return;
    if (state.wsReconnectTimer) return;

    const waitMs = state.wsBackoffMs;
    const waitSec = Math.max(1, Math.round(waitMs / 100) / 10);
    const rb = (state.me && state.me.rosbridge) ? state.me.rosbridge : "(see login rosbridge URL)";
    setRosbridgeStatus(
      "detached",
      "Rosbridge · reconnecting…",
      `Stream paused — link dropped (${reason}). Next try in ~${waitSec}s. Target: ${rb}. If this never clears, expose that port on the Jetson or use the login “Rosbridge WebSocket override” / SSH tunnel.`,
      null,
    );
    updateSensorStatus();

    state.wsBackoffMs = Math.min(8000, Math.floor(state.wsBackoffMs * 1.6));
    state.wsReconnectTimer = setTimeout(() => {
      state.wsReconnectTimer = null;
      if (!state.rosbridgeLinkEnabled) return;
      connectRosbridgeProxy();
    }, waitMs);
  };

  const handleLinkLost = (reason) => {
    clearOpenWatchdog();
    clearTopicsWatchdog();
    if (linkLostHandled) return;
    linkLostHandled = true;
    if (!state.rosbridgeLinkEnabled) return;
    if (seq !== state.wsConnectSeq) return;
    state.connected = false;
    state.wsSubscribedTopic = null;
    scheduleReconnectAfterDetach(reason);
  };

  ws.onopen = () => {
    clearOpenWatchdog();
    if (seq !== state.wsConnectSeq) return;
    if (!state.rosbridgeLinkEnabled) {
      try { ws.close(); } catch (_) {}
      return;
    }
    clearRosbridgeFragments();
    setRosbridgeStatus(
      "connecting",
      "Rosbridge · handshaking…",
      "WebSocket to viewer is up; fetching ROS topic list from rosbridge…",
      null,
    );
    updateSensorStatus();
    clearTopicsWatchdog();
    topicsWatchdog = setTimeout(() => {
      topicsWatchdog = null;
      if (seq !== state.wsConnectSeq) return;
      if (state.rosPhase !== "connecting") return;
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.close(4001, "rosapi topics timeout"); } catch (_) {}
      }
    }, 18000);
    ws.send(JSON.stringify({
      op: "call_service",
      service: "/rosapi/topics",
      args: {},
      id: `topics_init_${seq}`,
    }));
  };

  const handleTopicsServiceResponse = (msg) => {
    clearTopicsWatchdog();
    state.wsBackoffMs = 250;
    const names = (msg.values && msg.values.topics) ? msg.values.topics : [];
    const types = (msg.values && msg.values.types) ? msg.values.types : [];
    const out = [];
    for (let i = 0; i < Math.min(names.length, types.length); i++) {
      out.push({ name: names[i], type: types[i] });
    }
    state.topics = out;

    const sees = out.some((t) =>
      t.name === "/scan_image" || t.name === "/ping360/scan_image" || t.name === "/scan_echo" || t.name === "/scan"
    );
    const rb = (state.me && state.me.rosbridge) ? state.me.rosbridge : "rosbridge";
    setRosbridgeStatus(
      "connected",
      "Rosbridge · connected",
      sees
        ? `Linked to ${rb}. Sonar-related topics visible in ROS graph.`
        : `Linked to ${rb}. No /scan_echo, /scan, or /ping360/scan_image in this graph (topics may appear when nodes start).`,
      null,
    );
    updateTopicSelect();
    updateSensorStatus();
  };

  const handlePublish = (msg) => {
    if (msg.topic !== state.currentTopic || !msg.msg) return;
    state.lastMsgAt = Date.now();
    const k = kindFromMsg(msg.msg);
    state.latestKind = k;
    if (k === "image") {
      const img = grayFromImageMsg(msg.msg);
      state.latest = img;
      state.latestMeta = { type: "sensor_msgs/Image", encoding: img.encoding, w: img.w, h: img.h };
      $("imgMeta").textContent = `${state.currentTopic}  ${img.w}×${img.h} ${(img.encoding || "").trim()}`.trim();
    } else if (k === "laserscan") {
      state.latest = msg.msg;
      const n = (msg.msg.ranges || []).length;
      $("imgMeta").textContent = `${state.currentTopic}  LaserScan n=${n}`;
    } else if (k === "sonarecho") {
      state.latest = msg.msg;
      const n = msg.msg.number_of_samples || 0;
      const a = (typeof msg.msg.angle === "number") ? (msg.msg.angle * 180 / Math.PI) : 0;
      $("imgMeta").textContent = `${state.currentTopic}  SonarEcho samples=${n} angle=${a.toFixed(1)}° range=${msg.msg.range}m`;
    } else {
      state.latest = msg.msg;
      $("imgMeta").textContent = `${state.currentTopic}  (unsupported message shape)`;
    }

    state.frame++;
    $("frameReadout").textContent = String(state.frame);
    updateSensorStatus();
    render();
  };

  ws.onmessage = async (ev) => {
    try {
      const text = await rosbridgePayloadToString(ev.data);
      if (text == null) return;
      const msg = JSON.parse(text);
      dispatchRosbridgeMessage(msg, handleTopicsServiceResponse, handlePublish);
    } catch (e) {
      console.warn("Ping360 Viewer: rosbridge message parse error", e);
    }
  };

  ws.onerror = () => handleLinkLost("network error");
  ws.onclose = () => handleLinkLost("socket closed");
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, credentials: "same-origin" });
  if (res.status === 401) {
    location.href = "/login";
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

async function refreshBags() {
  // Remote rosbag control intentionally disabled (no password prompts).
  disableBagControls();
}

function disableBagControls() {
  $("btnRecord").disabled = true;
  $("btnStopRecord").disabled = true;
  $("btnPlay").disabled = true;
  $("btnStopPlay").disabled = true;
}

async function ensureJetsonPassword() {
  return null;
}

function wireUI() {
  // Tabs
  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.tab = b.dataset.tab;
      updateViewLabel();
      updateVizToolbarVisibility();
      render();
    });
  });

  const syncVizFromDom = () => {
    const c = $("vizClaheClip");
    const t = $("vizClaheTile");
    const g = $("vizPolarGrid");
    const lb = $("vizPolarLabels");
    const lr = $("vizRangeLabels");
    if (c) state.claheClip = clamp(parseFloat(c.value || "3"), 1, 16);
    if (t) state.claheTile = clamp(parseInt(t.value || "48", 10), 8, 128);
    if (g) state.showPolarGrid = g.checked;
    if (lb) state.showPolarLabels = lb.checked;
    if (lr) state.showRangeLabels = lr.checked;
  };
  ["vizClaheClip", "vizClaheTile", "vizPolarGrid", "vizPolarLabels", "vizRangeLabels"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", () => {
      syncVizFromDom();
      render();
    });
    el.addEventListener("input", () => {
      syncVizFromDom();
      render();
    });
  });

  $("fovDeg").addEventListener("input", (e) => {
    state.fovDeg = clamp(parseFloat(e.target.value || "360"), 1, 360);
    render();
  });
  $("rangeMax").addEventListener("input", (e) => {
    state.rangeMaxM = Math.max(0.01, parseFloat(e.target.value || "10"));
    render();
  });
  $("bearingOffset").addEventListener("input", (e) => {
    state.bearingOffsetDeg = clamp(parseFloat(e.target.value || "0"), -180, 180);
    render();
  });

  $("topicFilter").addEventListener("change", () => updateTopicSelect());
  $("topicSelect").addEventListener("change", (e) => setCurrentTopic(e.target.value));

  $("rosbridgeToggle").addEventListener("change", (e) => {
    state.rosbridgeLinkEnabled = e.target.checked;
    e.target.setAttribute("aria-checked", state.rosbridgeLinkEnabled ? "true" : "false");
    localStorage.setItem(ROSBRIDGE_LINK_KEY, String(state.rosbridgeLinkEnabled));
    if (state.rosbridgeLinkEnabled) {
      state.wsBackoffMs = 250;
      connectRosbridgeProxy();
    } else {
      disconnectRosbridgeSoft();
    }
    render();
  });

  // Remote rosbag controls disabled (no prompts)
  disableBagControls();

  const fixForm = $("rosbridgeFixForm");
  if (fixForm) {
    fixForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const pass = $("rosbridgeFixPass").value;
      const url = ($("rosbridgeFixUrl").value || "").trim();
      const body = new URLSearchParams();
      body.set("password", pass);
      body.set("rosbridge", url);
      const res = await fetch("/api/session/rosbridge", {
        method: "POST",
        body,
        credentials: "same-origin",
      });
      if (res.status === 401) {
        const err = await res.json().catch(() => ({}));
        alert(err.detail || "SSH password rejected");
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.detail || `Save failed (${res.status})`);
        return;
      }
      $("rosbridgeFixPass").value = "";
      state.me = await api("/api/me");
      applyRosbridgeReachability(state.me);
      if (state.rosbridgeLinkEnabled) {
        state.wsBackoffMs = 250;
        connectRosbridgeProxy();
      }
    });
  }

  // Hover readout for derived bearing/range
  const canvas = $("mainCanvas");
  const hover = $("hoverReadout");
  canvas.addEventListener("mousemove", (ev) => {
    if (!state.latest || !state.latestKind) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const px = Math.round((x / rect.width) * (canvas.width - 1));
    const py = Math.round((y / rect.height) * (canvas.height - 1));

    if (state.latestKind === "image") {
      const img = state.latest;
      let ix;
      let iy;
      if (state.tab === "polar" || state.tab === "polar_turbo") {
        const mapped = imageCoordsFromPolarCanvas(px, py, canvas.width, canvas.height, img);
        if (!mapped) {
          $("bearingReadout").textContent = "—";
          $("rangeReadout").textContent = "—";
          $("intensityReadout").textContent = "—";
          hover.style.display = "none";
          return;
        }
        ix = mapped.ix;
        iy = mapped.iy;
      } else {
        ix = clamp(Math.round((px / canvas.width) * (img.w - 1)), 0, img.w - 1);
        iy = clamp(Math.round((py / canvas.height) * (img.h - 1)), 0, img.h - 1);
      }
      const b = bearingFromX(ix, img.w);
      const r = rangeFromY(iy, img.h);
      const v = img.grayU8[iy * img.w + ix];
      $("bearingReadout").textContent = `${b.toFixed(1)}°`;
      $("rangeReadout").textContent = `${r.toFixed(2)} m`;
      $("intensityReadout").textContent = String(v);
      hover.style.display = "block";
      hover.style.left = `${Math.min(rect.width - 220, Math.max(12, x + 14))}px`;
      hover.style.top = `${Math.min(rect.height - 44, Math.max(12, y + 14))}px`;
      hover.textContent = `bearing=${b.toFixed(1)}°  range=${r.toFixed(2)}m  I=${v}`;
    } else if (state.latestKind === "sonarecho") {
      const e = state.latest;
      const angleDeg = (typeof e.angle === "number") ? (e.angle * 180 / Math.PI) : 0;
      const maxR = (typeof e.range === "number") ? e.range : state.rangeMaxM;
      $("bearingReadout").textContent = `${angleDeg.toFixed(1)}°`;
      $("rangeReadout").textContent = `${maxR.toFixed(2)} m`;
      $("intensityReadout").textContent = "—";
      hover.style.display = "block";
      hover.style.left = `${Math.min(rect.width - 260, Math.max(12, x + 14))}px`;
      hover.style.top = `${Math.min(rect.height - 44, Math.max(12, y + 14))}px`;
      hover.textContent = `beam angle=${angleDeg.toFixed(1)}°  beam range=${maxR.toFixed(2)}m`;
    } else if (state.latestKind === "laserscan") {
      const s = state.latest;
      const rmax = (s.range_max && s.range_max > 0) ? s.range_max : state.rangeMaxM;
      $("bearingReadout").textContent = "—";
      $("rangeReadout").textContent = `${rmax.toFixed(2)} m`;
      $("intensityReadout").textContent = "—";
      hover.style.display = "block";
      hover.style.left = `${Math.min(rect.width - 260, Math.max(12, x + 14))}px`;
      hover.style.top = `${Math.min(rect.height - 44, Math.max(12, y + 14))}px`;
      hover.textContent = `LaserScan  range_max=${rmax.toFixed(2)}m`;
    }
  });
  canvas.addEventListener("mouseleave", () => {
    hover.style.display = "none";
  });

  // Record UI (webm)
  $("btnDownload").addEventListener("click", () => toggleUiRecording());
}

function toggleUiRecording() {
  const canvas = $("mainCanvas");
  if (state.recorder && state.recorder.state !== "inactive") {
    state.recorder.stop();
    return;
  }

  const stream = canvas.captureStream(30);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm;codecs=vp8";

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  state.recordingChunks = [];
  state.recorder = rec;
  $("btnDownload").textContent = "Stop UI recording";

  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) state.recordingChunks.push(e.data);
  };
  rec.onstop = () => {
    $("btnDownload").textContent = "Record UI (mp4/webm)";
    const blob = new Blob(state.recordingChunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ping360_ui_${new Date().toISOString().replaceAll(":", "-")}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  rec.start(1000);
}

function applyRosbridgePreferenceFromStorage() {
  const saved = localStorage.getItem(ROSBRIDGE_LINK_KEY);
  state.rosbridgeLinkEnabled = saved === null ? true : saved === "true";
  const el = $("rosbridgeToggle");
  if (el) {
    el.checked = state.rosbridgeLinkEnabled;
    el.setAttribute("aria-checked", state.rosbridgeLinkEnabled ? "true" : "false");
  }
  if (state.rosbridgeLinkEnabled) {
    setRosbridgeStatus(
      "connecting",
      "Rosbridge · starting…",
      "Loading session, then opening the WebSocket to rosbridge.",
      null,
    );
    updateSensorStatus();
  } else {
    state.wsSubscribedTopic = null;
    setRosbridgeStatus(
      "off",
      "Rosbridge · off",
      "Switch is off. Turn it on to connect; while on, WiFi loss only pauses and retries.",
      "Sensor: — (rosbridge off)",
    );
    updateSensorStatus();
  }
}

async function boot() {
  applyRosbridgePreferenceFromStorage();
  state.me = await api("/api/me");
  if (!state.me) return;
  applyRosbridgeReachability(state.me);
  wireUI();

  const vc = $("vizClaheClip");
  if (vc) vc.value = String(state.claheClip);
  const vt = $("vizClaheTile");
  if (vt) vt.value = String(state.claheTile);
  const vg = $("vizPolarGrid");
  if (vg) vg.checked = state.showPolarGrid;
  const vlb = $("vizPolarLabels");
  if (vlb) vlb.checked = state.showPolarLabels;
  const vlr = $("vizRangeLabels");
  if (vlr) vlr.checked = state.showRangeLabels;
  updateVizToolbarVisibility();
  updateViewLabel();

  $("rosbridgeToggle").checked = state.rosbridgeLinkEnabled;
  $("rosbridgeToggle").setAttribute("aria-checked", state.rosbridgeLinkEnabled ? "true" : "false");

  await refreshBags();
  if (state.rosbridgeLinkEnabled) connectRosbridgeProxy();
  else disconnectRosbridgeSoft();
  render();

  setInterval(() => {
    updateSensorStatus();
    if (
      state.rosPhase === "connected"
      && state.currentTopic
      && state.frame === 0
      && state.ws
      && state.ws.readyState === WebSocket.OPEN
    ) {
      const since = state.lastMsgAt ? (Date.now() - state.lastMsgAt) : null;
      if (!state.latest && (!since || since > 1500)) {
        const rb = state.me && state.me.rosbridge ? state.me.rosbridge : "rosbridge";
        $("rosbridgeDetail").textContent =
          `Linked to ${rb}. No messages on ${state.currentTopic} yet (check publisher / topic name).`;
      }
    }
  }, 1000);

  // Auto-refresh topic list so new topics appear without reload.
  setInterval(() => {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!state.rosbridgeLinkEnabled) return;
    ws.send(JSON.stringify({
      op: "call_service",
      service: "/rosapi/topics",
      args: {},
      id: `topics_poll_${Date.now()}`,
    }));
  }, 2000);
}

boot().catch((e) => {
  console.error(e);
  setRosbridgeStatus("off", "Error", String(e && e.message ? e.message : e), "Sensor: —");
});

