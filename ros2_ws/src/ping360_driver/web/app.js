(function () {
  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get("ws") || "ws://127.0.0.1:9090";
  const topicParam = params.get("topic") || "";

  document.getElementById("ws-url").textContent = wsUrl;

  const turboLut = window.TURBO_LUT;
  const MV = window.Ping360MessageViz;
  const TE = window.Ping360TopicExplorer;

  const pillConn = document.getElementById("pill-conn");
  const pillFps = document.getElementById("pill-fps");
  const pillStamp = document.getElementById("pill-stamp");
  const pillSize = document.getElementById("pill-size");
  const topicDisplay = document.getElementById("topic-display");
  const topicTypePill = document.getElementById("topic-type-pill");
  const jsonLabel = document.getElementById("json-topic-label");
  const messageJsonEl = document.getElementById("message-json");

  const vizPlaceholder = document.getElementById("viz-placeholder");
  const vizPanelImage = document.getElementById("viz-panel-image");
  const rowRaw = document.getElementById("row-raw");
  const vizPanelLaser = document.getElementById("viz-panel-laser");
  const vizPanelScalar = document.getElementById("viz-panel-scalar");
  const vizPanelString = document.getElementById("viz-panel-string");
  const vizPanelNote = document.getElementById("viz-panel-note");
  const controlsImage = document.getElementById("controls-image");

  const canvasPolar = document.getElementById("canvas-polar");
  const ctxPolar = canvasPolar.getContext("2d");
  const canvasRectTurbo = document.getElementById("canvas-rect-turbo");
  const ctxRectTurbo = canvasRectTurbo.getContext("2d");
  const canvasRectGray = document.getElementById("canvas-rect-gray");
  const ctxRectGray = canvasRectGray.getContext("2d");
  const canvasLaser = document.getElementById("canvas-laser");
  const ctxLaser = canvasLaser.getContext("2d");

  const optGrid = document.getElementById("opt-grid");
  const optPolarDeg = document.getElementById("opt-polar-deg");
  const optPolarRange = document.getElementById("opt-polar-range");
  const optPolarClahe = document.getElementById("opt-polar-clahe");
  const optPolarGate = document.getElementById("opt-polar-gate");
  const optClahe = document.getElementById("opt-clahe");
  const optClip = document.getElementById("opt-clip");
  const optTile = document.getElementById("opt-tile");
  const optRectGray = document.getElementById("opt-rectgray");
  const optPolarSz = document.getElementById("opt-polarsz");
  const polarSzLabel = document.getElementById("polar-sz-label");
  const optMontage = document.getElementById("opt-montage");
  const montageSection = document.getElementById("montage-section");

  const POLAR_INNER_FRAC = 0.05;
  let lastDerived = null;
  let lastAuto = null;

  const MONTAGE_CELL = 180;
  const montageBuffer = [];
  let montageCanvases = [];
  let sessionT0 = null;
  let lastMontagePushMs = 0;
  const MONTAGE_MIN_MS = 120;

  let latestImageMsg = null;
  let rafPending = false;
  let fpsCount = 0;
  let fpsLast = performance.now();
  let activeTopicListener = null;
  let activeTopicHandle = null;

  const ros = new ROSLIB.Ros({ url: wsUrl });
  ros.on("error", function () {
    pillConn.textContent = "error";
    pillConn.className = "pill off";
  });
  ros.on("connection", function () {
    pillConn.textContent = "connected";
    pillConn.className = "pill on";
  });
  ros.on("close", function () {
    pillConn.textContent = "disconnected";
    pillConn.className = "pill off";
  });

  function findPeakInImage(raw, w, h, step) {
    let best = -1;
    let row = 0;
    let col = 0;
    for (let y = 0; y < h; y++) {
      const base = y * step;
      for (let x = 0; x < w; x++) {
        const v = raw[base + x];
        if (v > best) {
          best = v;
          row = y;
          col = x;
        }
      }
    }
    return { row: row, col: col, intensity: best };
  }

  function bearingDegFromRow(row, h) {
    return ((row + 0.5) / Math.max(1, h)) * 360;
  }

  function rangeMFromCol(col, w, samplePeriod25ns, soundMps) {
    const sp = samplePeriod25ns != null && samplePeriod25ns > 0 ? samplePeriod25ns : 88;
    const c = soundMps != null && soundMps > 0 ? soundMps : 1500;
    return (col + 0.5) * sp * 25e-9 * c * 0.5;
  }

  function updateRangeBearingReadout(raw, w, h, step) {
    const peak = findPeakInImage(raw, w, h, step);
    const rangeNorm = (peak.col + 0.5) / w;
    const bearingImg = bearingDegFromRow(peak.row, h);
    const sp = lastAuto && lastAuto.sample_period_25ns;
    const cFromDerived =
      lastDerived && lastDerived.speed_of_sound_mps != null && lastDerived.speed_of_sound_mps > 0
        ? lastDerived.speed_of_sound_mps
        : null;
    const rangeEst = rangeMFromCol(peak.col, w, sp, cFromDerived);

    document.getElementById("rb-range-norm").textContent = rangeNorm.toFixed(3);
    document.getElementById("rb-peak-cell").textContent = peak.row + ", " + peak.col;
    document.getElementById("rb-intensity").textContent = String(peak.intensity);

    if (lastDerived) {
      let br;
      if (lastDerived.angle_rad != null && isFinite(lastDerived.angle_rad)) {
        br = ((lastDerived.angle_rad * 180) / Math.PI).toFixed(1) + "°";
      } else if (lastDerived.angle_gradians != null) {
        br = (Number(lastDerived.angle_gradians) * 0.9).toFixed(1) + "°";
      } else {
        br = "—";
      }
      document.getElementById("rb-bearing").textContent = br + " (device)";
      document.getElementById("rb-range-m").textContent =
        Number(lastDerived.range_to_peak_m).toFixed(2) + " m (device)";
      document.getElementById("rb-source").textContent =
        "Device values from /ping360/derived. Image peak bearing " +
        bearingImg.toFixed(1) +
        "°, est. range " +
        rangeEst.toFixed(2) +
        " m (brightest pixel + sample_period).";
    } else {
      document.getElementById("rb-bearing").textContent = bearingImg.toFixed(1) + "° (image peak row)";
      document.getElementById("rb-range-m").textContent = rangeEst.toFixed(2) + " m (estimated)";
      document.getElementById("rb-source").textContent =
        lastAuto
          ? "No /ping360/derived — bearing from row; range from brightest column and sample_period_25ns=" +
            lastAuto.sample_period_25ns +
            "."
          : "No /ping360/derived or /ping360/auto_device_data — range estimate uses default period 88×25 ns, c=" +
            (cFromDerived || 1500) +
            " m/s.";
    }
  }

  function decodeImageData(data) {
    if (!data) return new Uint8Array(0);
    if (data instanceof Uint8Array) return data;
    if (data instanceof Array) return new Uint8Array(data);
    if (typeof data === "string") {
      const bin = atob(data);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(0);
  }

  function hideAllViz() {
    vizPlaceholder.hidden = true;
    vizPanelImage.hidden = true;
    rowRaw.hidden = true;
    vizPanelLaser.hidden = true;
    vizPanelScalar.hidden = true;
    vizPanelString.hidden = true;
    vizPanelNote.hidden = true;
    controlsImage.hidden = true;
    montageSection.hidden = true;
  }

  function showPlaceholder() {
    hideAllViz();
    vizPlaceholder.hidden = false;
  }

  function setHudStamp(msg) {
    if (msg && msg.header && msg.header.stamp) {
      const s = msg.header.stamp.sec;
      const ns = msg.header.stamp.nanosec;
      pillStamp.textContent = "stamp " + s + "." + String(Math.floor(ns / 1e6)).padStart(3, "0");
    } else {
      pillStamp.textContent = "stamp —";
    }
  }

  function drawImageViz() {
    rafPending = false;
    const msg = latestImageMsg;
    if (!msg || (msg.encoding !== "mono8" && msg.encoding !== "8UC1")) return;

    const w = msg.width;
    const h = msg.height;
    const step = msg.step || w;
    if (!w || !h) return;

    const raw = decodeImageData(msg.data);
    if (raw.length < (h - 1) * step + w) return;

    const clip = parseFloat(optClip.value) || 3;
    const tile = parseInt(optTile.value, 10) || 48;
    let eq;
    if (optClahe.checked) {
      eq = Ping360Viz.claheMono8(raw, w, h, step, tile, clip);
    } else {
      eq = Ping360Viz.globalHistEq(raw, w, h, step);
    }

    const useEqPolar = !optPolarClahe || optPolarClahe.checked;
    const polarBuf = useEqPolar ? eq : raw;
    const polarStep = useEqPolar ? w : step;
    let gateBins = optPolarGate ? parseInt(optPolarGate.value, 10) : 0;
    if (!isFinite(gateBins) || gateBins < 0) gateBins = 0;

    const polarSize = parseInt(optPolarSz.value, 10) || 480;
    if (canvasPolar.width !== polarSize) {
      canvasPolar.width = polarSize;
      canvasPolar.height = polarSize;
    }

    const polarImg = Ping360Viz.renderPolarFan(polarBuf, w, h, polarStep, polarSize, turboLut, {
      innerFrac: POLAR_INNER_FRAC,
      bg: [10, 12, 18],
      rangeGateBins: gateBins,
    });
    ctxPolar.putImageData(polarImg, 0, 0);
    if (optGrid.checked) {
      Ping360Viz.drawPolarGrid(ctxPolar, polarSize, 5, 8, POLAR_INNER_FRAC);
    }
    if (optPolarDeg && optPolarDeg.checked) {
      Ping360Viz.drawPolarDegreeLabels(ctxPolar, polarSize);
    }
    if (optPolarRange && optPolarRange.checked) {
      Ping360Viz.drawPolarNormalizedRangeLabels(ctxPolar, polarSize, POLAR_INNER_FRAC);
    }
    updateRangeBearingReadout(polarBuf, w, h, polarStep);

    canvasRectTurbo.width = w;
    canvasRectTurbo.height = h;
    const rectTurboImg = Ping360Viz.renderRectHeatmap(eq, w, h, w, turboLut, true);
    ctxRectTurbo.putImageData(rectTurboImg, 0, 0);

    if (optRectGray.checked) {
      rowRaw.hidden = false;
      canvasRectGray.width = w;
      canvasRectGray.height = h;
      const grayImg = Ping360Viz.renderRectGray(raw, w, h, step, true);
      ctxRectGray.putImageData(grayImg, 0, 0);
    } else {
      rowRaw.hidden = true;
    }

    pillSize.textContent = w + "×" + h + " px";

    montageSection.hidden = !optMontage.checked;
    if (optMontage.checked && montageCanvases.length === 12) {
      const nowMs = performance.now();
      const canPush =
        montageBuffer.length === 0 || nowMs - lastMontagePushMs >= MONTAGE_MIN_MS;
      if (canPush) {
        lastMontagePushMs = nowMs;
        let tSec = nowMs * 0.001;
        if (msg.header && msg.header.stamp) {
          tSec = msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9;
        }
        if (sessionT0 === null) {
          sessionT0 = tSec;
        }
        const small = Ping360Viz.renderPolarFan(polarBuf, w, h, polarStep, MONTAGE_CELL, turboLut, {
          innerFrac: POLAR_INNER_FRAC,
          bg: [10, 12, 18],
          rangeGateBins: gateBins,
        });
        montageBuffer.push({
          rel: tSec - sessionT0,
          img: small,
        });
        while (montageBuffer.length > 12) {
          montageBuffer.shift();
        }
      }
      for (let i = 0; i < 12; i++) {
        const cell = montageCanvases[i];
        if (i < montageBuffer.length) {
          const b = montageBuffer[i];
          cell.ctx.putImageData(b.img, 0, 0);
          Ping360Viz.drawPolarGrid(cell.ctx, MONTAGE_CELL, 5, 8, POLAR_INNER_FRAC);
          if (optPolarDeg && optPolarDeg.checked) {
            Ping360Viz.drawPolarDegreeLabels(cell.ctx, MONTAGE_CELL);
          }
          if (optPolarRange && optPolarRange.checked && MONTAGE_CELL >= 100) {
            Ping360Viz.drawPolarNormalizedRangeLabels(cell.ctx, MONTAGE_CELL, POLAR_INNER_FRAC);
          }
          cell.cap.textContent = "t=" + b.rel.toFixed(1) + "s";
        } else {
          cell.ctx.fillStyle = "#0a0c10";
          cell.ctx.fillRect(0, 0, MONTAGE_CELL, MONTAGE_CELL);
          cell.cap.textContent = "—";
        }
      }
    }

    const now = performance.now();
    fpsCount++;
    if (now - fpsLast >= 1000) {
      const fd = Math.round((fpsCount * 1000) / (now - fpsLast));
      fpsCount = 0;
      fpsLast = now;
      pillFps.textContent = fd + " fps";
    }
  }

  function scheduleImageDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(drawImageViz);
  }

  function handleMessage(msg, type) {
    messageJsonEl.textContent = MV.stringify(msg);
    jsonLabel.textContent = "(" + type + ")";

    const mode = MV.visualMode(type);
    setHudStamp(msg.header ? msg : null);

    explorer.tickHz();

    if (mode === "image") {
      hideAllViz();
      latestImageMsg = msg;
      vizPanelImage.hidden = false;
      controlsImage.hidden = false;
      vizPlaceholder.hidden = true;
      montageSection.hidden = !optMontage.checked;
      setHudStamp(msg);
      scheduleImageDraw();
      return;
    }

    latestImageMsg = null;
    montageBuffer.length = 0;
    sessionT0 = null;

    if (mode === "laser") {
      hideAllViz();
      vizPanelLaser.hidden = false;
      const sz = 480;
      canvasLaser.width = sz;
      canvasLaser.height = sz;
      Ping360Viz.drawLaserScan(ctxLaser, msg, sz, turboLut);
      pillSize.textContent = ((msg.ranges && msg.ranges.length) || 0) + " ranges";
      fpsCount++;
      const now = performance.now();
      if (now - fpsLast >= 1000) {
        pillFps.textContent = Math.round((fpsCount * 1000) / (now - fpsLast)) + " fps";
        fpsCount = 0;
        fpsLast = now;
      }
      return;
    }

    if (mode === "scalar_float" || mode === "scalar_int") {
      hideAllViz();
      vizPanelScalar.hidden = false;
      document.getElementById("viz-scalar-value").textContent = MV.scalarSummary(msg, type);
      pillSize.textContent = "scalar";
      return;
    }

    if (mode === "string") {
      hideAllViz();
      vizPanelString.hidden = false;
      document.getElementById("viz-string-value").textContent = msg.data || "";
      return;
    }

    if (mode === "twist") {
      hideAllViz();
      vizPanelNote.hidden = false;
      const tw = msg.twist ? msg.twist : msg;
      const l = tw.linear || {};
      const a = tw.angular || {};
      document.getElementById("viz-note-text").innerHTML =
        "<strong>linear</strong> x,y,z = " +
        [l.x, l.y, l.z].map(function (x) {
          return (x !== undefined ? Number(x).toFixed(3) : "—");
        }).join(", ") +
        "<br/><strong>angular</strong> x,y,z = " +
        [a.x, a.y, a.z].map(function (x) {
          return (x !== undefined ? Number(x).toFixed(3) : "—");
        }).join(", ");
      return;
    }

    if (mode === "vector3") {
      hideAllViz();
      vizPanelNote.hidden = false;
      document.getElementById("viz-note-text").textContent =
        "x=" + msg.x + "  y=" + msg.y + "  z=" + msg.z;
      return;
    }

    if (mode === "range") {
      hideAllViz();
      vizPanelNote.hidden = false;
      document.getElementById("viz-note-text").textContent =
        "range = " +
        (msg.range !== undefined ? msg.range.toFixed(3) : "—") +
        " m · min " +
        (msg.min_range !== undefined ? msg.min_range : "?") +
        " · max " +
        (msg.max_range !== undefined ? msg.max_range : "?");
      return;
    }

    if (mode === "pointcloud2") {
      hideAllViz();
      vizPanelNote.hidden = false;
      document.getElementById("viz-note-text").textContent =
        "height=" +
        msg.height +
        " width=" +
        msg.width +
        " row_step=" +
        msg.row_step +
        " point_step=" +
        msg.point_step +
        " · fields=" +
        (msg.fields && msg.fields.map ? msg.fields.map(function (f) {
          return f.name;
        }).join(", ") : "—");
      return;
    }

    if (mode === "compressed") {
      hideAllViz();
      vizPanelNote.hidden = false;
      document.getElementById("viz-note-text").textContent =
        "Compressed image (" +
        (msg.format || "?") +
        ") — decode in a node or use raw sensor_msgs/Image for the full polar UI.";
      return;
    }

    hideAllViz();
    vizPanelNote.hidden = false;
    document.getElementById("viz-note-text").textContent =
      "No dedicated visual for this type — see JSON below. Common types: sensor_msgs/Image, LaserScan.";
  }

  function subscribeTopic(name, type) {
    if (activeTopicHandle && activeTopicListener) {
      activeTopicHandle.unsubscribe(activeTopicListener);
    }
    activeTopicListener = null;
    activeTopicHandle = null;

    topicDisplay.textContent = name;
    topicTypePill.textContent = type;

    activeTopicListener = function (msg) {
      handleMessage(msg, type);
    };
    activeTopicHandle = new ROSLIB.Topic({
      ros: ros,
      name: name,
      messageType: type,
    });
    activeTopicHandle.subscribe(activeTopicListener);

    montageBuffer.length = 0;
    sessionT0 = null;
    lastMontagePushMs = 0;
    clearMontageDisplay();
    if (MV.visualMode(type) !== "image") {
      latestImageMsg = null;
    }
    fpsCount = 0;
    fpsLast = performance.now();
    pillFps.textContent = "— fps";
  }

  let didAutoSelect = false;

  const explorer = TE.init(ros, {
    onSelect: function (name, type) {
      subscribeTopic(name, type);
    },
    onHz: function () {},
    onTopicsReady: function (topics) {
      if (didAutoSelect) return;
      const want = topicParam || "/ping360/scan_image";
      const i = topics.indexOf(want);
      if (i >= 0) {
        didAutoSelect = true;
        explorer.selectByTopicName(want);
      }
    },
  });

  ["change", "input"].forEach(function (ev) {
    optPolarSz.addEventListener(ev, function () {
      polarSzLabel.textContent = optPolarSz.value + " px";
      if (latestImageMsg) scheduleImageDraw();
    });
  });
  if (optPolarGate) {
    ["change", "input"].forEach(function (ev) {
      optPolarGate.addEventListener(ev, function () {
        if (latestImageMsg) scheduleImageDraw();
      });
    });
  }
  [optGrid, optPolarDeg, optPolarRange, optPolarClahe, optClahe, optClip, optTile, optRectGray, optMontage].forEach(
    function (el) {
      el.addEventListener("change", function () {
        if (optMontage === el) {
          montageSection.hidden = !optMontage.checked;
          if (!optMontage.checked) {
            montageBuffer.length = 0;
            sessionT0 = null;
            lastMontagePushMs = 0;
          }
        }
        if (latestImageMsg) scheduleImageDraw();
      });
    }
  );

  function clearMontageDisplay() {
    for (let i = 0; i < montageCanvases.length; i++) {
      const cell = montageCanvases[i];
      cell.ctx.fillStyle = "#0a0c10";
      cell.ctx.fillRect(0, 0, MONTAGE_CELL, MONTAGE_CELL);
      cell.cap.textContent = "—";
    }
  }

  (function initMontageGrid() {
    const grid = document.getElementById("montage-grid");
    if (!grid) return;
    grid.innerHTML = "";
    montageCanvases = [];
    for (let i = 0; i < 12; i++) {
      const fig = document.createElement("figure");
      fig.className = "montage-cell";
      const cap = document.createElement("figcaption");
      cap.className = "montage-cap";
      cap.textContent = "—";
      const cv = document.createElement("canvas");
      cv.width = MONTAGE_CELL;
      cv.height = MONTAGE_CELL;
      fig.appendChild(cv);
      fig.appendChild(cap);
      grid.appendChild(fig);
      montageCanvases.push({ canvas: cv, cap: cap, ctx: cv.getContext("2d") });
    }
  })();

  const srvStart = new ROSLIB.Service({
    ros: ros,
    name: "/ping360/recorder/start",
    serviceType: "ping360_msgs/srv/StartRecording",
  });
  const srvStop = new ROSLIB.Service({
    ros: ros,
    name: "/ping360/recorder/stop",
    serviceType: "ping360_msgs/srv/StopRecording",
  });

  document.getElementById("btn-start").onclick = function () {
    const out = document.getElementById("rec-dir").value.trim();
    const prefix = document.getElementById("rec-prefix").value.trim();
    srvStart.callService(
      new ROSLIB.ServiceRequest({
        output_directory: out,
        bag_name_prefix: prefix,
        topics: [],
      }),
      function (res) {
        document.getElementById("rec-log").textContent = JSON.stringify(res, null, 2);
      }
    );
  };
  document.getElementById("btn-stop").onclick = function () {
    srvStop.callService(new ROSLIB.ServiceRequest({}), function (res) {
      document.getElementById("rec-log").textContent = JSON.stringify(res, null, 2);
    });
  };

  (function wireAuxPing360Topics() {
    const tDer = new ROSLIB.Topic({
      ros: ros,
      name: "/ping360/derived",
      messageType: "ping360_msgs/msg/Ping360Derived",
    });
    tDer.subscribe(function (msg) {
      lastDerived = msg;
      if (latestImageMsg) scheduleImageDraw();
    });
    const tAuto = new ROSLIB.Topic({
      ros: ros,
      name: "/ping360/auto_device_data",
      messageType: "ping360_msgs/msg/Ping360AutoDeviceData",
    });
    tAuto.subscribe(function (msg) {
      lastAuto = msg;
      if (latestImageMsg) scheduleImageDraw();
    });
  })();

  showPlaceholder();
})();
