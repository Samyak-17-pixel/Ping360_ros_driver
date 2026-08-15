/**
 * Polar fan (turbo) + rectangular CLAHE visualization for Ping360 scan_image (mono8).
 * Scan layout: rows = angle (0..h-1), cols = range bins; 0° at top, clockwise.
 */
(function (global) {
  function clamp(x, a, b) {
    return Math.max(a, Math.min(b, x));
  }

  function sampleBilinear(raw, w, h, step, fx, fy) {
    if (fx <= 0 || fy <= 0 || fx >= w - 1 || fy >= h - 1) {
      const ix = clamp(Math.floor(fx), 0, w - 1);
      const iy = clamp(Math.floor(fy), 0, h - 1);
      return raw[iy * step + ix];
    }
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const tx = fx - x0;
    const ty = fy - y0;
    const v00 = raw[y0 * step + x0];
    const v10 = raw[y0 * step + x1];
    const v01 = raw[y1 * step + x0];
    const v11 = raw[y1 * step + x1];
    const a = v00 * (1 - tx) + v10 * tx;
    const b = v01 * (1 - tx) + v11 * tx;
    return a * (1 - ty) + b * ty;
  }

  function histogramEqualizationMap(hist, n) {
    const cdf = new Uint32Array(256);
    cdf[0] = hist[0];
    for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
    let minGray = 0;
    for (let i = 0; i < 256; i++) {
      if (hist[i] > 0) {
        minGray = i;
        break;
      }
    }
    const cdfMin = minGray > 0 ? cdf[minGray - 1] : 0;
    const denom = Math.max(1, cdf[255] - cdfMin);
    const map = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      map[i] = clamp(Math.round(((cdf[i] - cdfMin) * 255) / denom), 0, 255);
    }
    return map;
  }

  function identityMap() {
    const map = new Uint8Array(256);
    for (let i = 0; i < 256; i++) map[i] = i;
    return map;
  }

  /**
   * CLAHE: tile histogram + clip limit + bilinear blend of LUTs.
   * clipLimit: contrast limit (e.g. 2.0–4.0); higher = more local contrast.
   */
  function claheMono8(raw, w, h, step, tilePx, clipLimit) {
    const tw = Math.max(8, Math.min(tilePx, Math.floor(w / 4)));
    const th = tw;
    const nx = Math.ceil(w / tw);
    const ny = Math.ceil(h / th);
    const maps = new Array(nx * ny);

    function equalizeTile(sx, sy, ex, ey) {
      const hist = new Uint32Array(256);
      let count = 0;
      for (let y = sy; y < ey; y++) {
        const row = y * step;
        for (let x = sx; x < ex; x++) {
          hist[raw[row + x]]++;
          count++;
        }
      }
      if (count === 0) {
        return identityMap();
      }
      if (clipLimit > 0 && count > 0) {
        const clip = Math.max(1, Math.floor((clipLimit * count) / 256));
        let excess = 0;
        for (let i = 0; i < 256; i++) {
          if (hist[i] > clip) {
            excess += hist[i] - clip;
            hist[i] = clip;
          }
        }
        const add = Math.floor(excess / 256);
        let rem = excess % 256;
        for (let i = 0; i < 256; i++) {
          hist[i] += add + (rem > 0 ? 1 : 0);
          if (rem > 0) rem--;
        }
      }
      return histogramEqualizationMap(hist, count);
    }

    for (let ty = 0; ty < ny; ty++) {
      for (let tx = 0; tx < nx; tx++) {
        const sx = tx * tw;
        const sy = ty * th;
        const ex = Math.min(w, sx + tw);
        const ey = Math.min(h, sy + th);
        maps[ty * nx + tx] = equalizeTile(sx, sy, ex, ey);
      }
    }

    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const gy = (y + 0.5) / th - 0.5;
      const ty0 = clamp(Math.floor(gy), 0, ny - 1);
      const ty1 = clamp(ty0 + 1, 0, ny - 1);
      const wy = gy - ty0;
      for (let x = 0; x < w; x++) {
        const gx = (x + 0.5) / tw - 0.5;
        const tx0 = clamp(Math.floor(gx), 0, nx - 1);
        const tx1 = clamp(tx0 + 1, 0, nx - 1);
        const wx = gx - tx0;
        const m00 = maps[ty0 * nx + tx0];
        const m10 = maps[ty0 * nx + tx1];
        const m01 = maps[ty1 * nx + tx0];
        const m11 = maps[ty1 * nx + tx1];
        const v = raw[y * step + x];
        const a = m00[v] * (1 - wx) + m10[v] * wx;
        const b = m01[v] * (1 - wx) + m11[v] * wx;
        out[y * w + x] = clamp(Math.round(a * (1 - wy) + b * wy), 0, 255);
      }
    }
    return out;
  }

  function globalHistEq(raw, w, h, step) {
    const hist = new Uint32Array(256);
    for (let y = 0; y < h; y++) {
      const row = y * step;
      for (let x = 0; x < w; x++) hist[raw[row + x]]++;
    }
    const map = histogramEqualizationMap(hist, w * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * step;
      for (let x = 0; x < w; x++) {
        out[y * w + x] = map[raw[row + x]];
      }
    }
    return out;
  }

  /**
   * Render polar fan: value at (angle row, range col) -> screen polar position.
   * 0° = up (−Y), increasing clockwise (matches typical sonar rose).
   */
  function renderPolarFan(raw, w, h, step, size, turboLut, opts) {
    opts = opts || {};
    const innerR = opts.innerFrac != null ? opts.innerFrac : 0.06;
    const bg = opts.bg || [15, 15, 24];
    let g = opts.rangeGateBins | 0;
    if (g < 0) g = 0;
    if (w > 1 && g > w - 2) g = w - 2;
    const img = new ImageData(size, size);
    const d = img.data;
    const cx = size * 0.5;
    const cy = size * 0.5;
    const maxR = size * 0.48;
    const rMin = maxR * innerR;
    const twoPi = Math.PI * 2;
    const spanCols = Math.max(1, w - 1 - g);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let i = (y * size + x) * 4;
        if (dist < rMin || dist > maxR) {
          d[i++] = bg[0];
          d[i++] = bg[1];
          d[i++] = bg[2];
          d[i++] = 255;
          continue;
        }
        let theta = Math.atan2(dx, -dy);
        if (theta < 0) theta += twoPi;
        const fy = (theta / twoPi) * h - 0.5;
        const u = (dist - rMin) / (maxR - rMin);
        const fx = g + u * spanCols - 0.5;
        if (fx < 0 || fx > w - 1 || fy < 0 || fy > h - 1) {
          d[i++] = bg[0];
          d[i++] = bg[1];
          d[i++] = bg[2];
          d[i++] = 255;
          continue;
        }
        const v = sampleBilinear(raw, w, h, step, fx, fy);
        const ti = v * 3;
        d[i++] = turboLut[ti];
        d[i++] = turboLut[ti + 1];
        d[i++] = turboLut[ti + 2];
        d[i++] = 255;
      }
    }
    return img;
  }

  /**
   * Degree labels 0°…315° around the fan (0° = up), matplotlib-style.
   */
  /**
   * Normalized range labels (0.2 … 1.0) along 90° (right), matching typical Ping360 plots.
   * Uses same inner/outer radius convention as renderPolarFan.
   */
  function drawPolarNormalizedRangeLabels(ctx, size, innerFrac) {
    innerFrac = innerFrac != null ? innerFrac : 0.05;
    const cx = size * 0.5;
    const cy = size * 0.5;
    const maxR = size * 0.48;
    const rMin = maxR * innerFrac;
    const fracs = [0.2, 0.4, 0.6, 0.8, 1.0];
    ctx.save();
    ctx.fillStyle = "rgba(210, 218, 235, 0.88)";
    ctx.font = Math.max(7, Math.floor(size / 20)) + "px system-ui,sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const ang = Math.PI / 2;
    for (let i = 0; i < fracs.length; i++) {
      const f = fracs[i];
      const dist = rMin + f * (maxR - rMin);
      const x = cx + Math.sin(ang) * dist + 6;
      const y = cy - Math.cos(ang) * dist;
      ctx.fillText(f.toFixed(1), x, y);
    }
    ctx.restore();
  }

  function drawPolarDegreeLabels(ctx, size) {
    const cx = size * 0.5;
    const cy = size * 0.5;
    const rLabel = size * 0.46;
    const fs = Math.max(7, Math.floor(size / 16));
    ctx.save();
    ctx.fillStyle = "rgba(180, 190, 220, 0.82)";
    ctx.font = fs + "px system-ui,sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const labels = [0, 45, 90, 135, 180, 225, 270, 315];
    for (let k = 0; k < labels.length; k++) {
      const rad = (labels[k] * Math.PI) / 180;
      const x = cx + Math.sin(rad) * rLabel;
      const y = cy - Math.cos(rad) * rLabel;
      ctx.fillText(labels[k] + "°", x, y);
    }
    ctx.restore();
  }

  /**
   * Rings and spokes in the same annulus as renderPolarFan / range labels (not from geometric center).
   * Ring k is at normalized frac k/rings along [rMin, maxR] so 5 rings sit at 0.2…1.0 with defaults.
   */
  function drawPolarGrid(ctx, size, rings, spokes, innerFrac) {
    innerFrac = innerFrac != null ? innerFrac : 0.05;
    const cx = size * 0.5;
    const cy = size * 0.5;
    const maxR = size * 0.48;
    const rMin = maxR * innerFrac;
    ctx.save();
    ctx.strokeStyle = "rgba(200,210,255,0.14)";
    ctx.lineWidth = 1;
    for (let r = 1; r <= rings; r++) {
      const frac = r / rings;
      const rad = rMin + frac * (maxR - rMin);
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let s = 0; s < spokes; s++) {
      const ang = (s / spokes) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(ang) * rMin, cy - Math.cos(ang) * rMin);
      ctx.lineTo(cx + Math.sin(ang) * maxR, cy - Math.cos(ang) * maxR);
      ctx.stroke();
    }
    ctx.restore();
  }

  function renderRectHeatmap(gray, w, h, stride, turboLut, flipY) {
    const img = new ImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const sy = flipY ? h - 1 - y : y;
      for (let x = 0; x < w; x++) {
        const v = gray[sy * stride + x];
        const ti = v * 3;
        const o = (y * w + x) * 4;
        d[o] = turboLut[ti];
        d[o + 1] = turboLut[ti + 1];
        d[o + 2] = turboLut[ti + 2];
        d[o + 3] = 255;
      }
    }
    return img;
  }

  function renderRectGray(gray, w, h, stride, flipY) {
    const img = new ImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const sy = flipY ? h - 1 - y : y;
      for (let x = 0; x < w; x++) {
        const v = gray[sy * stride + x];
        const o = (y * w + x) * 4;
        d[o] = v;
        d[o + 1] = v;
        d[o + 2] = v;
        d[o + 3] = 255;
      }
    }
    return img;
  }

  /**
   * LaserScan: polar dots, angle from ROS convention (0 = forward / +x in REP-103).
   * Plots in "up is forward" screen coords (same spirit as Image fan).
   */
  function drawLaserScan(ctx, msg, size, turboLut) {
    const ranges = msg.ranges;
    if (!ranges || ranges.length === 0) return;
    const cx = size * 0.5;
    const cy = size * 0.5;
    const maxR = size * 0.45;
    const amin = Number(msg.angle_min) || 0;
    const inc = Number(msg.angle_increment) || 0;
    const rmin = Number(msg.range_min) || 0;
    const rmax = Number(msg.range_max) || 1;
    const span = Math.max(1e-6, rmax - rmin);
    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = "rgba(200,210,255,0.1)";
    ctx.lineWidth = 1;
    for (let g = 1; g <= 5; g++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (maxR * g) / 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let i = 0; i < ranges.length; i++) {
      let r = ranges[i];
      if (typeof r !== "number" || !isFinite(r) || r < rmin || r > rmax) continue;
      const th = amin + i * inc;
      const rn = ((r - rmin) / span) * maxR;
      const x = cx + Math.sin(th) * rn;
      const y = cy - Math.cos(th) * rn;
      const v = Math.min(255, Math.max(0, Math.round((1 - (r - rmin) / span) * 255)));
      const ti = v * 3;
      ctx.fillStyle = "rgb(" + turboLut[ti] + "," + turboLut[ti + 1] + "," + turboLut[ti + 2] + ")";
      ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
    }
  }

  global.Ping360Viz = {
    sampleBilinear: sampleBilinear,
    claheMono8: claheMono8,
    globalHistEq: globalHistEq,
    renderPolarFan: renderPolarFan,
    drawPolarGrid: drawPolarGrid,
    renderRectHeatmap: renderRectHeatmap,
    renderRectGray: renderRectGray,
    drawLaserScan: drawLaserScan,
    drawPolarDegreeLabels: drawPolarDegreeLabels,
    drawPolarNormalizedRangeLabels: drawPolarNormalizedRangeLabels,
  };
})(typeof window !== "undefined" ? window : globalThis);
