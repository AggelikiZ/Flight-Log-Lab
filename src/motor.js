/* Flight Log Lab — motor & thrust analysis. Pure JS, no DOM; testable in Node (node test-motor.js). */
var MOTOR = (function () {
  'use strict';
  var G = 9.80665, RAIR = 287.05, GAMMA = 1.4, LAPSE = 0.0065, BARO_EXP = G / (LAPSE * RAIR);

  function fin(x) { return typeof x === 'number' && isFinite(x); }
  function isNum(s) { return s != null && s !== '' && isFinite(+s); }
  function median(a) {
    var b = Array.prototype.filter.call(a, fin).sort(function (x, y) { return x - y; }), n = b.length;
    return n ? (n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2) : NaN;
  }
  function idx(t, x) { var lo = 0, hi = t.length - 1; if (x <= t[0]) return 0; if (x >= t[hi]) return hi; while (hi - lo > 1) { var m = (lo + hi) >> 1; if (t[m] < x) lo = m; else hi = m; } return hi; }

  /* ------------------------------------------------------------------ */
  /* Thrust-curve files                                                  */
  /* ------------------------------------------------------------------ */
  function normalizeCurve(pts) {
    pts = pts.filter(function (p) { return fin(p[0]) && fin(p[1]) && p[0] >= 0; }).map(function (p) { return [p[0], Math.max(0, p[1])]; });
    pts.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    pts.forEach(function (p) { if (out.length && out[out.length - 1][0] === p[0]) out[out.length - 1] = p; else out.push(p); });
    if (!out.length) return out;
    if (out[0][0] > 0) out.unshift([0, 0]);
    if (out[out.length - 1][1] > 0) out.push([out[out.length - 1][0] + 0.001, 0]);
    return out;
  }
  // RASP .eng: ';' comments, header "name dia_mm len_mm delays prop_kg total_kg maker", then "time thrust" rows
  function parseEng(text) {
    var hdr = null, pts = [], lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].replace(/;.*$/, '').trim(); if (!l) continue;
      var tok = l.split(/\s+/);
      if (!hdr) { if (tok.length >= 7 && isNum(tok[1]) && isNum(tok[2]) && isNum(tok[4]) && isNum(tok[5])) hdr = tok; continue; }
      if (tok.length >= 2 && isNum(tok[0]) && isNum(tok[1])) pts.push([+tok[0], +tok[1]]);
      else if (pts.length) break; // next motor in a multi-motor file
    }
    if (!hdr || pts.length < 2) return null;
    return { name: hdr[0], maker: hdr.slice(6).join(' '), diameter_mm: +hdr[1], length_mm: +hdr[2], delays: hdr[3], propMass: +hdr[4], totalMass: +hdr[5], curve: normalizeCurve(pts), source: 'eng' };
  }
  // RockSim .rse (XML). Masses in grams.
  function parseRse(text) {
    var m = /<engine\s([^>]*)>/i.exec(text); if (!m) return null;
    function attr(s, k) { var r = new RegExp('\\b' + k + '\\s*=\\s*"([^"]*)"', 'i').exec(s); return r ? r[1] : null; }
    var a = m[1], pts = [], re = /<eng-data\b([^>]*)\/?>/gi, d, body = text.slice(m.index);
    while ((d = re.exec(body))) { var tt = attr(d[1], 't'), ff = attr(d[1], 'f'); if (isNum(tt) && isNum(ff)) pts.push([+tt, +ff]); }
    if (pts.length < 2) return null;
    var pw = attr(a, 'propWt'), iw = attr(a, 'Initwt');
    return { name: attr(a, 'code') || 'motor', maker: attr(a, 'mfg') || '', diameter_mm: +attr(a, 'dia') || NaN, length_mm: +attr(a, 'len') || NaN, delays: attr(a, 'delays') || '',
      propMass: isNum(pw) ? +pw / 1000 : NaN, totalMass: isNum(iw) ? +iw / 1000 : NaN, curve: normalizeCurve(pts), source: 'rse' };
  }
  // Plain "time, thrust" table (e.g. static-fire bench). Units from the header: ms / kN / lbf; else s and N.
  function parseThrustTable(text, name) {
    var lines = String(text).split(/\r?\n/), hdr = '', pts = [];
    lines.forEach(function (l) {
      var tok = l.trim().split(/[,;\t ]+/).filter(Boolean);
      if (tok.length >= 2 && isNum(tok[0]) && isNum(tok[1])) pts.push([+tok[0], +tok[1]]);
      else if (!pts.length && l.trim()) hdr += ' ' + l.toLowerCase();
    });
    if (pts.length < 3) return null;
    var tS = /\bms\b|millis|_ms\b|\(ms\)|\[ms\]/.test(hdr) ? 1e-3 : 1;
    var fS = /kn\b/.test(hdr) ? 1000 : /lbf|\blb\b/.test(hdr) ? 4.4482216 : /kgf|\bkg\b/.test(hdr) ? G : 1;
    var t0 = pts[0][0];
    pts = pts.map(function (p) { return [(p[0] - t0) * tS, p[1] * fS]; });
    return { name: name || 'Thrust curve', maker: '', diameter_mm: NaN, length_mm: NaN, delays: '', propMass: NaN, totalMass: NaN, curve: normalizeCurve(pts), source: 'table', units: { time: tS === 1 ? 's' : 'ms', force: fS === 1 ? 'N' : fS === 1000 ? 'kN' : fS === G ? 'kgf' : 'lbf' } };
  }
  function parseMotorFile(text, fileName) {
    var base = String(fileName || '').replace(/\.[^.]+$/, '');
    if (/<engine\s/i.test(text)) return parseRse(text);
    return parseEng(text) || parseThrustTable(text, base);
  }
  // Approximate curve from catalogue numbers: fast rise, flat, short tail-off (area = impulse).
  function manualMotor(o) {
    var I = +o.impulse, tb = +o.burnTime; if (!(I > 0 && tb > 0)) return null;
    var F = I / (0.925 * tb);
    return { name: o.name || 'Manual motor', maker: o.maker || '', diameter_mm: +o.diameter_mm || NaN, length_mm: NaN, delays: '', propMass: +o.propMass || NaN, totalMass: +o.totalMass || NaN,
      curve: [[0, 0], [0.05 * tb, F], [0.9 * tb, F], [tb, 0]], source: 'manual', approx: true };
  }

  /* ------------------------------------------------------------------ */
  /* Motor numbers                                                       */
  /* ------------------------------------------------------------------ */
  function classLetter(I) { var n = Math.max(0, Math.ceil(Math.log(I / 2.5) / Math.LN2 - 1e-9)); return n < 26 ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[n] : '?'; }
  function prepare(m) {
    var c = m.curve, cum = [0], peak = 0, peakT = 0;
    for (var i = 1; i < c.length; i++) cum.push(cum[i - 1] + (c[i][1] + c[i - 1][1]) / 2 * (c[i][0] - c[i - 1][0]));
    c.forEach(function (p) { if (p[1] > peak) { peak = p[1]; peakT = p[0]; } });
    // burn time per NAR/TRA convention: from 5 % of peak thrust (rising) to 5 % (falling)
    var lim = 0.05 * peak, ts = 0, te = c[c.length - 1][0];
    for (i = 1; i < c.length; i++) if (c[i][1] >= lim) { ts = c[i - 1][0] + (lim - c[i - 1][1]) / ((c[i][1] - c[i - 1][1]) || 1) * (c[i][0] - c[i - 1][0]); break; }
    for (i = c.length - 1; i > 0; i--) if (c[i - 1][1] >= lim) { te = c[i - 1][0] + (c[i - 1][1] - lim) / ((c[i - 1][1] - c[i][1]) || 1) * (c[i][0] - c[i - 1][0]); break; }
    var I = cum[cum.length - 1], tb = te - ts, avg = tb > 0 ? I / tb : NaN, letter = classLetter(I);
    return Object.assign({}, m, {
      cum: cum, impulse: I, peak: peak, peakT: peakT, burnTime: tb, burnStart: ts, burnEnd: te, tEnd: c[c.length - 1][0], avg: avg,
      cls: letter, designation: letter + Math.round(avg), isp: m.propMass > 0 ? I / (m.propMass * G) : NaN
    });
  }
  function thrustAt(m, t) {
    var c = m.curve; if (t <= c[0][0] || t >= c[c.length - 1][0]) return 0;
    var lo = 0, hi = c.length - 1; while (hi - lo > 1) { var k = (lo + hi) >> 1; if (c[k][0] <= t) lo = k; else hi = k; }
    return c[lo][1] + (c[hi][1] - c[lo][1]) * (t - c[lo][0]) / (c[hi][0] - c[lo][0]);
  }
  function impulseAt(m, t) {
    var c = m.curve; if (t <= c[0][0]) return 0; if (t >= c[c.length - 1][0]) return m.cum[m.cum.length - 1];
    var lo = 0, hi = c.length - 1; while (hi - lo > 1) { var k = (lo + hi) >> 1; if (c[k][0] <= t) lo = k; else hi = k; }
    return m.cum[lo] + (c[lo][1] + thrustAt(m, t)) / 2 * (t - c[lo][0]);
  }

  /* ------------------------------------------------------------------ */
  /* Atmosphere (ISA lapse rate, anchored at the pad)                     */
  /* ------------------------------------------------------------------ */
  // env: {groundTempC, padAltitude (m ASL), padPressure (Pa, optional — measured)}
  function atmosphere(hAgl, env) {
    var T0 = (fin(env.groundTempC) ? env.groundTempC : 15) + 273.15, h = Math.max(-500, hAgl || 0);
    var p0 = env.padPressure > 0 ? env.padPressure : 101325 * Math.pow(1 - 2.25577e-5 * (env.padAltitude || 0), 5.25588);
    var T = T0 - LAPSE * h, p = p0 * Math.pow(T / T0, BARO_EXP);
    return { T: T, p: p, rho: p / (RAIR * T), a: Math.sqrt(GAMMA * RAIR * T) };
  }

  /* ------------------------------------------------------------------ */
  /* Flight simulation: 2D point mass, launch rail, zero angle of attack  */
  /* ------------------------------------------------------------------ */
  // rk: {liftoffMass kg (wet: on the pad with a full motor), diameter m, cd, railLength m, angleDeg (from vertical)}
  function simulate(m, rk, env) {
    var A = Math.PI * rk.diameter * rk.diameter / 4, cd = rk.cd, th = (rk.angleDeg || 0) * Math.PI / 180;
    var mL = rk.liftoffMass, mp = m.propMass > 0 ? m.propMass : 0, Itot = m.impulse;
    var dt = 0.002, t = 0, x = 0, z = 0, vx = 0, vz = 0, s = 0, vs = 0, onRail = true, lifted = false;
    var ux = Math.sin(th), uz = Math.cos(th);
    var S = { t: [], alt: [], v: [], vz: [], sf: [], thrust: [], mass: [], mach: [] };
    var r = { ok: false, maxV: 0, maxMach: 0, maxSf: -Infinity, notes: [] }, pastPeak = false;
    for (var step = 0; step < 600000; step++) {
      var T = thrustAt(m, t), mass = mL - mp * (Itot > 0 ? impulseAt(m, t) / Itot : 0);
      var at = atmosphere(z, env), V = onRail ? vs : Math.sqrt(vx * vx + vz * vz);
      var D = 0.5 * at.rho * V * V * cd * A, sf = (T - D) / mass;
      if (onRail) {
        var a = sf - G * uz;
        if (!lifted) { if (a > 0) { lifted = true; r.tLift = t; } else a = 0; }
        vs = Math.max(0, vs + a * dt); s += vs * dt;
        x = s * ux; z = s * uz; vx = vs * ux; vz = vs * uz;
        if (s >= rk.railLength) { onRail = false; r.railExitT = t; r.railExitV = vs; }
      } else {
        if (V > 1e-9) { ux = vx / V; uz = vz / V; }
        vx += sf * ux * dt; vz += (sf * uz - G) * dt; x += vx * dt; z += vz * dt;
      }
      if (lifted) {
        if (step % 5 === 0) { S.t.push(t); S.alt.push(z); S.v.push(V); S.vz.push(vz); S.sf.push(sf); S.thrust.push(T); S.mass.push(mass); S.mach.push(V / at.a); }
        if (V > r.maxV) { r.maxV = V; r.maxVT = t; }
        if (V / at.a > r.maxMach) r.maxMach = V / at.a;
        if (sf > r.maxSf) { r.maxSf = sf; r.maxSfT = t; }
        if (T >= 0.9 * m.peak) pastPeak = true;
        // same definition the board analysis uses: specific force drops below 1 g
        if (pastPeak && !fin(r.tBurn) && sf < G) { r.tBurn = t; r.burnAlt = z; r.burnV = V; }
        if (!fin(r.tMotorEnd) && t >= m.burnEnd) { r.tMotorEnd = t; r.motorEndAlt = z; r.motorEndV = V; }
        if (!onRail && vz <= 0 && t > m.tEnd) { r.tApo = t; r.apogee = z; r.range = x; r.ok = true; break; }
      } else if (t > m.tEnd) { r.notes.push('The motor never produces more thrust than the rocket\'s weight — the rocket would not leave the pad.'); return r; }
      t += dt;
    }
    if (!r.ok) { r.notes.push('Simulation did not reach apogee.'); return r; }
    if (!fin(r.railExitV)) r.notes.push('The rocket never left the rail.');
    r.liftoffTW = thrustAt(m, r.tLift + 0.05) / (mL * G);
    r.series = S;
    return r;
  }

  /* ------------------------------------------------------------------ */
  /* Thrust extracted from a flight log                                   */
  /* ------------------------------------------------------------------ */
  // Accelerometer reads specific force f = (T − D)/m along the body axis, so T = m·f + D.
  // d: {t (s, T+ from liftoff), f (specific force m/s², ≈ +g on the pad), v (vertical velocity m/s), alt (m AGL), tApo (T+)}
  // opts: {preLiftImpulse: N·s burnt on the pad before liftoff (from the nominal curve)}
  function smoothWin(t, y, a, b, win) {
    var n = b - a + 1, out = new Float64Array(n), ps = new Float64Array(n + 1), pc = new Float64Array(n + 1), j0 = 0, j1 = 0, i;
    for (i = 0; i < n; i++) { var v = y[a + i]; ps[i + 1] = ps[i] + (fin(v) ? v : 0); pc[i + 1] = pc[i] + (fin(v) ? 1 : 0); }
    for (i = 0; i < n; i++) {
      while (t[a + j0] < t[a + i] - win / 2) j0++;
      while (j1 < n - 1 && t[a + j1 + 1] <= t[a + i] + win / 2) j1++;
      var c = pc[j1 + 1] - pc[j0]; out[i] = c ? (ps[j1 + 1] - ps[j0]) / c : NaN;
    }
    return out;
  }
  function extractThrust(d, m, rk, env, opts) {
    opts = opts || {};
    var notes = [], t = d.t, A = Math.PI * rk.diameter * rk.diameter / 4, cosT = Math.cos((rk.angleDeg || 0) * Math.PI / 180);
    var mL = rk.liftoffMass, mp = m && m.propMass > 0 ? m.propMass : 0;
    // accelerometer scale check against 1 g on the pad
    var pad = [], p0 = idx(t, -5), p1 = idx(t, -0.5);
    for (var i = p0; i <= p1; i++) if (t[i] < -0.4) pad.push(d.f[i]);
    var padF = median(pad), k = 1;
    if (fin(padF) && padF > 0.85 * G && padF < 1.15 * G) { k = G / padF; if (Math.abs(k - 1) > 0.01) notes.push('Accelerometer read ' + (padF / G).toFixed(3) + ' g on the pad; scaled by ' + k.toFixed(3) + ' so the pad reads exactly 1 g.'); }
    else notes.push('Could not verify the accelerometer against 1 g on the pad (not enough pre-launch data) — no scale correction applied.');
    var tMax = Math.min(fin(d.tApo) ? d.tApo : 40, 40), a = idx(t, 0), b = idx(t, tMax);
    if (b - a < 10) return { ok: false, notes: ['Not enough samples after liftoff.'] };
    var dtMed = median(Array.prototype.slice.call(t, a + 1, Math.min(b, a + 400)).map(function (x, j) { return x - t[a + j]; }));
    var fs = smoothWin(t, d.f, a, b, Math.max(0.04, 3 * dtMed)), n = fs.length, tt = new Float64Array(n), V = new Float64Array(n), rho = new Float64Array(n);
    for (i = 0; i < n; i++) {
      fs[i] *= k; tt[i] = t[a + i];
      var vv = d.v ? d.v[a + i] : NaN; V[i] = fin(vv) ? Math.max(0, vv / cosT) : NaN;
      rho[i] = atmosphere(d.alt && fin(d.alt[a + i]) ? d.alt[a + i] : 0, env).rho;
    }
    var pre = opts.preLiftImpulse > 0 ? opts.preLiftImpulse : 0;
    function pass(Iref) {
      var T = new Float64Array(n), cum = pre;
      for (var j = 0; j < n; j++) {
        var mass = mL - mp * Math.min(1, cum / Iref); // propellant burns in proportion to impulse delivered (incl. on the pad)
        var D = fin(V[j]) ? 0.5 * rho[j] * V[j] * V[j] * rk.cd * A : 0;
        T[j] = mass * fs[j] + D;
        if (j) cum += Math.max(0, (T[j] + T[j - 1]) / 2) * (tt[j] - tt[j - 1]);
      }
      var pk = 0; for (j = 1; j < n; j++) if (T[j] > T[pk]) pk = j;
      var lim = 0.05 * T[pk], end = n - 1;
      for (j = pk; j < n; j++) if (T[j] < lim) { var e = idx(tt, tt[j] + 0.2), ok = true; for (var q = j; q <= e; q++) if (T[q] >= lim) { ok = false; break; } if (ok) { end = j; break; } }
      var I = 0; for (j = 1; j <= end; j++) I += Math.max(0, (T[j] + T[j - 1]) / 2) * (tt[j] - tt[j - 1]);
      return { T: T, pk: pk, end: end, I: I };
    }
    var p = pass(m && m.impulse > 0 ? m.impulse : 1e12);
    if (p.I > 0) p = pass(p.I + pre);
    if (p.end >= n - 1) notes.push('Thrust never fell below 5 % of its peak before apogee — check the accelerometer axis and the rocket mass.');
    var res = { ok: true, i0: a, t: tt, thrust: p.T, calib: k, impulse: p.I, impulseTotal: p.I + pre, preLiftImpulse: pre, peak: p.T[p.pk], peakT: tt[p.pk], burnEnd: tt[p.end],
      avg: tt[p.end] > 0 ? p.I / tt[p.end] : NaN, notes: notes, hasVel: V.some(fin) };
    if (!res.hasVel) notes.push('No velocity estimate on this board — drag was left out, so thrust is slightly underestimated.');
    // drag coefficient from the coast: f = −D/m with the motor burnt out
    var mBo = mL - mp, cds = [], machs = [], vBo = fin(V[p.end]) ? V[p.end] : NaN;
    var c0 = idx(tt, tt[p.end] + 0.5), c1 = idx(tt, (fin(d.tApo) ? d.tApo : tt[n - 1]) - 1);
    for (i = c0; i <= c1; i++) {
      if (!(V[i] > Math.max(30, 0.25 * (vBo || 0))) || !(fs[i] < 0)) continue;
      cds.push(-2 * mBo * fs[i] / (rho[i] * V[i] * V[i] * A));
      machs.push(V[i] / atmosphere(d.alt && fin(d.alt[a + i]) ? d.alt[a + i] : 0, env).a);
    }
    if (cds.length >= 10) { res.cd = median(cds); res.cdN = cds.length; res.cdMach = [Math.min.apply(null, machs), Math.max.apply(null, machs)]; }
    return res;
  }

  return { G: G, parseEng: parseEng, parseRse: parseRse, parseThrustTable: parseThrustTable, parseMotorFile: parseMotorFile, manualMotor: manualMotor,
    prepare: prepare, classLetter: classLetter, thrustAt: thrustAt, impulseAt: impulseAt, atmosphere: atmosphere, simulate: simulate, extractThrust: extractThrust };
})();
if (typeof module !== 'undefined') module.exports = MOTOR;
