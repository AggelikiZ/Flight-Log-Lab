/* RocketLog core: parsing, column detection and flight analysis.
   Pure functions, no DOM. Works in browser and in node (via vm). */
var RL = (function () {
  'use strict';
  var G = 9.80665;

  /* ------------------------------------------------------------------ */
  /* CSV parsing                                                         */
  /* ------------------------------------------------------------------ */
  function detectDelimiter(line) {
    var c = { ',': 0, ';': 0, '\t': 0, '|': 0 };
    for (var i = 0; i < line.length; i++) if (c[line[i]] !== undefined) c[line[i]]++;
    var best = ',', n = 0;
    for (var k in c) if (c[k] > n) { n = c[k]; best = k; }
    return best;
  }
  function splitLine(line, d) {
    if (line.indexOf('"') < 0) return line.split(d);
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === d && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  function isNumLike(s) { return s !== '' && !isNaN(+s); }

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var lines = text.split(/\r?\n/);
    // skip comment / blank / preamble lines: header is first line whose next line has same field count & numeric content
    var start = 0;
    while (start < lines.length && (lines[start].trim() === '' || /^\s*(#|\/\/)/.test(lines[start]))) start++;
    var d = detectDelimiter(lines[start] || '');
    var first = splitLine(lines[start], d).map(function (s) { return s.trim(); });
    var hasHeader = first.some(function (s) { return s !== '' && !isNumLike(s); });
    var names, dataStart;
    if (hasHeader) { names = first; dataStart = start + 1; }
    else { names = first.map(function (_, i) { return 'col' + (i + 1); }); dataStart = start; }
    names = names.map(function (n, i) { return n.replace(/^"|"$/g, '') || ('col' + (i + 1)); });
    // dedupe
    var seen = {};
    names = names.map(function (n) { if (seen[n]) { seen[n]++; return n + '_' + seen[n]; } seen[n] = 1; return n; });
    var nc = names.length, nrows = 0;
    var cap = lines.length - dataStart;
    var num = names.map(function () { return new Float64Array(cap); });
    var str = names.map(function () { return null; });
    for (var li = dataStart; li < lines.length; li++) {
      var L = lines[li];
      if (!L || L.trim() === '' || L[0] === '#') continue;
      var f = splitLine(L, d);
      if (f.length < nc * 0.5) continue;
      for (var j = 0; j < nc; j++) {
        var s = f[j];
        if (s === undefined) { num[j][nrows] = NaN; continue; }
        s = s.trim();
        var v = s === '' ? NaN : +s;
        if (v !== v && s !== '' && s.toLowerCase() !== 'nan') {
          if (!str[j]) str[j] = new Array(cap);
          str[j][nrows] = s.replace(/^"|"$/g, '');
        }
        num[j][nrows] = v;
      }
      nrows++;
    }
    var cols = names.map(function (n, j) {
      var arr = num[j].subarray(0, nrows);
      var col = { name: n, data: arr };
      if (str[j]) {
        var nn = 0; for (var i = 0; i < nrows; i++) if (arr[i] === arr[i]) nn++;
        var ns = 0; for (i = 0; i < nrows; i++) if (str[j][i] !== undefined) ns++;
        if (ns > nn) { // text column
          var s2 = new Array(nrows);
          for (i = 0; i < nrows; i++) s2[i] = str[j][i] !== undefined ? str[j][i] : (arr[i] === arr[i] ? String(arr[i]) : '');
          col.text = s2; col.data = null;
        }
      }
      return col;
    });
    return { columns: cols, rows: nrows };
  }

  /* ------------------------------------------------------------------ */
  /* CATS Vega / CATS flight computer binary log (.cfl)                  */
  /* ------------------------------------------------------------------ */
  var CATS_STATES = { 0: 'Invalid', 1: 'Calibrating', 2: 'Ready', 3: 'Thrusting', 4: 'Coasting', 5: 'Drogue', 6: 'Main', 7: 'Touchdown' };
  var CATS_EVENTS = { 0: 'Moving', 1: 'Ready', 2: 'Liftoff', 3: 'Max V / burnout', 4: 'Apogee', 5: 'Main deployment', 6: 'Touchdown', 7: 'Custom 1', 8: 'Custom 2' };
  var CATS_ACTIONS = { 0: 'none', 1: 'delay', 2: 'pyro 1', 3: 'pyro 2', 4: 'pyro 3', 5: 'low-current 1', 6: 'low-current 2', 7: 'low-current 3', 8: 'servo 1', 9: 'servo 2' };
  var CATS_SZ = { 0x10: 12, 0x20: 8, 0x40: 12, 0x80: 8, 0x100: 8, 0x200: 4, 0x400: 8, 0x800: 4, 0x1000: 12, 0x2000: 2 };

  function looksLikeCATS(buf) {
    var u = new Uint8Array(buf, 0, Math.min(64, buf.byteLength));
    var z = -1;
    for (var i = 0; i < Math.min(16, u.length); i++) if (u[i] === 0) { z = i; break; }
    if (z < 3) return false;
    var s = String.fromCharCode.apply(null, Array.prototype.slice.call(u, 0, z));
    if (!/^\d+\.\d+\.\d+/.test(s)) return false;
    if (buf.byteLength < z + 9) return false;
    var dv = new DataView(buf);
    var typ = dv.getUint32(z + 5, true) & ~0xF;
    return CATS_SZ[typ] !== undefined;
  }

  function parseCATS(buf) {
    var dv = new DataView(buf), u = new Uint8Array(buf), n = buf.byteLength;
    var z = 0; while (z < n && u[z] !== 0) z++;
    var version = String.fromCharCode.apply(null, Array.prototype.slice.call(u, 0, z));
    var i = z + 1, last = null, skipped = 0;
    var rec = {}; // key -> {t:[], vals:[[]...]}
    function push(key, t, vals) {
      var r = rec[key]; if (!r) { r = rec[key] = { t: [], v: vals.map(function () { return []; }) }; }
      r.t.push(t); for (var k = 0; k < vals.length; k++) r.v[k].push(vals[k]);
    }
    var events = [];
    while (i + 8 <= n) {
      var ts = dv.getUint32(i, true), typ = dv.getUint32(i + 4, true), base = typ & ~0xF, id = typ & 0xF;
      var sz = CATS_SZ[base];
      if (sz === undefined || id > 3 || i + 8 + sz > n || (last !== null && (ts - last < -5000 || ts - last > 60000))) { i++; skipped++; continue; }
      var p = i + 8; last = ts;
      switch (base) {
        case 0x10: push('imu' + id, ts, [dv.getInt16(p, true), dv.getInt16(p + 2, true), dv.getInt16(p + 4, true), dv.getInt16(p + 6, true), dv.getInt16(p + 8, true), dv.getInt16(p + 10, true)]); break;
        case 0x20: push('baro' + id, ts, [dv.getInt32(p, true), dv.getInt32(p + 4, true)]); break;
        case 0x40: push('fi', ts, [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)]); break;
        case 0x80: push('ori', ts, [dv.getInt16(p, true), dv.getInt16(p + 2, true), dv.getInt16(p + 4, true), dv.getInt16(p + 6, true)]); break;
        case 0x100: push('filt', ts, [dv.getFloat32(p, true), dv.getFloat32(p + 4, true)]); break;
        case 0x200: events.push({ ts: ts, kind: 'state', code: dv.getUint32(p, true) }); break;
        case 0x400: events.push({ ts: ts, kind: 'event', code: dv.getUint32(p, true), action: dv.getUint16(p + 4, true), arg: dv.getUint16(p + 6, true) }); break;
        case 0x800: events.push({ ts: ts, kind: 'error', code: dv.getUint32(p, true) }); break;
        case 0x1000: push('gnss', ts, [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getUint8(p + 8)]); break;
        case 0x2000: push('volt', ts, [dv.getUint16(p, true)]); break;
      }
      i = p + sz;
    }
    // Build a single table on the flight-info timeline, other streams interpolated (nearest) onto it
    var baseKey = rec.fi ? 'fi' : Object.keys(rec)[0];
    var T = rec[baseKey].t, N = T.length;
    var cols = [{ name: 'time_ms', data: Float64Array.from(T) }];
    function addStream(key, names, scale, opts) {
      var r = rec[key]; if (!r) return;
      var j = 0;
      var arrs = names.map(function () { return new Float64Array(N); });
      for (var k = 0; k < N; k++) {
        while (j + 1 < r.t.length && Math.abs(r.t[j + 1] - T[k]) <= Math.abs(r.t[j] - T[k])) j++;
        var ok = Math.abs(r.t[j] - T[k]) <= ((opts && opts.hold) || 60);
        for (var q = 0; q < names.length; q++) arrs[q][k] = ok ? r.v[q][j] * scale[q] : NaN;
      }
      names.forEach(function (nm, q) { cols.push({ name: nm, data: arrs[q] }); });
    }
    addStream('fi', ['kf_height_m', 'kf_velocity_mps', 'kf_accel_mps2'], [1, 1, 1]);
    addStream('filt', ['filtered_alt_agl_m', 'filtered_accel_mps2'], [1, 1]);
    for (var b = 0; b < 4; b++) addStream('baro' + b, ['baro' + b + '_pressure_pa', 'baro' + b + '_temp_c'], [1, 0.01]);
    for (b = 0; b < 4; b++) addStream('imu' + b, ['imu' + b + '_ax_g', 'imu' + b + '_ay_g', 'imu' + b + '_az_g', 'imu' + b + '_gx_dps', 'imu' + b + '_gy_dps', 'imu' + b + '_gz_dps'], [1 / 1024, 1 / 1024, 1 / 1024, 1 / 16.4, 1 / 16.4, 1 / 16.4]);
    addStream('ori', ['quat_w', 'quat_x', 'quat_y', 'quat_z'], [1e-4, 1e-4, 1e-4, 1e-4]);
    addStream('gnss', ['gnss_lat', 'gnss_lon', 'gnss_sats'], [1, 1, 1], { hold: 1500 });
    addStream('volt', ['battery_v'], [0.001], { hold: 1500 });
    // state column (step function)
    var st = new Float64Array(N), cur = NaN, si = 0;
    var states = events.filter(function (e) { return e.kind === 'state'; });
    for (var k = 0; k < N; k++) { while (si < states.length && states[si].ts <= T[k]) { cur = states[si].code; si++; } st[k] = cur; }
    if (states.length) cols.push({ name: 'flight_state', data: st });
    var evs = events.map(function (e) {
      var label;
      if (e.kind === 'state') label = 'State → ' + (CATS_STATES[e.code] || e.code);
      else if (e.kind === 'event') {
        var a = CATS_ACTIONS[e.action] || ('action ' + e.action);
        label = (CATS_EVENTS[e.code] || ('Event ' + e.code)) + (e.action ? ' · ' + (e.action === 1 ? 'delay ' + e.arg + ' ms' : e.action <= 3 ? a + (e.arg ? ' ON' : ' OFF') : 'action ' + e.action + ' (arg ' + e.arg + ')') : '');
      } else label = 'Error ' + e.code;
      return { t: e.ts / 1000, label: label, kind: e.kind, code: e.code, action: e.action, arg: e.arg };
    });
    return { columns: cols, rows: N, version: version, events: evs, skippedBytes: skipped, stateNames: CATS_STATES };
  }

  /* ------------------------------------------------------------------ */
  /* Column role detection                                               */
  /* ------------------------------------------------------------------ */
  var ROLES = {
    time: { label: 'Time', units: ['s', 'ms', 'us'] },
    flight_time: { label: 'Time since liftoff', units: ['s', 'ms', 'us'] },
    altitude: { label: 'Altitude', units: ['m', 'ft'] },
    velocity: { label: 'Vertical velocity', units: ['m/s', 'ft/s'] },
    accel_vertical: { label: 'Vertical acceleration', units: ['m/s²', 'g'] },
    accel_x: { label: 'Accel X', units: ['m/s²', 'g'] },
    accel_y: { label: 'Accel Y', units: ['m/s²', 'g'] },
    accel_z: { label: 'Accel Z', units: ['m/s²', 'g'] },
    gyro_x: { label: 'Gyro X', units: ['°/s', 'rad/s'] },
    gyro_y: { label: 'Gyro Y', units: ['°/s', 'rad/s'] },
    gyro_z: { label: 'Gyro Z', units: ['°/s', 'rad/s'] },
    pressure: { label: 'Pressure', units: ['Pa', 'hPa', 'kPa'] },
    temperature: { label: 'Temperature', units: ['°C', 'K', '°F'] },
    humidity: { label: 'Humidity', units: ['%'] },
    lat: { label: 'Latitude', units: ['deg', 'deg×1e7'] },
    lon: { label: 'Longitude', units: ['deg', 'deg×1e7'] },
    gps_alt: { label: 'GPS altitude', units: ['m', 'ft'] },
    sats: { label: 'GPS satellites', units: [''] },
    state: { label: 'Flight state', units: [''] },
    event: { label: 'Event name', units: [''] },
    voltage: { label: 'Battery voltage', units: ['V', 'mV'] },
    quat: { label: 'Orientation quaternion', units: [''] },
    output: { label: 'Pyro / output channel', units: [''] },
    control: { label: 'Control / airbrake cmd', units: [''] },
    flag: { label: 'Status / fault flag', units: [''] },
    counter: { label: 'Packet counter', units: [''] },
    velocity_h: { label: 'Horizontal velocity', units: ['m/s'] },
    accel_h: { label: 'Horizontal accel', units: ['m/s²', 'g'] },
    other: { label: 'Other (plot only)', units: [''] },
    ignore: { label: 'Ignore', units: [''] }
  };

  function norm(n) { return String(n).toLowerCase().replace(/\[.*?\]|\(.*?\)/g, function (m) { return '_' + m.slice(1, -1) + '_'; }).replace(/[^a-z0-9%²]+/g, '_').replace(/^_|_$/g, ''); }

  // name rule table: [regex, role, extra]
  var NAME_RULES = [
    [/^(flight_time|time_since_liftoff|t_flight|t_since_launch|since_liftoff|met|t_plus)(_|$)/, 'flight_time'],
    [/(since_apogee|since_)/, 'other'],
    [/^(t|ts|time|timestamp|tick|ticks|millis|micros|t_us|t_ms|t_s|time_us|time_ms|time_s|timestamp_ms|timestamp_us|timestamp_s|uptime|clock|elapsed)(_|$)/, 'time'],
    [/^(packet|pkt|seq|sequence|counter|cnt|frame|idx|index|msg_id|sample)(_|$)/, 'counter'],
    [/(gps|gnss)_?(alt|altitude|height|msl)/, 'gps_alt'],
    [/^(alt_msl|msl)$/, 'gps_alt'],
    [/(^|_)(lat|latitude)(_|$)/, 'lat'],
    [/(^|_)(lon|lng|long|longitude)(_|$)/, 'lon'],
    [/(^|_)(siv|sats|sat|satellites|numsv|num_sv|nsat|fix_sats)(_|$)/, 'sats'],
    [/(press|pressure|baro_p|pres)(_|$|[a-z])/, 'pressure'],
    [/^p(_pa|_hpa|_kpa)?$/, 'pressure'],
    [/(^|_)(temp|temperature|tmp)(_|$|\d)|^(t_c|t_degc|temp)/, 'temperature'],
    [/(^|_)(hum|humidity|rh)(_|$|_pct|%)/, 'humidity'],
    [/(vbat|v_bat|batt|battery|voltage|vin|v_in|vsys)/, 'voltage'],
    [/(^|_)(q[0-3wxyz]|quat|quaternion)(_|$)/, 'quat'],
    [/(a_vert|acc_vert|accel_vert|a_vertical|acc_vertical|accel_vertical|vert_acc|a_up|acc_up|vertical_acc)/, 'accel_vertical'],
    [/^(ax|ay|az|accx|accy|accz)_(earth|world|ned|enu)$|^(acc|accel|a)_(earth|world)_?[xyz]$/, 'accel_earth'],
    [/(^|_)(acc|accel|acceleration|a|imu\d?_a|imu_acc|high_g|hg_a|lsm_a|bmi_a|icm_a)_?([xyz])(_|$)/, 'accel_axis'],
    [/(^|_)a([xyz])(_|$)/, 'accel_axis'],
    [/(^|_)(gyro|gyr|rate|w|omega|imu\d?_g|g)_?([xyz])(_|$)/, 'gyro_axis'],
    [/(^|_)(acc|accel|acceleration)(_|$)/, 'accel_vertical'],
    [/^(v|vel|velocity|vz|v_z|v_vert|vertical_velocity|vspeed|v_up|speed_vert|kf_velocity|kf_v|vel_z)(_|$)/, 'velocity'],
    [/(^|_)v([xy])(_|$)|^vel_[xy]$/, 'velocity_h'],
    [/(velocity|_vel$|^vel_)/, 'velocity'],
    [/^(h|alt|altitude|height|agl|baro_alt|alt_agl|kf_alt|kf_height|est_alt|filtered_alt|h_agl|z)(_|$)/, 'altitude'],
    [/(altitude|height|_alt_|_alt$|^alt)/, 'altitude'],
    [/^(fsm|state|phase|flight_state|flight_phase|stage|mode|status_state|fsm_state)(_|$)/, 'state'],
    [/^(event|evt|events|message|msg|log|note|event_name)(_|$)/, 'event'],
    [/(_on$|^pyro|_fire|ignit|^drogue|^main_|_deploy|^magnet|^retain|^chute|servo_en|_armed$|^arm)/, 'output'],
    [/(ctrl|control|cmd|command|airbrake|brake|servo|actuator|^u$|_u$|duty|throttle)/, 'control'],
    [/(_ok$|^ok_|fault|error|err$|^err|status|health|valid|active_|_active$|flags?$|warn)/, 'flag']
  ];

  function unitHint(nn) {
    var m;
    if (/(^|_)(us|usec|micros|µs)(_|$)/.test(nn) || /micros/.test(nn)) return 'us';
    if (/(^|_)(ms|msec|millis)(_|$)/.test(nn) || /millis/.test(nn)) return 'ms';
    if (/(^|_)(s|sec|secs|seconds)(_|$)/.test(nn)) return 's';
    if (/(^|_)(ft|feet)(_|$)/.test(nn)) return 'ft';
    if (/(^|_)(hpa|mbar)(_|$)/.test(nn)) return 'hPa';
    if (/(^|_)kpa(_|$)/.test(nn)) return 'kPa';
    if (/(^|_)pa(_|$)/.test(nn)) return 'Pa';
    if (/(^|_)(g|gs)(_|$)/.test(nn)) return 'g';
    if (/(^|_)(mps2|ms2|m_s2|m_s²|mss)(_|$)/.test(nn)) return 'm/s²';
    if (/(^|_)(dps|deg_s)(_|$)/.test(nn)) return '°/s';
    if (/(^|_)(rads|rad_s)(_|$)/.test(nn)) return 'rad/s';
    if (/(^|_)mv(_|$)/.test(nn)) return 'mV';
    if (/(^|_)(degf|f)(_|$)/.test(nn)) return '°F';
    if (/(^|_)(k|kelvin)(_|$)/.test(nn)) return 'K';
    return m;
  }

  function stats(a) {
    var n = 0, mn = Infinity, mx = -Infinity, s = 0, inc = 0, dec = 0, prev = NaN, ints = true;
    var uniq = new Set();
    for (var i = 0; i < a.length; i++) {
      var v = a[i]; if (v !== v) continue;
      n++; s += v; if (v < mn) mn = v; if (v > mx) mx = v;
      if (prev === prev) { if (v > prev) inc++; else if (v < prev) dec++; }
      prev = v;
      if (ints && v !== Math.round(v)) ints = false;
      if (uniq.size <= 50) uniq.add(v);
    }
    return { n: n, min: mn, max: mx, mean: n ? s / n : NaN, inc: inc, dec: dec, ints: ints, uniq: uniq.size > 50 ? 51 : uniq.size, uniqVals: uniq.size <= 50 ? Array.from(uniq).sort(function (a, b) { return a - b; }) : null };
  }
  function median(a) {
    var b = []; for (var i = 0; i < a.length; i++) if (a[i] === a[i]) b.push(a[i]);
    if (!b.length) return NaN; b.sort(function (x, y) { return x - y; }); return b[b.length >> 1];
  }
  function medianDiff(a) {
    var step = Math.max(1, Math.floor(a.length / 5000)), d = [];
    for (var i = step; i < a.length; i += step) { var x = a[i] - a[i - 1]; if (x === x) d.push(x); }
    return median(d);
  }

  function detectColumns(table, fileName) {
    var cols = table.columns, res = {};
    var timeFound = false;
    cols.forEach(function (c) {
      var nn = norm(c.name), r = { role: 'other', unit: '', reason: '', conf: 'low' };
      if (!c.data) {
        r.role = /event|evt|msg|message|state|log/.test(nn) ? 'event' : 'event';
        r.reason = 'text column'; r.conf = 'high';
        res[c.name] = r; return;
      }
      var st = c.stats = stats(c.data);
      var hint = unitHint(nn);
      var role = null, axis = null, matched = null;
      for (var k = 0; k < NAME_RULES.length; k++) {
        var m = NAME_RULES[k][0].exec(nn);
        if (m) { role = NAME_RULES[k][1]; matched = m; break; }
      }
      if (role === 'accel_axis') { axis = (nn.match(/([xyz])(?=_|$)(?!.*[xyz](_|$))/) || [])[1] || (nn.match(/[xyz]/) || ['x'])[0]; role = 'accel_' + axis; }
      if (role === 'gyro_axis') { axis = (nn.match(/([xyz])(?=_|$)(?!.*[xyz](_|$))/) || [])[1] || 'x'; role = 'gyro_' + axis; }
      if (role === 'accel_earth') {
        var ax2 = (nn.match(/[xyz]/) || ['z'])[0];
        role = ax2 === 'z' ? 'accel_vertical' : 'accel_h';
        r.frame = 'earth';
      }
      if (role) { r.reason = 'name'; r.conf = 'high'; }

      // ambiguous: "baro" / unknown: decide by values
      if (!role || nn === 'baro' || nn === 'bar') {
        if (st.min > 20000 && st.max < 120000) { role = 'pressure'; r.reason = 'values look like pressure in Pa'; r.conf = 'med'; }
        else if (nn === 'baro' || nn === 'bar') { role = 'altitude'; r.reason = '"baro" with altitude-like values'; r.conf = 'med'; }
      }
      // value-based guesses for unnamed columns
      if (!role) {
        if (!timeFound && st.inc > 0.98 * (st.n - 1) && st.uniq > 50) { role = 'time'; r.reason = 'monotonic values'; r.conf = 'med'; }
        else if (st.uniqVals && st.uniq <= 2 && st.min >= 0 && st.max <= 1) { role = 'flag'; r.reason = '0/1 values'; r.conf = 'low'; }
        else if (st.uniqVals && st.ints && st.uniq <= 12 && st.min >= 0) { role = 'state'; r.reason = 'few integer values'; r.conf = 'low'; }
        else { role = 'other'; r.reason = 'not recognised'; r.conf = 'low'; }
      }
      // conflicts: second time column
      if (role === 'time') { if (timeFound) { role = 'other'; r.reason = 'second time column'; } else timeFound = true; }
      // state that is binary -> flag
      if (role === 'state' && st.uniqVals && st.uniq <= 2 && st.max <= 1) role = 'flag';
      if (role === 'output' && !(st.uniqVals && st.uniq <= 3)) role = 'control';
      if (role === 'velocity' && /^(vx|vy|v_x|v_y)$/.test(nn)) role = 'velocity_h';
      if ((role === 'accel_x' || role === 'accel_y') && cols.some(function (o) { return /^(vx|vy)$/.test(norm(o.name)); }) && !cols.some(function (o) { return /^az$/.test(norm(o.name)); })) {
        role = 'accel_h'; r.reason = 'horizontal (paired with vx/vy)';
      }
      r.role = role;

      // units
      var md = 0;
      if (role === 'time' || role === 'flight_time') {
        md = medianDiff(c.data);
        r.unit = hint && ['s', 'ms', 'us'].indexOf(hint) >= 0 ? hint : (md >= 400 ? 'us' : md >= 0.5 ? 'ms' : 's');
        if (!hint) r.reason += ' · unit from sample spacing';
      } else if (role === 'altitude' || role === 'gps_alt') r.unit = hint === 'ft' ? 'ft' : 'm';
      else if (role === 'velocity' || role === 'velocity_h') r.unit = /ft/.test(nn) ? 'ft/s' : 'm/s';
      else if (role === 'pressure') r.unit = hint && /pa/i.test(hint) ? hint : (st.mean > 20000 ? 'Pa' : st.mean > 200 ? 'hPa' : 'kPa');
      else if (role === 'temperature') r.unit = hint === 'K' || st.mean > 200 ? 'K' : hint === '°F' ? '°F' : '°C';
      else if (role === 'voltage') r.unit = hint === 'mV' || st.max > 100 ? 'mV' : 'V';
      else if (/^gyro/.test(role)) r.unit = hint === 'rad/s' ? 'rad/s' : '°/s';
      else if (/^accel/.test(role)) r.unit = hint === 'g' ? 'g' : hint === 'm/s²' ? 'm/s²' : null; // decided later with rest analysis
      else if (role === 'humidity') r.unit = '%';
      res[c.name] = r;
    });
    // lat/lon scaling (decided jointly)
    var latC = cols.find(function (c) { return res[c.name].role === 'lat'; });
    var lonC = cols.find(function (c) { return res[c.name].role === 'lon'; });
    if (latC && latC.stats) {
      var scale = 1, ml = Math.max(Math.abs(latC.stats.min), Math.abs(latC.stats.max));
      var mo = lonC && lonC.stats ? Math.max(Math.abs(lonC.stats.min), Math.abs(lonC.stats.max)) : 0;
      [1, 1e5, 1e6, 1e7].some(function (s) { if (ml / s <= 90 && mo / s <= 180) { scale = s; return true; } return false; });
      var u = scale === 1 ? 'deg' : 'deg×1e' + Math.round(Math.log10(scale));
      res[latC.name].unit = u; if (lonC) res[lonC.name].unit = u;
      if (scale !== 1) { res[latC.name].reason += ' · integer degrees×' + scale.toExponential(0); }
    }
    // accelerometer unit & gravity. Body-axis triplets: gravity shows up in the vector magnitude whatever the orientation.
    var accCols = cols.filter(function (c) { return c.data && /^accel_[xyz]$/.test(res[c.name].role); });
    var groups = {};
    accCols.forEach(function (c) { var key = norm(c.name).replace(/[xyz](?=_[a-z0-9]*$|$)/, '#'); (groups[key] = groups[key] || []).push(c); });
    var tripletUnit = null;
    Object.keys(groups).forEach(function (key) {
      var g = groups[key]; if (g.length < 2) return;
      var n = g[0].data.length, step = Math.max(1, Math.floor(n / 20000)), mags = [];
      for (var i = 0; i < n; i += step) { var s2 = 0; for (var q = 0; q < g.length; q++) s2 += g[q].data[i] * g[q].data[i]; mags.push(Math.sqrt(s2)); }
      var mm = median(mags), u = Math.abs(mm - 1) < 0.3 ? 'g' : Math.abs(mm - G) < 3 ? 'm/s²' : null;
      g.forEach(function (c) {
        var r = res[c.name]; if (!r.unit) r.unit = u || 'm/s²';
        r.gravity = u ? 'included' : 'unknown'; r.restValue = median(c.data);
        r.reason += u ? ' · |a| at rest ≈ 1 g' : '';
      });
      if (u) tripletUnit = u;
    });
    cols.forEach(function (c) {
      var r = res[c.name];
      if (!/^accel/.test(r.role) || !c.data || r.gravity) return;
      var restMed = median(c.data);
      if (!r.unit) {
        if (Math.abs(Math.abs(restMed) - G) < 1.5) r.unit = 'm/s²';
        else if (Math.abs(Math.abs(restMed) - 1) < 0.15 && c.stats.max < 40) r.unit = 'g';
        else r.unit = tripletUnit || 'm/s²';
      }
      var gv = r.unit === 'g' ? 1 : G;
      r.restValue = restMed;
      r.gravity = Math.abs(Math.abs(restMed) - gv) < 0.25 * gv ? 'included' : 'removed';
    });
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* Unit conversion                                                     */
  /* ------------------------------------------------------------------ */
  function toSI(role, unit, arr) {
    var f = 1, off = 0;
    switch (unit) {
      case 'ms': f = 1e-3; break; case 'us': f = 1e-6; break;
      case 'ft': f = 0.3048; break; case 'ft/s': f = 0.3048; break;
      case 'g': f = G; break;
      case 'rad/s': f = 180 / Math.PI; break;
      case 'hPa': f = 100; break; case 'kPa': f = 1000; break;
      case 'K': off = -273.15; break;
      case 'mV': f = 1e-3; break;
      case 'deg×1e5': f = 1e-5; break; case 'deg×1e6': f = 1e-6; break; case 'deg×1e7': f = 1e-7; break;
    }
    if (unit === '°F') { var o = new Float64Array(arr.length); for (var i = 0; i < arr.length; i++) o[i] = (arr[i] - 32) * 5 / 9; return o; }
    if (f === 1 && off === 0) return arr;
    var out = new Float64Array(arr.length);
    for (var j = 0; j < arr.length; j++) out[j] = arr[j] * f + off;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Signal helpers                                                      */
  /* ------------------------------------------------------------------ */
  function idxAtTime(t, x) { // first index with t>=x (binary search)
    var lo = 0, hi = t.length - 1; if (x <= t[0]) return 0; if (x > t[hi]) return hi;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (t[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function valueAt(t, y, x) { var i = idxAtTime(t, x); if (i > 0 && Math.abs(t[i - 1] - x) < Math.abs(t[i] - x)) i--; return y[i]; }
  function smoothTime(t, y, win) { // centered moving average by time window (seconds), NaN-aware
    var n = y.length, out = new Float64Array(n), s = 0, c = 0, lo = 0, hi = -1, h = win / 2;
    for (var i = 0; i < n; i++) {
      while (hi + 1 < n && t[hi + 1] <= t[i] + h) { hi++; if (y[hi] === y[hi]) { s += y[hi]; c++; } }
      while (t[lo] < t[i] - h) { if (y[lo] === y[lo]) { s -= y[lo]; c--; } lo++; }
      out[i] = c ? s / c : NaN;
    }
    return out;
  }
  function medianFilter(y, k) {
    var n = y.length, out = new Float64Array(n), w = [], h = k >> 1;
    for (var i = 0; i < n; i++) {
      w.length = 0;
      for (var j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) if (y[j] === y[j]) w.push(y[j]);
      w.sort(function (a, b) { return a - b; });
      out[i] = w.length ? w[w.length >> 1] : NaN;
    }
    return out;
  }
  function derivative(t, y, win) { // slope over +-win/2 window
    var n = y.length, out = new Float64Array(n), lo = 0, hi = 0, h = win / 2;
    for (var i = 0; i < n; i++) {
      while (lo < i && t[lo] < t[i] - h) lo++;
      while (hi < n - 1 && t[hi + 1] <= t[i] + h) hi++;
      var dt = t[hi] - t[lo];
      out[i] = dt > 0 ? (y[hi] - y[lo]) / dt : NaN;
    }
    return out;
  }
  function pressureToAlt(p, p0) {
    var out = new Float64Array(p.length);
    for (var i = 0; i < p.length; i++) out[i] = p[i] > 0 ? 44330.77 * (1 - Math.pow(p[i] / p0, 0.190263)) : NaN;
    return out;
  }
  function rangeMedian(t, y, t0, t1) { var a = idxAtTime(t, t0), b = idxAtTime(t, t1); return median(y.subarray ? y.subarray(a, b + 1) : y.slice(a, b + 1)); }
  function haversine(la1, lo1, la2, lo2) {
    var R = 6371000, r = Math.PI / 180, dla = (la2 - la1) * r, dlo = (lo2 - lo1) * r;
    var a = Math.sin(dla / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dlo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function bearing(la1, lo1, la2, lo2) {
    var r = Math.PI / 180, y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
    var x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }
  function speedOfSound(hAGL, groundTempC) { var T = groundTempC + 273.15 - 0.0065 * Math.max(0, hAGL); return Math.sqrt(1.4 * 287.05 * T); }

  /* ------------------------------------------------------------------ */
  /* Build a "source": convert mapped columns to SI channels             */
  /* ------------------------------------------------------------------ */
  function buildChannels(table, mapping) {
    var ch = { byRole: {}, list: [] };
    var timeCol = table.columns.find(function (c) { return mapping[c.name] && mapping[c.name].role === 'time'; });
    var ftCol = table.columns.find(function (c) { return mapping[c.name] && mapping[c.name].role === 'flight_time'; });
    var tc = timeCol || ftCol;
    var t;
    if (tc) t = toSI('time', mapping[tc.name].unit, tc.data);
    else { t = new Float64Array(table.rows); for (var i = 0; i < t.length; i++) t[i] = i; }
    // ensure time is a Float64Array copy and fix NaNs by forward fill
    t = Float64Array.from(t);
    for (i = 1; i < t.length; i++) if (!(t[i] === t[i])) t[i] = t[i - 1];
    ch.t = t; ch.timeName = tc ? tc.name : '(row index)'; ch.timeIsFlight = !timeCol && !!ftCol;
    table.columns.forEach(function (c) {
      var m = mapping[c.name]; if (!m || m.role === 'ignore' || c === tc) return;
      if (!c.data) { ch.list.push({ name: c.name, role: m.role, text: c.text }); if (!ch.byRole[m.role]) ch.byRole[m.role] = []; ch.byRole[m.role].push(ch.list[ch.list.length - 1]); return; }
      var y = toSI(m.role, m.unit, c.data);
      var siUnit = { altitude: 'm', gps_alt: 'm', velocity: 'm/s', velocity_h: 'm/s', pressure: 'Pa', temperature: '°C', voltage: 'V', humidity: '%', lat: '°', lon: '°', flight_time: 's' }[m.role] || (/^accel/.test(m.role) ? 'm/s²' : /^gyro/.test(m.role) ? '°/s' : '');
      var o = { name: c.name, role: m.role, y: y, unit: siUnit, gravity: m.gravity, frame: m.frame };
      ch.list.push(o);
      (ch.byRole[m.role] = ch.byRole[m.role] || []).push(o);
    });
    return ch;
  }

  /* ------------------------------------------------------------------ */
  /* Flight analysis                                                     */
  /* ------------------------------------------------------------------ */
  function pickAltitude(ch) {
    var alts = ch.byRole.altitude || [];
    if (alts.length) {
      // prefer names like h / alt / kf_height over baro / filtered; just keep detection order but prefer non-'baro'
      var sorted = alts.slice().sort(function (a, b) { return score(b.name) - score(a.name); });
      function score(n) { n = norm(n); return (/^(h|alt|altitude|kf_height|kf_height_m|height)$/.test(n) ? 3 : 0) + (/kf|kalman|est|fused/.test(n) ? 1 : 0) - (/filtered|agl/.test(n) ? 0.5 : 0); }
      return { y: sorted[0].y, name: sorted[0].name, from: 'column' };
    }
    return null;
  }

  function thrustProxy(ch) {
    // specific force along the up/thrust axis in m/s² (≈ +g at rest on the pad)
    var verts = (ch.byRole.accel_vertical || []).slice().sort(function (a, b) {
      function sc(n) { n = norm(n); return (/vert/.test(n) ? 2 : 0) + (/kf|filt/.test(n) ? -0.5 : 0); }
      return sc(b.name) - sc(a.name);
    });
    var v = verts[0];
    if (v) {
      var gIncl = v.gravity === 'included', sgn = gIncl && median(v.y) < 0 ? -1 : 1;
      var y = new Float64Array(v.y.length);
      for (var i = 0; i < y.length; i++) y[i] = gIncl ? sgn * v.y[i] : v.y[i] + G;
      return { y: y, name: v.name, src: v };
    }
    var best = null, bestPk = 0;
    ['accel_x', 'accel_y', 'accel_z'].forEach(function (r) {
      (ch.byRole[r] || []).forEach(function (a) {
        var mx = -Infinity, mn = Infinity;
        for (var i = 0; i < a.y.length; i++) { if (a.y[i] > mx) mx = a.y[i]; if (a.y[i] < mn) mn = a.y[i]; }
        var sgn = mx >= -mn ? 1 : -1, pk = Math.max(mx, -mn);
        if (pk > bestPk) { bestPk = pk; best = { a: a, sgn: sgn }; }
      });
    });
    if (!best) return null;
    var y2 = new Float64Array(best.a.y.length);
    for (var k = 0; k < y2.length; k++) y2[k] = best.sgn * best.a.y[k];
    return { y: y2, name: best.a.name + (best.sgn < 0 ? ' (inverted)' : ''), src: best.a, axis: true };
  }

  var FULL_SCALES = [2, 3, 4, 6, 8, 12, 16, 24, 30, 32, 40, 64, 100, 120, 200, 400];
  function saturationCheck(ch, t0, t1) {
    var out = [];
    ch.list.forEach(function (c) {
      if (!c.y || !/^accel/.test(c.role)) return;
      var a = idxAtTime(ch.t, t0), b = idxAtTime(ch.t, t1), mx = -Infinity, mn = Infinity;
      for (var i = 0; i < c.y.length; i++) { if (c.y[i] > mx) mx = c.y[i]; if (c.y[i] < mn) mn = c.y[i]; }
      [mx, mn].forEach(function (lim) {
        var gl = Math.abs(lim) / G;
        var fs = FULL_SCALES.find(function (f) { return Math.abs(gl - f) / f < 0.004; });
        if (!fs) return;
        var cnt = 0; for (var i = a; i <= b; i++) if (Math.abs(c.y[i] - lim) < 1e-9) cnt++;
        if (cnt >= 2) out.push({ name: c.name, g: fs, count: cnt });
      });
    });
    return out;
  }

  function analyze(ch, opts) {
    opts = opts || {};
    var t = ch.t, n = t.length, notes = [], res = { notes: notes, events: [] }, i;
    var hasEvents = (ch.byRole.event || []).length > 0;
    if (n < 30) { res.ok = false; res.kind = hasEvents ? 'events' : 'aux'; return res; }
    var dtMed = medianDiff(t); res.sampleRate = dtMed > 0 ? 1 / dtMed : NaN;
    var gaps = [];
    for (i = 1; i < n; i++) { var d = t[i] - t[i - 1]; if (d > Math.max(10 * dtMed, 0.25)) gaps.push({ t: t[i - 1], dur: d }); }
    res.gaps = gaps;

    var alt = pickAltitude(ch), altY = null, altName = null;
    var pr = (ch.byRole.pressure || [])[0];
    var thr = thrustProxy(ch);
    var vel = (ch.byRole.velocity || [])[0];
    if (alt) { altY = alt.y; altName = alt.name; }
    if (!altY && !pr && !thr && !vel) { res.ok = false; res.kind = hasEvents ? 'events' : 'aux'; return res; }
    var thrS = thr ? smoothTime(t, thr.y, Math.max(0.06, 2.5 * dtMed)) : null;

    var p0 = NaN;
    if (!altY && pr) { p0 = median(pr.y); altY = pressureToAlt(pr.y, p0); altName = 'altitude from ' + pr.name; res.altFromPressure = true; }
    if (!altY && vel) { altY = new Float64Array(n); for (i = 1; i < n; i++) altY[i] = altY[i - 1] + (vel.y[i] + vel.y[i - 1]) / 2 * (t[i] - t[i - 1]); altName = 'integrated ' + vel.name; }

    var tLift, liftMethod, iL, apI, tApo = NaN, apogee = NaN, ground = 0, altS = null, altSm = null;
    var k = Math.max(3, Math.round(0.15 / (dtMed || 0.01)) | 1);
    if (altY) {
      altS = medianFilter(altY, Math.min(k, 15));
      apI = 0; for (i = 0; i < n; i++) if (altS[i] > altS[apI] || !(altS[apI] === altS[apI])) apI = i;
      var pre = Array.prototype.slice.call(altS.subarray(0, apI + 1)).filter(function (v) { return v === v; }).sort(function (a, b) { return a - b; });
      var lowG = pre.length ? pre[Math.floor(pre.length * 0.05)] : 0;
      var apoRel = altS[apI] - lowG;
      if (!(apoRel > 15)) { res.ok = false; res.kind = hasEvents ? 'events' : 'noflight'; notes.push({ level: 'info', text: 'No climb larger than 15 m — treated as an auxiliary file.' }); return res; }
      var thrH = Math.max(3, 0.01 * apoRel), lI = apI;
      while (lI > 0 && altS[lI] - lowG > thrH) lI--;
      tLift = t[lI]; liftMethod = 'altitude rise';
    } else {
      // acceleration only: liftoff = the largest sustained thrust event
      var pk = 0; for (i = 0; i < n; i++) if (thrS[i] > thrS[pk]) pk = i;
      if (!(thrS[pk] > 2.5 * G)) { res.ok = false; res.kind = 'aux'; return res; }
      tLift = t[pk]; liftMethod = 'acceleration';
    }
    if (thr) {
      var a0 = idxAtTime(t, tLift - 4), a1 = idxAtTime(t, tLift + 1.5);
      for (i = a0; i <= a1; i++) if (thr.y[i] > 2.5 * G) {
        var j = i; while (j > a0 && thr.y[j - 1] > 1.5 * G) j--;
        tLift = t[j]; liftMethod = 'acceleration > 2.5 g'; break;
      }
    }
    iL = idxAtTime(t, tLift);
    var tPad0 = tLift - 10, tPad1 = tLift - 1;
    if (altY) {
      if (res.altFromPressure) {
        p0 = rangeMedian(t, pr.y, tPad0, tPad1); if (!(p0 > 0)) p0 = median(pr.y);
        altY = pressureToAlt(pr.y, p0); altS = medianFilter(altY, Math.min(k, 15)); res.padPressure = p0;
      }
      ground = rangeMedian(t, altS, tPad0, tPad1); if (!(ground === ground)) ground = altS[iL];
      apI = iL; for (i = iL; i < n; i++) if (altS[i] > altS[apI]) apI = i;
      tApo = t[apI]; apogee = altS[apI] - ground;
      altSm = smoothTime(t, altY, dtMed > 0.05 ? 0.5 : 0.3);
    } else apI = idxAtTime(t, tLift + 25);
    var rawAlt = null, rawName = altName;
    if (pr && !res.altFromPressure) { var pp0 = rangeMedian(t, pr.y, tPad0, tPad1); if (pp0 > 0) { rawAlt = pressureToAlt(pr.y, pp0); rawName = pr.name; } }
    if (!rawAlt) { var bAlt = (ch.byRole.altitude || []).find(function (c) { return /baro/.test(norm(c.name)); }); if (bAlt && altY !== bAlt.y) { rawAlt = bAlt.y; rawName = bAlt.name; } }
    var rawSm = rawAlt ? smoothTime(t, rawAlt, dtMed > 0.05 ? 0.5 : 0.3) : altSm;
    var vBaro = rawSm ? derivative(t, rawSm, dtMed > 0.05 ? 0.6 : 0.4) : null;
    res.baroSlopeName = rawName;
    var vY = vel ? vel.y : vBaro, vName = vel ? vel.name : (vBaro ? 'slope of ' + altName : null);

    // burnout: smoothed specific force falls below 1 g (net acceleration < 0) for ≥0.3 s
    var tBurn = NaN, burnMethod = '', pkI = iL;
    if (thr) {
      var lim = idxAtTime(t, Math.min(tApo === tApo ? tApo : Infinity, tLift + 30));
      for (i = iL; i <= lim; i++) if (thrS[i] > thrS[pkI]) pkI = i;
      for (i = pkI; i <= lim; i++) {
        if (thrS[i] < G) {
          var e2 = idxAtTime(t, t[i] + 0.3), okb = true;
          for (var q = i; q <= e2; q++) if (thrS[q] >= G) { okb = false; break; }
          if (okb) { tBurn = t[i]; burnMethod = 'net acceleration turns negative'; break; }
        }
      }
    }
    // accel-integrated velocity (boost), drift-corrected so v(apogee)=0
    var vAcc = null;
    if (thr && altY) {
      vAcc = new Float64Array(n).fill(NaN); var acc = 0; vAcc[iL] = 0;
      for (i = iL + 1; i <= apI; i++) { var dt = t[i] - t[i - 1]; if (dt > 1) dt = dtMed; acc += ((thr.y[i] + thr.y[i - 1]) / 2 - G) * dt; vAcc[i] = acc; }
      var drift = vAcc[apI] / ((t[apI] - t[iL]) || 1);
      for (i = iL + 1; i <= apI; i++) vAcc[i] -= drift * (t[i] - t[iL]);
    }
    var vMaxSrc = vel ? vel.y : (vAcc && dtMed < 0.05 ? vAcc : vBaro), vmI = -1;
    if (vMaxSrc) { vmI = iL; for (i = iL; i <= apI; i++) if (vMaxSrc[i] > vMaxSrc[vmI] || !(vMaxSrc[vmI] === vMaxSrc[vmI])) vmI = i; }
    if (!(tBurn === tBurn) && vmI >= 0) { tBurn = t[vmI]; burnMethod = 'max velocity'; }

    // max acceleration (net, along thrust axis)
    var maxAcc = NaN, maxAccT = NaN;
    if (thr) { var mI = iL, l3 = idxAtTime(t, tLift + 30); for (i = iL; i <= l3; i++) if (thr.y[i] > thr.y[mI]) mI = i; maxAcc = thr.y[mI] - G; maxAccT = t[mI]; }
    var sats = saturationCheck(ch, tLift - 1, tLift + 30);

    // landing
    var tLand = NaN, landI = -1, landMethod = '';
    if (altSm) {
      var nearG = Math.max(30, 0.03 * apogee);
      for (i = apI; i < n; i++) {
        if (altS[i] - ground > nearG) continue;
        var e = idxAtTime(t, t[i] + 3), span = t[e] - t[i];
        if (span < 1) break;
        var mn2 = Infinity, mx2 = -Infinity;
        for (q = i; q <= e; q++) { if (altSm[q] < mn2) mn2 = altSm[q]; if (altSm[q] > mx2) mx2 = altSm[q]; }
        if ((mx2 - mn2) / span < 0.8) { tLand = t[i]; landI = i; landMethod = 'altitude steady near ground'; break; }
      }
      if (!(tLand === tLand)) {
        var lastAlt = altS[n - 1] - ground;
        if (lastAlt < nearG && t[n - 1] > tApo + 5) {
          for (i = apI; i < n; i++) if (altS[i] - ground < Math.max(3, lastAlt + 2)) { tLand = t[i]; landI = i; landMethod = 'log ends at ground level'; break; }
        } else notes.push({ level: 'info', text: 'Log ends before touchdown — landing not detected.' });
      }
    }
    // descent rates and main deployment
    var desc = null;
    if (altSm && tApo === tApo) {
      var dStart = tApo + 3, dEnd = (tLand === tLand ? tLand : t[n - 1]) - 1;
      if (dEnd - dStart > 6) {
        var ts = [], vs = [];
        for (var tt = dStart; tt <= dEnd; tt += 0.25) {
          var a = idxAtTime(t, tt - 0.5), b = idxAtTime(t, tt + 0.5);
          if (t[b] - t[a] > 0.3 && t[b] - t[a] < 2) { ts.push(tt); vs.push((altSm[b] - altSm[a]) / (t[b] - t[a])); }
        }
        if (ts.length > 20) {
          var m = ts.length, p1 = [0], p2 = [0];
          for (i = 0; i < m; i++) { p1.push(p1[i] + vs[i]); p2.push(p2[i] + vs[i] * vs[i]); }
          var sse = function (a, b) { var c = b - a; if (c <= 0) return 0; var s = p1[b] - p1[a]; return p2[b] - p2[a] - s * s / c; };
          var total = sse(0, m), best = { k: -1, e: total };
          for (var kk = 8; kk < m - 8; kk++) { var ee = sse(0, kk) + sse(kk, m); if (ee < best.e) best = { k: kk, e: ee }; }
          desc = {};
          var r1 = best.k > 0 ? -p1[best.k] / best.k : NaN, r2 = best.k > 0 ? -(p1[m] - p1[best.k]) / (m - best.k) : NaN;
          if (best.k > 0 && r1 > 1.3 * r2 && r1 - r2 > 4 && best.e < 0.6 * total) {
            // knee: first point near the split where the rate stays below the midpoint for 2 s
            var thrV = (r1 + r2) / 2, kS = best.k;
            for (var z = Math.max(0, best.k - 20); z < Math.min(m - 8, best.k + 20); z++) {
              var stay = true; for (var zz = z; zz < Math.min(m, z + 8); zz++) if (-vs[zz] >= thrV) { stay = false; break; }
              if (stay) { kS = z; break; }
            }
            desc.splitT = ts[best.k];
            desc.mainT = ts[kS];
            desc.mainAlt = valueAt(t, altSm, desc.mainT) - ground;
            desc.drogueRate = steady(ts, vs, ts[0], desc.mainT - 2);
            desc.mainRate = steady(ts, vs, desc.mainT + 3, ts[m - 1]);
          } else desc.singleRate = steady(ts, vs, ts[0], ts[m - 1]);
        }
      }
    }
    function steady(ts, vs, a, b) { var arr = []; for (var i = 0; i < ts.length; i++) if (ts[i] >= a && ts[i] <= b) arr.push(-vs[i]); return median(arr); }

    // GPS
    var gps = null, la = (ch.byRole.lat || [])[0], lo = (ch.byRole.lon || [])[0], sv = (ch.byRole.sats || [])[0];
    if (la && lo) {
      var valid = new Uint8Array(n);
      for (i = 0; i < n; i++) valid[i] = la.y[i] === la.y[i] && lo.y[i] === lo.y[i] && !(la.y[i] === 0 && lo.y[i] === 0) && Math.abs(la.y[i]) <= 90 && (!sv || sv.y[i] >= 4) ? 1 : 0;
      gps = { valid: valid, lat: la.y, lon: lo.y };
      var padLa = [], padLo = [];
      for (i = idxAtTime(t, tLift - 30); i <= idxAtTime(t, tLift - 0.5); i++) if (valid[i]) { padLa.push(la.y[i]); padLo.push(lo.y[i]); }
      if (padLa.length) gps.pad = [median(padLa), median(padLo)];
      var fe = tLand === tLand ? tLand : t[n - 1], outS = NaN, longest = null;
      for (i = iL; i < n && t[i] <= fe + 600; i++) {
        if (!valid[i] && !(outS === outS)) outS = t[i];
        if (valid[i] && outS === outS) { var L = { from: outS, to: t[i] }; if (!longest || L.to - L.from > longest.to - longest.from) longest = L; outS = NaN; if (t[i] > fe) break; }
      }
      if (outS === outS) { var L2 = { from: outS, to: NaN }; if (!longest || t[n - 1] - outS > longest.to - longest.from) longest = L2; }
      gps.outage = longest;
      if (landI >= 0) for (i = landI; i < n; i++) if (valid[i]) { gps.landing = [la.y[i], lo.y[i]]; gps.landingFixT = t[i]; break; }
      if (gps.pad && gps.landing) {
        gps.drift = haversine(gps.pad[0], gps.pad[1], gps.landing[0], gps.landing[1]);
        gps.bearing = bearing(gps.pad[0], gps.pad[1], gps.landing[0], gps.landing[1]);
      }
      if (!gps.pad) notes.push({ level: 'info', text: 'No valid GPS fix on the pad before liftoff.' });
    }

    var gT = opts.groundTempC !== undefined ? opts.groundTempC : 15;
    res.ok = true; res.kind = altY ? 'flight' : 'accel';
    res.tLift = tLift; res.liftMethod = liftMethod; res.tApo = tApo; res.apogee = apogee; res.ground = ground;
    res.tBurn = tBurn; res.burnMethod = burnMethod; res.tLand = tLand; res.landMethod = landMethod;
    if (vmI >= 0) {
      res.maxV = vMaxSrc[vmI]; res.maxVT = t[vmI];
      res.maxVName = vel ? vel.name : (vMaxSrc === vAcc ? 'integrated acceleration' : 'slope of ' + altName);
      res.mach = res.maxV / speedOfSound(altS ? valueAt(t, altS, t[vmI]) - ground : 0, gT);
    }
    if (vBaro) { var mb = -Infinity, mbT = NaN; for (i = iL; i <= apI; i++) if (vBaro[i] > mb) { mb = vBaro[i]; mbT = t[i]; } res.maxVBaro = mb; res.maxVBaroT = mbT; }
    res.maxAcc = maxAcc; res.maxAccT = maxAccT; res.accName = thr ? thr.name : null; res.saturation = sats;
    res.desc = desc; res.gps = gps; res.altName = altName; res.velName = vName;
    res.series = { alt: altY, altS: altSm, v: vY, vBaro: vBaro, vAcc: vAcc, thr: thr ? thr.y : null, ground: ground };

    sats.forEach(function (s) { notes.push({ level: 'warn', text: 'Accelerometer "' + s.name + '" hit its ±' + s.g + ' g limit (' + s.count + ' samples) — peak acceleration from this sensor is underestimated.' }); });
    var gEnd = tLand === tLand ? tLand + 5 : Math.min(t[n - 1], tLift + 300);
    var fg = gaps.filter(function (gp) { return gp.t >= tLift - 5 && gp.t <= gEnd; });
    fg.slice(0, 4).forEach(function (gp) { notes.push({ level: 'warn', text: 'Logging gap of ' + gp.dur.toFixed(2) + ' s at T' + fmtT(gp.t - tLift) + '.' }); });
    if (fg.length > 4) notes.push({ level: 'warn', text: (fg.length - 4) + ' more logging gaps during the flight.' });
    res.flightGaps = fg;
    // status flags: drop-outs / faults during the flight
    (ch.byRole.flag || []).forEach(function (c) {
      if (!c.y) return;
      var nn = norm(c.name), okType = /ok|valid|health|active|good/.test(nn), faultType = /fault|err|warn/.test(nn);
      var a2 = idxAtTime(t, tLift - 2), b2 = idxAtTime(t, gEnd), bad = 0, trans = 0, prev = null;
      for (var i2 = a2; i2 <= b2; i2++) { var v2 = c.y[i2]; if (!(v2 === v2)) continue; var isBad = okType ? v2 === 0 : faultType ? v2 !== 0 : false; if (isBad) bad++; if (prev !== null && isBad && !prev) trans++; prev = isBad; }
      if (bad) notes.push({ level: 'warn', text: '"' + c.name + '" ' + (okType ? 'dropped to 0' : 'was non-zero') + ' ' + trans + '× during the flight (' + (100 * bad / Math.max(1, b2 - a2 + 1)).toFixed(1) + ' % of samples).' });
    });
    if (gps && gps.outage) notes.push({ level: 'info', text: 'GPS: longest loss of fix from T' + fmtT(gps.outage.from - tLift) + (gps.outage.to === gps.outage.to ? ' to T' + fmtT(gps.outage.to - tLift) : ' until the end of the log') + '.' });
    if (vel && vBaro && res.maxVBaro > 30 && Math.abs(res.maxV - res.maxVBaro) / res.maxVBaro > 0.1)
      notes.push({ level: 'warn', text: 'Logged velocity "' + vel.name + '" peaks at ' + res.maxV.toFixed(0) + ' m/s, but the slope of ' + rawName + ' only reaches ' + res.maxVBaro.toFixed(0) + ' m/s.' });
    if (vel && tBurn === tBurn && burnMethod.indexOf('net') === 0 && res.maxVT - tBurn > 1.5)
      notes.push({ level: 'warn', text: 'Velocity "' + vel.name + '" keeps rising for ' + (res.maxVT - tBurn).toFixed(1) + ' s after burnout (peak at T' + fmtT(res.maxVT - tLift) + ') — it should peak at burnout, so the on-board estimate looks biased.' });
    return res;
  }
  function fmtT(x) { return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2) + ' s'; }

  /* state transitions as events */
  function stateEvents(ch, stateNames) {
    var out = [];
    (ch.byRole.state || []).forEach(function (s) {
      var prev = NaN;
      for (var i = 0; i < s.y.length; i++) {
        var v = s.y[i]; if (v !== v) continue;
        if (v !== prev) { if (prev === prev) out.push({ t: ch.t[i], label: s.name + ' → ' + ((stateNames && stateNames[v]) || v), kind: 'state', code: v, from: prev }); prev = v; }
      }
    });
    (ch.byRole.output || []).forEach(function (s) {
      var prev = NaN;
      for (var i = 0; i < s.y.length; i++) {
        var v = s.y[i]; if (v !== v) continue;
        if (v !== prev) { if (prev === prev) out.push({ t: ch.t[i], label: s.name + (v ? ' ON' : ' OFF'), kind: 'output' }); prev = v; }
      }
    });
    (ch.byRole.control || []).forEach(function (s) {
      var on = false, thr = 0.05;
      for (var i = 0; i < s.y.length; i++) {
        var v = s.y[i]; if (v !== v) continue;
        if (!on && Math.abs(v) > thr) { on = true; out.push({ t: ch.t[i], label: s.name + ' active', kind: 'control' }); }
        else if (on && Math.abs(v) <= thr) { on = false; out.push({ t: ch.t[i], label: s.name + ' inactive', kind: 'control' }); }
      }
    });
    (ch.byRole.event || []).forEach(function (s) {
      if (!s.text) return;
      var states = ch.byRole.state || [], newState = ch.list.find(function (c) { return norm(c.name) === 'new_state'; });
      for (var i = 0; i < s.text.length; i++) {
        if (!s.text[i]) continue;
        var lab = s.text[i];
        if (newState && newState.y) lab += newState.y[i] ? ' ON' : ' OFF';
        out.push({ t: ch.t[i], label: lab, kind: 'logged' });
      }
    });
    return out.sort(function (a, b) { return a.t - b.t; });
  }

  return {
    G: G, ROLES: ROLES, parseCSV: parseCSV, parseCATS: parseCATS, looksLikeCATS: looksLikeCATS, detectColumns: detectColumns,
    buildChannels: buildChannels, analyze: analyze, stateEvents: stateEvents, idxAtTime: idxAtTime, valueAt: valueAt,
    median: median, norm: norm, haversine: haversine, smoothTime: smoothTime, CATS_STATES: CATS_STATES, fmtT: fmtT, stats: stats
  };
})();
if (typeof module !== 'undefined') module.exports = RL;
