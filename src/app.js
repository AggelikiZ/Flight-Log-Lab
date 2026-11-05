/* Flight Log Lab — UI layer */
(function () {
  'use strict';
  var G = RL.G;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k]; if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'html') e.innerHTML = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v); else if (k === 'style') e.style.cssText = v; else e.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null || c === false) continue; if (Array.isArray(c)) c.forEach(function (x) { if (x != null && x !== false) e.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); }); else e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return e;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function seriesColor(i) { return cssVar('--series-' + ((i % 8) + 1)); }
  function fin(x) { return typeof x === 'number' && isFinite(x); }
  function f(x, d, unit) { if (!fin(x)) return '—'; return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) + (unit ? ' ' + unit : ''); }
  function fT(x) { if (!fin(x)) return '—'; return 'T' + (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2) + ' s'; }
  function toast(msg) { var t = h('div', { class: 'toast', text: msg }); document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3200); }
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('fll:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('fll:' + k, JSON.stringify(v)); } catch (e) { } }
  };

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  var S = {
    files: [],          // {id, name, table, mapping, kind, cats}
    sources: [],        // built from files
    meta: store.get('sourceMeta', {}), // key -> {label, offset}
    settings: { target: store.get('target', ''), groundTemp: store.get('groundTemp', 20), ref: null, range: 'flight', showLogged: true, showDerived: false },
    tab: 'overview', charts: [], explorerSel: {}
  };
  var nextId = 1;

  /* ------------------------------------------------------------------ */
  /* Files                                                               */
  /* ------------------------------------------------------------------ */
  function headerSig(table) { return table.columns.map(function (c) { return c.name; }).join('|'); }
  function profiles() { return store.get('profiles', {}); }

  function readFile(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }
  function busy(on, text) { $('#busy').classList.toggle('hidden', !on); if (text) $('#busyText').textContent = text; }
  function tick() { return new Promise(function (r) { setTimeout(r, 16); }); }

  async function addFiles(list) {
    list = Array.prototype.slice.call(list);
    if (!list.length) return;
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      busy(true, 'Reading ' + file.name + ' (' + (file.size / 1e6).toFixed(1) + ' MB)…'); await tick();
      try {
        var buf = await readFile(file), table, kind = 'csv';
        if (RL.looksLikeCATS(buf)) { table = RL.parseCATS(buf); kind = 'cats'; }
        else {
          var text = new TextDecoder('utf-8').decode(buf);
          if (/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 2000))) throw new Error('binary file in an unknown format');
          table = RL.parseCSV(text);
        }
        if (!table.rows) throw new Error('no data rows found');
        busy(true, 'Detecting columns in ' + file.name + '…'); await tick();
        var mapping = RL.detectColumns(table, file.name);
        var prof = profiles()[headerSig(table)];
        if (prof && prof.mapping) for (var k in prof.mapping) if (mapping[k]) { Object.assign(mapping[k], prof.mapping[k]); mapping[k].reason = 'saved profile'; mapping[k].conf = 'high'; }
        var stateNames = kind === 'cats' ? { flight_state: RL.CATS_STATES } : (prof && prof.stateNames) || {};
        S.files.push({ id: nextId++, name: file.name, table: table, mapping: mapping, kind: kind, stateNames: stateNames, profileLabel: prof && prof.label });
      } catch (e) {
        console.error(e); toast('Could not read ' + file.name + ': ' + e.message);
      }
    }
    busy(true, 'Analysing flight…'); await tick();
    rebuild();
    busy(false);
  }

  /* group files sharing an identical clock, attach event files to boards */
  function timeKey(fl) {
    var tc = fl.table.columns.find(function (c) { return fl.mapping[c.name] && fl.mapping[c.name].role === 'time'; });
    if (!tc) return null;
    return { name: RL.norm(tc.name), unit: fl.mapping[tc.name].unit, n: fl.table.rows, first: tc.data[0], last: tc.data[fl.table.rows - 1], key: RL.norm(tc.name) + '|' + fl.table.rows + '|' + tc.data[0] + '|' + tc.data[fl.table.rows - 1] };
  }
  function stem(n) { return n.replace(/\.[^.]+$/, '').replace(/^[0-9a-f]{8}-/, ''); }

  function rebuild() {
    var groups = {}, order = [];
    S.files.forEach(function (fl) {
      var tk = fl.kind === 'csv' ? timeKey(fl) : null;
      var key = tk ? 'T:' + tk.key : 'F:' + fl.id;
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(fl);
    });
    var old = {}; S.sources.forEach(function (s) { old[s.key] = s; });
    S.sources = order.map(function (key, idx) {
      var fls = groups[key];
      var table, mapping = {}, stateNames = {};
      if (fls.length === 1) { table = fls[0].table; mapping = fls[0].mapping; stateNames = fls[0].stateNames; }
      else {
        var cols = [], names = {};
        fls.forEach(function (fl, fi) {
          fl.table.columns.forEach(function (c) {
            var m = fl.mapping[c.name];
            if (names[c.name]) {
              if (m && (m.role === 'time' || m.role === 'counter')) return; // shared clock / counter
              var nn = c.name + '_' + stem(fl.name); cols.push({ name: nn, data: c.data, text: c.text }); mapping[nn] = m; names[nn] = 1; return;
            }
            names[c.name] = 1; cols.push(c); mapping[c.name] = m;
          });
          Object.assign(stateNames, fl.stateNames);
        });
        table = { columns: cols, rows: fls[0].table.rows };
      }
      var skey = fls.map(function (x) { return x.name; }).sort().join(' + ');
      var meta = S.meta[skey] || {};
      var label = meta.label || fls[0].profileLabel || (fls[0].kind === 'cats' ? 'CATS Vega · ' + stem(fls[0].name) : fls.map(function (x) { return stem(x.name); }).join(' + '));
      return { id: 's' + idx, key: skey, files: fls, table: table, mapping: mapping, stateNames: stateNames, kind: fls[0].kind, label: label, offset: meta.offset || 0, cats: fls[0].kind === 'cats' ? fls[0].table : null };
    });
    S.sources.forEach(function (s, i) { s.slot = i; analyzeSource(s); });
    // sync auxiliary sources (event logs) to a flight board on the same clock
    S.sources.forEach(function (s) {
      if (s.an.ok) return;
      var tc = s.ch.timeName ? RL.norm(s.ch.timeName) : null; if (!tc) return;
      var t0 = s.ch.t[0], t1 = s.ch.t[s.ch.t.length - 1];
      var tgt = S.sources.find(function (o) { return o !== s && o.an.ok && RL.norm(o.ch.timeName) === tc && o.ch.t[0] <= t1 && o.ch.t[o.ch.t.length - 1] >= t0; });
      if (tgt) { s.syncTo = tgt; s.slot = tgt.slot; if (!S.meta[s.key] || !S.meta[s.key].label) s.label = tgt.label + ' · ' + stem(s.files[0].name); }
    });
    var slot = 0; S.sources.forEach(function (s) { if (!s.syncTo) s.slot = slot++; });
    S.sources.forEach(function (s) { if (s.syncTo) s.slot = s.syncTo.slot; });
    // reference board: highest sample rate among sources with altitude+velocity
    var flights = S.sources.filter(function (s) { return s.an.ok && s.an.kind === 'flight'; });
    if (!S.settings.ref || !S.sources.some(function (s) { return s.key === S.settings.ref; })) {
      var best = flights.slice().sort(function (a, b) {
        function sc(s) { return (s.ch.byRole.velocity ? 2 : 0) + (s.ch.byRole.accel_vertical || s.ch.byRole.accel_x ? 1 : 0) + Math.min(1, (s.an.sampleRate || 0) / 100) - (s.an.flightGaps || []).length * 0.3; }
        return sc(b) - sc(a);
      })[0];
      S.settings.ref = best ? best.key : null;
    }
    render();
  }

  function analyzeSource(s) {
    s.ch = RL.buildChannels(s.table, s.mapping);
    s.an = RL.analyze(s.ch, { groundTempC: +S.settings.groundTemp });
    // logged events
    var ev = RL.stateEvents(s.ch, s.stateNames);
    if (s.cats) {
      ev = ev.filter(function (e) { return !(e.kind === 'state' && /flight_state/.test(e.label)); });
      ev = ev.concat(s.cats.events.map(function (e) { return { t: e.t, label: e.label, kind: 'logged' }; }));
    }
    s.logged = ev.sort(function (a, b) { return a.t - b.t; });
  }
  function lift(s) { if (s.an && s.an.ok) return s.an.tLift - s.offset; if (s.syncTo) return lift(s.syncTo) ; return null; }
  function tp(s, t) { var L = lift(s); return L == null ? NaN : t - L; }
  function refSource() { return S.sources.find(function (s) { return s.key === S.settings.ref; }) || S.sources.find(function (s) { return s.an.ok; }); }
  function flightSources() { return S.sources.filter(function (s) { return s.an.ok; }); }

  function detectedEvents(s) {
    var a = s.an, L = lift(s), out = [];
    if (!a.ok) return out;
    function add(t, label, extra) { if (fin(t)) out.push(Object.assign({ t: t - L, label: label, kind: 'detected', src: s }, extra || {})); }
    add(a.tLift, 'Liftoff', { how: a.liftMethod });
    add(a.tBurn, 'Burnout', { how: a.burnMethod });
    if (fin(a.maxVT)) add(a.maxVT, 'Max velocity ' + f(a.maxV, 0, 'm/s'), { minor: true });
    add(a.tApo, 'Apogee ' + f(a.apogee, 0, 'm'));
    if (a.desc && fin(a.desc.mainT)) add(a.desc.mainT, 'Main canopy (descent slows)', { how: 'descent-rate step' });
    add(a.tLand, 'Landing', { how: a.landMethod });
    return out;
  }
  function allEvents() {
    var out = [];
    S.sources.forEach(function (s) {
      detectedEvents(s).forEach(function (e) { out.push(e); });
      var L = lift(s);
      (s.logged || []).forEach(function (e) { out.push({ t: L == null ? NaN : e.t - L, rawT: e.t, label: e.label, kind: e.kind === 'logged' ? 'logged' : 'logged', sub: e.kind, src: s }); });
    });
    return out.sort(function (a, b) { return (fin(a.t) ? a.t : 1e12) - (fin(b.t) ? b.t : 1e12); });
  }

  /* ------------------------------------------------------------------ */
  /* Ranges                                                              */
  /* ------------------------------------------------------------------ */
  function currentRange() {
    var fs = flightSources(); if (!fs.length) return null;
    var r = S.settings.range, ref = refSource() && refSource().an.ok ? refSource() : fs[0], a = ref.an, L = lift(ref);
    var maxOf = function (fn) { var m = -Infinity; fs.forEach(function (s) { var v = fn(s); if (fin(v) && v > m) m = v; }); return m; };
    if (r === 'boost') return [-1.5, Math.max(4, (fin(a.tBurn) ? a.tBurn - L : 3) + 3)];
    if (r === 'ascent') return [-2, (fin(a.tApo) ? a.tApo - L : 30) + 6];
    if (r === 'flight') {
      var end = maxOf(function (s) { return fin(s.an.tLand) ? s.an.tLand - lift(s) : NaN; });
      if (!fin(end)) end = maxOf(function (s) { return s.ch.t[s.ch.t.length - 1] - lift(s); });
      return [-5, end + 10];
    }
    var mn = Infinity, mx = -Infinity;
    S.sources.forEach(function (s) { var L2 = lift(s); if (L2 == null) return; mn = Math.min(mn, s.ch.t[0] - L2); mx = Math.max(mx, s.ch.t[s.ch.t.length - 1] - L2); });
    return [mn, mx];
  }

  /* ------------------------------------------------------------------ */
  /* Charts (uPlot)                                                      */
  /* ------------------------------------------------------------------ */
  function decimate(x, y, x0, x1, maxPts, gapDt) {
    var a = RL.idxAtTime(x, x0), b = RL.idxAtTime(x, x1);
    if (a > 0) a--; if (b < x.length - 1) b++;
    var n = b - a + 1, xs = [], ys = [];
    if (n <= maxPts) {
      for (var i = a; i <= b; i++) {
        if (gapDt && i > a && x[i] - x[i - 1] > gapDt) { xs.push((x[i] + x[i - 1]) / 2); ys.push(null); }
        xs.push(x[i]); ys.push(fin(y[i]) ? y[i] : null);
      }
      return [xs, ys];
    }
    var buckets = Math.floor(maxPts / 2), bw = (x[b] - x[a]) / buckets, j = a;
    for (var k = 0; k < buckets && j <= b; k++) {
      var end = x[a] + (k + 1) * bw, mi = -1, ma = -1;
      for (; j <= b && x[j] <= end; j++) { if (!fin(y[j])) continue; if (mi < 0 || y[j] < y[mi]) mi = j; if (ma < 0 || y[j] > y[ma]) ma = j; }
      if (mi < 0) { xs.push(end - bw / 2); ys.push(null); continue; }
      if (mi <= ma) { xs.push(x[mi]); ys.push(y[mi]); if (ma !== mi) { xs.push(x[ma]); ys.push(y[ma]); } }
      else { xs.push(x[ma]); ys.push(y[ma]); xs.push(x[mi]); ys.push(y[mi]); }
    }
    return [xs, ys];
  }
  function medDt(x) { var d = [], st = Math.max(1, Math.floor(x.length / 3000)); for (var i = st; i < x.length; i += st) d.push(x[i] - x[i - 1]); d.sort(function (a, b) { return a - b; }); return d[d.length >> 1] || 0; }

  /* spec: {title, unit, series:[{label, color, x, y, dash, step, width}], range, events, height, syncKey, yMin} */
  function makeChart(container, spec) {
    var wrap = h('div', { class: 'chart' }); container.appendChild(wrap);
    var gapCache = spec.series.map(function (s) { var m = medDt(s.x); return Math.max(10 * m, 0.25); });
    function build(r) {
      var tables = [], modes = [];
      var width = Math.max(300, wrap.clientWidth || 800);
      spec.series.forEach(function (s, i) {
        var d = decimate(s.x, s.y, r[0], r[1], Math.round(width * 2), gapCache[i]);
        if (!d[0].length) d = [[r[0]], [null]];
        tables.push(d); modes.push([1, 1]);
      });
      return uPlot.join(tables, modes);
    }
    var range = spec.range.slice(), initRange = spec.range.slice();
    var axisStroke = cssVar('--axis'), grid = cssVar('--grid'), font = '11px ' + cssVar('--mono');
    var opts = {
      width: Math.max(300, wrap.clientWidth || 800), height: spec.height || 260,
      title: spec.titleInChart || undefined,
      cursor: { sync: spec.syncKey ? { key: spec.syncKey, setSeries: false } : undefined, drag: { x: true, y: false, setScale: false }, points: { size: 6 } },
      select: { show: true },
      legend: { live: true },
      scales: { x: { time: false, range: function () { return range; } }, y: { range: function (u, mn, mx) { if (mn == null) return [0, 1]; var p = (mx - mn) * 0.06 || 1; var lo = spec.yMin != null ? Math.min(spec.yMin, mn - p) : mn - p; return [lo, mx + p]; } } },
      axes: [
        { stroke: axisStroke, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, font: font, values: function (u, v) { return v.map(function (x) { return String(+x.toFixed(3)); }); }, label: 'T+ (s)', labelFont: '11px ' + cssVar('--sans'), labelSize: 18 },
        { stroke: axisStroke, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, font: font, size: function (u, values) { var m = 0; (values || []).forEach(function (v) { m = Math.max(m, String(v).length); }); return Math.max(40, m * 7 + 26); }, label: spec.unit || '', labelFont: '11px ' + cssVar('--sans'), labelSize: 16 }
      ],
      series: [{ label: 'T+', value: function (u, v) { return v == null ? '—' : v.toFixed(2) + ' s'; } }].concat(spec.series.map(function (s) {
        return {
          label: s.label, stroke: s.color, width: s.width || 1.6, dash: s.dash, spanGaps: false,
          paths: s.step ? uPlot.paths.stepped({ align: 1 }) : undefined,
          value: function (u, v) { return v == null ? '—' : (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)) + (spec.unit && !s.noUnit ? ' ' + spec.unit : ''); },
          points: { show: false }
        };
      })),
      hooks: {
        draw: [function (u) {
          var evs = (spec.events || []).filter(function (e) { return e.t >= range[0] && e.t <= range[1]; });
          if (!evs.length) return;
          var ctx = u.ctx, top = u.bbox.top, bot = u.bbox.top + u.bbox.height, dpr = devicePixelRatio || 1;
          ctx.save(); ctx.font = (10 * dpr) + 'px ' + cssVar('--sans');
          var lanes = [-1e9, -1e9, -1e9];
          evs.forEach(function (e) {
            var x = Math.round(u.valToPos(e.t, 'x', true)) + 0.5;
            ctx.strokeStyle = e.color || axisStroke; ctx.globalAlpha = e.logged ? 0.45 : 0.75; ctx.lineWidth = dpr;
            ctx.setLineDash(e.logged ? [2 * dpr, 3 * dpr] : [5 * dpr, 4 * dpr]);
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.stroke();
            var w = ctx.measureText(e.label).width + 8 * dpr, lane = 0;
            while (lane < lanes.length && lanes[lane] > x) lane++;
            if (lane >= lanes.length) return;
            lanes[lane] = x + w;
            ctx.globalAlpha = 1; ctx.setLineDash([]);
            ctx.fillStyle = cssVar('--surface-1'); ctx.globalAlpha = 0.85;
            ctx.fillRect(x + 2 * dpr, top + 2 * dpr + lane * 14 * dpr, w - 4 * dpr, 12 * dpr);
            ctx.globalAlpha = 1; ctx.fillStyle = cssVar('--text-secondary');
            ctx.fillText(e.label, x + 4 * dpr, top + 11 * dpr + lane * 14 * dpr);
          });
          ctx.restore();
        }],
        setSelect: [function (u) {
          if (u.select.width < 5) return;
          var a = u.posToVal(u.select.left, 'x'), b = u.posToVal(u.select.left + u.select.width, 'x');
          zoomTo(u, [a, b]);
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        }],
        ready: [function (u) { u.over.addEventListener('dblclick', function () { zoomTo(u, initRange); }); }]
      }
    };
    function zoomTo(u, r) { range = r; u.setData(build(r), false); u.setScale('x', { min: r[0], max: r[1] }); u.redraw(); if (spec.onZoom) spec.onZoom(r); }
    var u = new uPlot(opts, build(range), wrap);
    var ro = new ResizeObserver(function () { var w = wrap.clientWidth; if (w && Math.abs(w - u.width) > 4) { u.setSize({ width: w, height: opts.height }); } });
    ro.observe(wrap);
    var chart = { u: u, wrap: wrap, destroy: function () { ro.disconnect(); u.destroy(); }, zoomTo: function (r) { zoomTo(u, r); }, spec: spec };
    S.charts.push(chart);
    return chart;
  }
  function destroyCharts() { S.charts.forEach(function (c) { try { c.destroy(); } catch (e) { } }); S.charts = []; }

  function eventMarkers(opts) {
    opts = opts || {};
    var ref = refSource(); if (!ref) return [];
    var out = detectedEvents(ref).filter(function (e) { return !e.minor; }).map(function (e) { return { t: e.t, label: e.label.replace(/ [\d,]+ m(\/s)?$/, ''), color: cssVar('--text-muted') }; });
    if (S.settings.showLogged && opts.logged !== false) {
      S.sources.forEach(function (s) {
        var L = lift(s); if (L == null) return;
        var seen = {};
        (s.logged || []).forEach(function (e) {
          if (e.kind === 'control') return;
          var t = e.t - L, k = e.label.replace(/ (ON|OFF)$/, '') + Math.round(t * 2);
          if (seen[k]) return; seen[k] = 1;
          if (!/ OFF$|inactive/.test(e.label)) out.push({ t: t, label: e.label, color: seriesColor(s.slot), logged: true });
        });
      });
    }
    return out;
  }
  function chartCard(parent, title, sub, build, extra) {
    var card = h('div', { class: 'card' });
    var pngBtn = h('button', { class: 'btn ghost small', text: 'PNG', title: 'Download this chart as an image' });
    card.appendChild(h('h3', null, title, sub ? h('span', { class: 'sub', text: sub }) : null, h('span', { class: 'spacer' }), extra || null, pngBtn));
    parent.appendChild(card);
    var c = build(card);
    pngBtn.addEventListener('click', function () { if (c && c.u) downloadCanvas(c.u, title); });
    if (!downloadsCap) pngBtn.classList.add('hidden');
    return card;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */
  function render() {
    var has = S.sources.length > 0;
    $('#app').classList.toggle('hidden', !has);
    $('#drop').classList.toggle('compact', has);
    $('#chatFab').classList.toggle('hidden', !has || !sampleCap);
    $('#exportBtn').disabled = !has; $('#clearBtn').disabled = !has;
    if (has) { $('#drop h2').textContent = 'Add more files'; $('#drop p').textContent = 'Drop more logs from the same launch, or click to browse.'; }
    else { $('#drop h2').textContent = 'Drop your flight logs here'; }
    $('#drop .formats').classList.toggle('hidden', has);
    if (!has) { destroyCharts(); return; }
    renderSources(); renderSettings(); renderTab();
    updateSuggestions();
  }

  function renderSources() {
    var box = $('#sources'); box.innerHTML = '';
    S.sources.forEach(function (s) {
      var a = s.an, kindTag = s.kind === 'cats' ? 'CATS binary v' + (s.cats.version || '?') : 'CSV';
      var desc = a.ok ? (a.kind === 'flight' ? 'Flight detected' : 'Boost detected (acceleration only)') : (s.syncTo ? 'Event log, synced to ' + s.syncTo.label : 'No flight found');
      var label = h('input', { class: 'label', value: s.label, 'aria-label': 'Board name', onchange: function (e) { s.label = e.target.value || s.label; (S.meta[s.key] = S.meta[s.key] || {}).label = s.label; store.set('sourceMeta', S.meta);
        var ps = profiles(); s.files.forEach(function (fl) { var k = headerSig(fl.table); ps[k] = Object.assign(ps[k] || { name: fl.name }, { label: s.label }); fl.profileLabel = s.label; }); store.set('profiles', ps);
        render(); } });
      var offIn = h('input', { type: 'number', step: '0.01', value: s.offset || 0, style: 'width:70px;background:var(--surface-2);border:1px solid var(--border);border-radius:5px;padding:1px 5px;font-size:12px', title: 'Shift this board in time (seconds) to fine-tune alignment', onchange: function (e) { s.offset = +e.target.value || 0; (S.meta[s.key] = S.meta[s.key] || {}).offset = s.offset; store.set('sourceMeta', S.meta); render(); } });
      box.appendChild(h('div', { class: 'src' },
        h('span', { class: 'swatch', style: 'background:' + seriesColor(s.slot) }),
        h('div', { class: 'body' }, label,
          h('div', { class: 'files', text: s.files.map(function (x) { return x.name; }).join(' · ') }),
          h('div', { class: 'meta' }, h('span', { class: 'tag', text: kindTag }), (s.files.length > 1 ? h('span', { class: 'tag', text: 'merged · shared clock' }) : null), desc + ' · ' + s.table.rows.toLocaleString() + ' rows' + (fin(a.sampleRate) ? ' · ' + a.sampleRate.toFixed(0) + ' Hz' : '')),
          h('div', { class: 'row' },
            h('button', { class: 'btn small', text: 'Columns (' + Object.keys(s.mapping).length + ')', onclick: function () { openMapping(s); } }),
            a.ok ? h('span', { class: 'dim', style: 'font-size:12px;display:inline-flex;align-items:center;gap:4px;margin-left:6px' }, 'offset', offIn, 's') : null,
            h('button', { class: 'btn ghost small', text: 'Remove', onclick: function () { var ids = s.files.map(function (x) { return x.id; }); S.files = S.files.filter(function (x) { return ids.indexOf(x.id) < 0; }); rebuild(); } })
          ))));
    });
  }
  function renderSettings() {
    var sel = $('#refSel'); sel.innerHTML = '';
    flightSources().filter(function (s) { return s.an.kind === 'flight'; }).forEach(function (s) { sel.appendChild(h('option', { value: s.key, text: s.label, selected: s.key === S.settings.ref })); });
    $('#target').value = S.settings.target; $('#groundTemp').value = S.settings.groundTemp;
  }
  function renderTab() {
    destroyCharts();
    $$('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });
    ['overview', 'plots', 'boards', 'events', 'gps', 'explore'].forEach(function (t) { $('#tab-' + t).classList.toggle('hidden', t !== S.tab); });
    var hasGps = S.sources.some(function (s) { return s.an.gps; });
    $('#tabs [data-tab=gps]').classList.toggle('hidden', !hasGps);
    var el = $('#tab-' + S.tab); el.innerHTML = '';
    ({ overview: renderOverview, plots: renderPlots, boards: renderBoards, events: renderEvents, gps: renderGps, explore: renderExplore })[S.tab](el);
  }
  function rangeControl() {
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
    [['boost', 'Boost'], ['ascent', 'Ascent'], ['flight', 'Whole flight'], ['full', 'Full log']].forEach(function (r) {
      seg.appendChild(h('button', { class: S.settings.range === r[0] ? 'on' : '', text: r[1], onclick: function () { S.settings.range = r[0]; renderTab(); } }));
    });
    return seg;
  }
  function toolbar(el, extras) {
    var bar = h('div', { class: 'settings', style: 'margin-top:0' }, rangeControl(), extras || null, h('span', { class: 'hint', text: 'Drag on a chart to zoom · double-click to reset' }));
    el.appendChild(bar);
  }

  /* ---------- Overview ---------- */
  function metricRows() {
    var gt = +S.settings.groundTemp;
    return [
      { k: 'Apogee (AGL)', u: 'm', d: 0, v: function (a) { return a.apogee; } },
      { k: 'Time to apogee', u: 's', d: 2, v: function (a) { return a.tApo - a.tLift; } },
      { k: 'Max velocity', u: 'm/s', d: 0, v: function (a) { return a.maxV; }, note: function (a) { return a.maxVName; } },
      { k: 'Max Mach', u: '', d: 2, v: function (a) { return a.mach; } },
      { k: 'Max velocity from pressure slope', u: 'm/s', d: 0, v: function (a) { return a.maxVBaro; } },
      { k: 'Max acceleration (net)', u: 'g', d: 1, v: function (a) { return a.maxAcc / G; }, note: function (a) { return a.accName; } },
      { k: 'Burnout', u: 's', d: 2, v: function (a) { return a.tBurn - a.tLift; }, pre: 'T+' },
      { k: 'Drogue descent rate', u: 'm/s', d: 1, v: function (a) { return a.desc && (a.desc.drogueRate || a.desc.singleRate); } },
      { k: 'Main canopy effective at', u: 's', d: 1, v: function (a) { return a.desc && a.desc.mainT - a.tLift; }, pre: 'T+' },
      { k: 'Main canopy altitude', u: 'm', d: 0, v: function (a) { return a.desc && a.desc.mainAlt; } },
      { k: 'Main descent rate', u: 'm/s', d: 1, v: function (a) { return a.desc && a.desc.mainRate; } },
      { k: 'Flight time (to landing)', u: 's', d: 1, v: function (a) { return a.tLand - a.tLift; } },
      { k: 'Landing drift (GPS)', u: 'm', d: 0, v: function (a) { return a.gps && a.gps.drift; } },
      { k: 'Sample rate', u: 'Hz', d: 0, v: function (a) { return a.sampleRate; } }
    ];
  }
  function spread(fn) {
    var vals = flightSources().map(function (s) { return fn(s.an); }).filter(fin);
    if (vals.length < 2) return null;
    return [Math.min.apply(null, vals), Math.max.apply(null, vals), vals.length];
  }
  function renderOverview(el) {
    var ref = refSource();
    if (!ref || !ref.an.ok) { el.appendChild(h('div', { class: 'card empty-state', text: 'No flight was detected in the loaded files. Open “Columns” on a board to check the detected channels.' })); renderNotes(el); return; }
    var a = ref.an, tiles = h('div', { class: 'tiles' });
    function tile(k, v, unit, d, sub, hero, fn) {
      var sp = fn ? spread(fn) : null;
      var subTxt = sub || '';
      if (sp && sp[1] - sp[0] > Math.pow(10, -d)) subTxt = (subTxt ? subTxt + ' · ' : '') + 'boards: ' + f(sp[0], d) + '–' + f(sp[1], d);
      tiles.appendChild(h('div', { class: 'tile' + (hero ? ' hero' : '') }, h('div', { class: 'k', text: k }), h('div', { class: 'v', html: (fin(v) ? esc(f(v, d)) : '—') + (unit && fin(v) ? '<small>' + unit + '</small>' : '') }), subTxt ? h('div', { class: 's', html: subTxt }) : null));
    }
    var tgt = parseFloat(S.settings.target), apoSub = 'at ' + fT(a.tApo - a.tLift);
    if (fin(tgt) && tgt > 0) { var dv = a.apogee - tgt; apoSub = '<span class="' + (Math.abs(dv) / tgt < 0.05 ? 'delta-pos' : 'delta-neg') + '">' + (dv >= 0 ? '+' : '−') + f(Math.abs(dv), 0) + ' m (' + (dv >= 0 ? '+' : '−') + f(Math.abs(dv / tgt * 100), 1) + ' %) vs target ' + f(tgt, 0) + ' m</span> · ' + apoSub; }
    tile('Apogee · ' + ref.label, a.apogee, 'm', 0, apoSub, true, function (x) { return x.apogee; });
    tile('Max velocity', a.maxV, 'm/s', 0, 'Mach ' + f(a.mach, 2) + ' at ' + fT(a.maxVT - a.tLift), false, function (x) { return x.maxV; });
    tile('Max acceleration', a.maxAcc / G, 'g', 1, 'net, at ' + fT(a.maxAccT - a.tLift), false, function (x) { return x.maxAcc / G; });
    tile('Burnout', a.tBurn - a.tLift, 's', 2, 'T+ · ' + (a.burnMethod || ''), false, function (x) { return x.tBurn - x.tLift; });
    tile('Drogue descent', a.desc && (a.desc.drogueRate || a.desc.singleRate), 'm/s', 1, a.desc && a.desc.singleRate ? 'single-stage descent' : 'median, apogee → main', false, function (x) { return x.desc && (x.desc.drogueRate || x.desc.singleRate); });
    tile('Main descent', a.desc && a.desc.mainRate, 'm/s', 1, a.desc && fin(a.desc.mainT) ? 'slows at ' + fT(a.desc.mainT - a.tLift) + ', ' + f(a.desc.mainAlt, 0) + ' m' : 'no main stage found', false, function (x) { return x.desc && x.desc.mainRate; });
    tile('Flight time', a.tLand - a.tLift, 's', 1, a.landMethod ? 'landing: ' + a.landMethod : 'landing not in log', false, function (x) { return x.tLand - x.tLift; });
    var gsrc = flightSources().find(function (s) { return s.an.gps && fin(s.an.gps.drift); });
    if (gsrc) tile('Landing drift', gsrc.an.gps.drift, 'm', 0, f(gsrc.an.gps.bearing, 0) + '° from pad · ' + esc(gsrc.label));
    el.appendChild(tiles);

    var grid = h('div', { class: 'grid2' }); el.appendChild(grid);
    chartCard(grid, 'Altitude', 'all boards · AGL', function (card) {
      return makeChart(card, { unit: 'm', series: altSeries(), range: currentRangeFor('flight'), events: eventMarkers({ logged: false }), height: 280, syncKey: 'ov' });
    });
    chartCard(grid, 'Vertical velocity', 'all boards', function (card) {
      return makeChart(card, { unit: 'm/s', series: velSeries(false), range: currentRangeFor('flight'), events: eventMarkers({ logged: false }), height: 280, syncKey: 'ov' });
    });

    // comparison table
    var fs = flightSources(), tbl = h('table', { class: 't' });
    tbl.appendChild(h('thead', null, h('tr', null, h('th', { text: 'Metric' }), fs.map(function (s) { return h('th', { class: 'n' }, h('span', { class: 'swatch', style: 'display:inline-block;margin:0 5px 0 0;vertical-align:0;background:' + seriesColor(s.slot) }), s.label); }))));
    var tb = h('tbody'); tbl.appendChild(tb);
    metricRows().forEach(function (m) {
      var vals = fs.map(function (s) { return m.v(s.an); });
      if (!vals.some(fin)) return;
      tb.appendChild(h('tr', null, h('td', { text: m.k }), vals.map(function (v, i) {
        var note = m.note ? m.note(fs[i].an) : null;
        return h('td', { class: 'n', title: note ? 'from ' + note : '' }, fin(v) ? (m.pre || '') + f(v, m.d) + (m.u ? ' ' + m.u : '') : h('span', { class: 'dim', text: '—' }));
      })));
    });
    var card = h('div', { class: 'card', style: 'margin-top:16px' }, h('h3', null, 'Board comparison', h('span', { class: 'sub', text: 'every value is computed independently from each board’s own data' })), h('div', { style: 'overflow-x:auto' }, tbl));
    el.appendChild(card);
    renderNotes(el);
  }
  function renderNotes(el) {
    var notes = [];
    S.sources.forEach(function (s) { (s.an.notes || []).forEach(function (n) { notes.push({ s: s, n: n }); }); });
    // cross-board checks
    var fs = flightSources().filter(function (s) { return fin(s.an.apogee); });
    if (fs.length > 1) {
      var ap = fs.map(function (s) { return s.an.apogee; }), mn = Math.min.apply(null, ap), mx = Math.max.apply(null, ap);
      notes.unshift({ s: null, n: { level: (mx - mn) / mx > 0.03 ? 'warn' : 'info', text: 'Apogee agrees within ' + f(mx - mn, 0) + ' m (' + f((mx - mn) / mx * 100, 1) + ' %) across ' + fs.length + ' boards.' } });
    }
    var card = h('div', { class: 'card' }, h('h3', null, 'Findings & data quality', h('span', { class: 'sub', text: notes.length + ' items' })));
    var list = h('div', { class: 'notes' });
    if (!notes.length) list.appendChild(h('div', { class: 'dim', text: 'No issues found.' }));
    notes.forEach(function (x) {
      list.appendChild(h('div', { class: 'note ' + x.n.level }, h('span', { class: 'ico', text: x.n.level === 'warn' ? '!' : 'i', 'aria-label': x.n.level === 'warn' ? 'Warning' : 'Info' }), h('div', null, x.s ? h('span', { class: 'who', text: x.s.label + ':' }) : null, x.n.text)));
    });
    card.appendChild(list); el.appendChild(card);
  }
  function currentRangeFor(name) { var old = S.settings.range; S.settings.range = name; var r = currentRange(); S.settings.range = old; return r; }

  function tpArray(s) { var L = lift(s), t = s.ch.t, o = new Float64Array(t.length); for (var i = 0; i < t.length; i++) o[i] = t[i] - L; return o; }
  function cachedTp(s) { var L = lift(s); if (!s._tp || s._tpL !== L) { s._tp = tpArray(s); s._tpL = L; } return s._tp; }
  function altSeries() {
    var out = [];
    flightSources().forEach(function (s) {
      var a = s.an; if (!a.series.alt) return;
      var y = new Float64Array(a.series.alt.length); for (var i = 0; i < y.length; i++) y[i] = a.series.alt[i] - a.ground;
      out.push({ label: s.label, color: seriesColor(s.slot), x: cachedTp(s), y: y });
    });
    return out;
  }
  function velSeries(derived) {
    var out = [];
    flightSources().forEach(function (s) {
      var a = s.an;
      if (a.series.v) out.push({ label: s.label + (s.ch.byRole.velocity ? '' : ' (pressure slope)'), color: seriesColor(s.slot), x: cachedTp(s), y: a.series.v });
      if (derived && s.ch.byRole.velocity && a.series.vBaro) out.push({ label: s.label + ' · pressure slope', color: seriesColor(s.slot), x: cachedTp(s), y: a.series.vBaro, dash: [4, 4], width: 1.2 });
      if (derived && a.series.vAcc) out.push({ label: s.label + ' · integrated accel', color: seriesColor(s.slot), x: cachedTp(s), y: a.series.vAcc, dash: [1, 3], width: 1.4 });
    });
    return out;
  }
  function accSeries() {
    var out = [];
    flightSources().forEach(function (s) {
      var a = s.an; if (!a.series.thr) return;
      var y = new Float64Array(a.series.thr.length); for (var i = 0; i < y.length; i++) y[i] = (a.series.thr[i] - G) / G;
      out.push({ label: s.label + ' · ' + a.accName, color: seriesColor(s.slot), x: cachedTp(s), y: y });
    });
    return out;
  }
  function roleSeries(role, transform) {
    var out = [];
    S.sources.forEach(function (s) {
      if (lift(s) == null) return;
      (s.ch.byRole[role] || []).forEach(function (c) { if (c.y) out.push({ label: s.label + ' · ' + c.name, color: seriesColor(s.slot), x: cachedTp(s), y: transform ? transform(c.y) : c.y }); });
    });
    // distinguish multiple series from the same board with dashes
    var seen = {}; out.forEach(function (o) { var k = o.color; if (seen[k]) o.dash = [[4, 3], [1, 3], [8, 3]][(seen[k] - 1) % 3]; seen[k] = (seen[k] || 0) + 1; });
    return out;
  }

  /* ---------- Flight plots ---------- */
  function renderPlots(el) {
    var cb = h('label', { style: 'display:inline-flex;gap:6px;align-items:center' }, h('input', { type: 'checkbox', checked: S.settings.showLogged, onchange: function (e) { S.settings.showLogged = e.target.checked; renderTab(); } }), 'Show logged events');
    var cb2 = h('label', { style: 'display:inline-flex;gap:6px;align-items:center' }, h('input', { type: 'checkbox', checked: S.settings.showDerived, onchange: function (e) { S.settings.showDerived = e.target.checked; renderTab(); } }), 'Show independent velocity estimates');
    toolbar(el, [cb, cb2]);
    var r = currentRange(), ev = eventMarkers();
    chartCard(el, 'Altitude above ground', 'per board, zeroed on the pad', function (c) { return makeChart(c, { unit: 'm', series: altSeries(), range: r, events: ev, syncKey: 'fp', height: 300 }); });
    chartCard(el, 'Vertical velocity', S.settings.showDerived ? 'solid: logged · dashed: pressure slope · dotted: integrated acceleration' : 'logged estimate, or pressure slope if the board logs none', function (c) { return makeChart(c, { unit: 'm/s', series: velSeries(S.settings.showDerived), range: r, events: ev, syncKey: 'fp', height: 280 }); });
    var acc = accSeries();
    if (acc.length) chartCard(el, 'Net vertical acceleration', 'gravity removed, in g', function (c) { return makeChart(c, { unit: 'g', series: acc, range: r, events: ev, syncKey: 'fp', height: 260 }); });
    var pr = roleSeries('pressure', function (y) { var o = new Float64Array(y.length); for (var i = 0; i < y.length; i++) o[i] = y[i] / 100; return o; });
    if (pr.length) chartCard(el, 'Static pressure', 'hPa', function (c) { return makeChart(c, { unit: 'hPa', series: pr, range: r, events: ev, syncKey: 'fp', height: 220 }); });
  }

  /* ---------- Board sensors ---------- */
  function renderBoards(el) {
    toolbar(el);
    var r = currentRange(), ev = eventMarkers({ logged: false });
    S.sources.forEach(function (s) {
      if (lift(s) == null) return;
      var x = cachedTp(s), ch = s.ch;
      var head = h('h2', { style: 'font-size:16px;margin:22px 0 10px;display:flex;align-items:center;gap:8px' }, h('span', { class: 'swatch', style: 'margin:0;background:' + seriesColor(s.slot) }), s.label);
      el.appendChild(head);
      var grid = h('div', { class: 'grid2' }); el.appendChild(grid);
      var any = false;
      function group(title, roles, unit, opts) {
        opts = opts || {};
        var ser = [];
        roles.forEach(function (role) { (ch.byRole[role] || []).forEach(function (c) { if (c.y) ser.push({ label: c.name, x: x, y: opts.tf ? opts.tf(c.y) : c.y, step: opts.step }); }); });
        if (!ser.length) return;
        ser.forEach(function (o, i) { o.color = seriesColor(i); });
        any = true;
        chartCard(grid, title, opts.sub || '', function (c) { return makeChart(c, { unit: unit, series: ser, range: r, events: ev, syncKey: 'b' + s.id, height: 220 }); });
      }
      var gtf = function (y) { var o = new Float64Array(y.length); for (var i = 0; i < y.length; i++) o[i] = y[i] / G; return o; };
      group('Body acceleration', ['accel_x', 'accel_y', 'accel_z'], 'g', { tf: gtf, sub: 'raw axes incl. gravity' });
      group('Vertical / earth-frame acceleration', ['accel_vertical', 'accel_h'], 'g', { tf: gtf });
      group('Rotation rate', ['gyro_x', 'gyro_y', 'gyro_z'], '°/s');
      group('Orientation quaternion', ['quat'], '');
      group('Horizontal velocity', ['velocity_h'], 'm/s');
      group('Temperature', ['temperature'], '°C', { sub: 'board sensors — usually not ambient' });
      group('Humidity', ['humidity'], '%');
      group('Battery', ['voltage'], 'V');
      group('Flight state', ['state'], '', { step: true });
      group('Pyro & output channels', ['output'], '', { step: true });
      group('Control / airbrake command', ['control'], '', { step: true });
      group('Status flags', ['flag'], '', { step: true });
      group('GPS satellites', ['sats'], '', { step: true });
      group('Other channels', ['other'], '');
      if (!any) grid.appendChild(h('div', { class: 'card dim', text: 'No extra sensor channels on this board.' }));
    });
  }

  /* ---------- Events ---------- */
  function renderEvents(el) {
    var hidePad = S.settings.hidePad !== false;
    var cb = h('label', { style: 'display:inline-flex;gap:6px;align-items:center' }, h('input', { type: 'checkbox', checked: hidePad, onchange: function (e) { S.settings.hidePad = e.target.checked; renderTab(); } }), 'Hide events more than 60 s before liftoff');
    el.appendChild(h('div', { class: 'settings', style: 'margin-top:0' }, cb, h('span', { class: 'hint', text: 'Detected = computed from sensor data · Logged = written by the flight computer' })));
    var tbl = h('table', { class: 't' }, h('thead', null, h('tr', null, h('th', { class: 'n', text: 'T+' }), h('th', { text: 'Board' }), h('th', { text: 'Event' }), h('th', { text: 'Source' }), h('th', { class: 'n', text: 'Altitude' }), h('th', { class: 'n', text: 'Velocity' }))));
    var tb = h('tbody'); tbl.appendChild(tb);
    allEvents().forEach(function (e) {
      if (hidePad && fin(e.t) && e.t < -60) return;
      var s = e.src, base = s.syncTo || s, alt = NaN, vel = NaN;
      if (base.an.ok && fin(e.t) && base.an.series.alt) {
        var tt = e.t + lift(base);
        alt = RL.valueAt(base.ch.t, base.an.series.altS || base.an.series.alt, tt) - base.an.ground;
        if (base.an.series.v) vel = RL.valueAt(base.ch.t, base.an.series.v, tt);
      }
      tb.appendChild(h('tr', null,
        h('td', { class: 'n', text: fin(e.t) ? (e.t >= 0 ? '+' : '−') + Math.abs(e.t).toFixed(2) : '—' }),
        h('td', null, h('span', { class: 'swatch', style: 'display:inline-block;margin:0 6px 0 0;vertical-align:0;background:' + seriesColor(s.slot) }), s.label),
        h('td', { text: e.label, title: e.how ? 'method: ' + e.how : '' }),
        h('td', null, h('span', { class: 'tag', text: e.kind === 'detected' ? 'detected' : 'logged' })),
        h('td', { class: 'n', text: f(alt, 0, 'm') }), h('td', { class: 'n', text: f(vel, 1, 'm/s') })));
    });
    el.appendChild(h('div', { class: 'card' }, h('div', { class: 'scroll' }, tbl)));
  }

  /* ---------- GPS ---------- */
  function renderGps(el) {
    S.sources.filter(function (s) { return s.an.gps; }).forEach(function (s) {
      var g = s.an.gps, L = lift(s);
      var card = h('div', { class: 'card' }, h('h3', null, h('span', { class: 'swatch', style: 'margin:0;background:' + seriesColor(s.slot) }), 'Ground track · ' + s.label, h('span', { class: 'sub', text: 'valid fixes only (≥4 satellites), from 30 s before liftoff to the first fix after landing' })));
      var cv = h('canvas', { class: 'track', role: 'img', 'aria-label': 'GPS ground track' });
      card.appendChild(h('div', { class: 'track-wrap' }, cv));
      var info = h('div', { class: 'tiles', style: 'margin:12px 0 0' }); card.appendChild(info);
      function t(k, v, s2) { info.appendChild(h('div', { class: 'tile' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', style: 'font-size:18px', html: v }), s2 ? h('div', { class: 's', html: s2 }) : null)); }
      if (g.pad) t('Pad', g.pad[0].toFixed(6) + ', ' + g.pad[1].toFixed(6), '<a href="https://www.google.com/maps?q=' + g.pad[0] + ',' + g.pad[1] + '" target="_blank" rel="noopener">Open in Google Maps</a>');
      if (g.landing) t('Landing (first fix after touchdown)', g.landing[0].toFixed(6) + ', ' + g.landing[1].toFixed(6), 'fix at ' + fT(g.landingFixT - L) + ' · <a href="https://www.google.com/maps?q=' + g.landing[0] + ',' + g.landing[1] + '" target="_blank" rel="noopener">Open in Google Maps</a>');
      if (fin(g.drift)) t('Drift', f(g.drift, 0) + '<small> m</small>', 'bearing ' + f(g.bearing, 0) + '° from the pad');
      if (g.outage) t('Longest fix outage', fT(g.outage.from - L), fin(g.outage.to) ? 'until ' + fT(g.outage.to - L) : 'until end of log');
      el.appendChild(card);
      requestAnimationFrame(function () { drawTrack(cv, s); });
    });
  }
  function drawTrack(cv, s) {
    var g = s.an.gps, L = lift(s), t = s.ch.t, dpr = devicePixelRatio || 1;
    var W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr;
    var ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    var a = RL.idxAtTime(t, L - 30), b = g.landingFixT ? RL.idxAtTime(t, g.landingFixT) : t.length - 1;
    var pts = [];
    var la0 = g.pad ? g.pad[0] : null, lo0 = g.pad ? g.pad[1] : null;
    for (var i = a; i <= b; i++) if (g.valid[i]) { if (la0 == null) { la0 = g.lat[i]; lo0 = g.lon[i]; } pts.push({ t: t[i] - L, x: (g.lon[i] - lo0) * 111320 * Math.cos(la0 * Math.PI / 180), y: (g.lat[i] - la0) * 110540 }); }
    ctx.fillStyle = cssVar('--text-muted'); ctx.font = '12px ' + cssVar('--sans');
    if (!pts.length) { ctx.fillText('No valid GPS fixes in this window.', 16, 24); return; }
    var mnx = 0, mxx = 0, mny = 0, mxy = 0;
    pts.forEach(function (p) { mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x); mny = Math.min(mny, p.y); mxy = Math.max(mxy, p.y); });
    var span = Math.max(mxx - mnx, mxy - mny, 50) * 1.2, sc = Math.min(W, H) / span, cx = W / 2 - (mnx + mxx) / 2 * sc, cy = H / 2 + (mny + mxy) / 2 * sc;
    function X(p) { return cx + p.x * sc; } function Y(p) { return cy - p.y * sc; }
    // grid rings every nice distance
    var step = [50, 100, 200, 250, 500, 1000, 2000, 5000].find(function (s2) { return span / s2 < 8; }) || 10000;
    ctx.strokeStyle = cssVar('--grid'); ctx.lineWidth = 1;
    for (var rr = step; rr < span * 1.5; rr += step) { ctx.beginPath(); ctx.arc(cx, cy, rr * sc, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = cssVar('--text-muted'); ctx.fillText('rings every ' + step + ' m · north up', 12, H - 12);
    var col = seriesColor(s.slot);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach(function (p, i) { if (i && Math.abs(p.t - pts[i - 1].t) > 5) { ctx.stroke(); ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(X(pts[i - 1]), Y(pts[i - 1])); ctx.lineTo(X(p), Y(p)); ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(X(p), Y(p)); } else if (i) ctx.lineTo(X(p), Y(p)); else ctx.moveTo(X(p), Y(p)); });
    ctx.stroke();
    function mark(p, label, fill) { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(X(p), Y(p), 5, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = cssVar('--surface-2'); ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = cssVar('--text-primary'); ctx.fillText(label, X(p) + 8, Y(p) - 8); }
    mark({ x: 0, y: 0 }, 'Pad', cssVar('--text-primary'));
    if (g.landing) { var lp = { x: (g.landing[1] - lo0) * 111320 * Math.cos(la0 * Math.PI / 180), y: (g.landing[0] - la0) * 110540 }; mark(lp, 'Landing · ' + f(g.drift, 0) + ' m', col); }
    ctx.fillStyle = cssVar('--text-muted'); ctx.fillText('dashed = no fix in between', W - 170, H - 12);
  }

  /* ---------- Explorer ---------- */
  function renderExplore(el) {
    toolbar(el);
    var card = h('div', { class: 'card' }, h('h3', null, 'Pick channels to plot', h('span', { class: 'sub', text: 'channels with different units get separate charts' })));
    var picker = h('div', { class: 'picker' });
    S.sources.forEach(function (s) {
      if (lift(s) == null) return;
      s.ch.list.forEach(function (c) {
        if (!c.y) return;
        var key = s.key + '::' + c.name, on = !!S.explorerSel[key];
        picker.appendChild(h('span', { class: 'pick' + (on ? ' on' : ''), role: 'checkbox', 'aria-checked': on ? 'true' : 'false', tabindex: '0', onclick: function () { if (S.explorerSel[key]) delete S.explorerSel[key]; else S.explorerSel[key] = 1; renderTab(); } },
          h('span', { class: 'sw', style: 'background:' + seriesColor(s.slot) }), s.label + ' · ' + c.name, h('span', { class: 'dim', text: ' ' + (RL.ROLES[c.role] ? RL.ROLES[c.role].label : c.role) })));
      });
    });
    card.appendChild(picker); el.appendChild(card);
    var groups = {}, r = currentRange();
    Object.keys(S.explorerSel).forEach(function (key) {
      var p = key.split('::'), s = S.sources.find(function (x) { return x.key === p[0]; }); if (!s) return;
      var c = s.ch.list.find(function (x) { return x.name === p[1]; }); if (!c || !c.y) return;
      var u = c.unit || '(no unit)'; (groups[u] = groups[u] || []).push({ label: s.label + ' · ' + c.name, x: cachedTp(s), y: c.y, slot: s.slot });
    });
    Object.keys(groups).forEach(function (u) {
      var ser = groups[u]; ser.forEach(function (o, i) { o.color = seriesColor(ser.length > 1 && ser.every(function (q) { return q.slot === ser[0].slot; }) ? i : o.slot); });
      var seen = {}; ser.forEach(function (o) { if (seen[o.color]) o.dash = [4, 3]; seen[o.color] = 1; });
      chartCard(el, u === '(no unit)' ? 'Unitless channels' : 'Channels in ' + u, '', function (c) { return makeChart(c, { unit: u === '(no unit)' ? '' : u, series: ser, range: r, events: eventMarkers({ logged: false }), syncKey: 'ex', height: 280 }); });
    });
    if (!Object.keys(groups).length) el.appendChild(h('div', { class: 'card empty-state', text: 'Select one or more channels above.' }));
  }

  /* ------------------------------------------------------------------ */
  /* Column mapping editor                                               */
  /* ------------------------------------------------------------------ */
  function openMapping(src) {
    var back = h('div', { class: 'modal-back', onclick: function (e) { if (e.target === back) back.remove(); } });
    var content = h('div', { class: 'content' });
    var edits = {};
    src.files.forEach(function (fl) {
      edits[fl.id] = {};
      content.appendChild(h('h4', { style: 'margin:8px 0', text: fl.name + ' · ' + fl.table.rows.toLocaleString() + ' rows' }));
      var tbl = h('table', { class: 't' }, h('thead', null, h('tr', null, h('th', { text: 'Column' }), h('th', { text: 'Range in file' }), h('th', { text: 'Detected as' }), h('th', { text: 'Unit' }), h('th', { text: 'Extra' }), h('th', { text: 'Why' }))));
      var tb = h('tbody'); tbl.appendChild(tb);
      fl.table.columns.forEach(function (c) {
        var m = Object.assign({}, fl.mapping[c.name]); edits[fl.id][c.name] = m;
        var st = c.data ? (c.stats || RL.stats(c.data)) : null;
        var rangeTxt = st ? (fmtNum(st.min) + ' … ' + fmtNum(st.max)) : 'text: ' + (c.text.find(function (x) { return x; }) || '').slice(0, 24);
        var unitSel = h('select');
        function fillUnits() { unitSel.innerHTML = ''; (RL.ROLES[m.role] || { units: [''] }).units.forEach(function (u) { unitSel.appendChild(h('option', { value: u, text: u || '—', selected: u === m.unit })); }); if ((RL.ROLES[m.role] || { units: [''] }).units.indexOf(m.unit) < 0) m.unit = unitSel.value; }
        var roleSel = h('select', { onchange: function (e) { m.role = e.target.value; fillUnits(); fillExtra(); } });
        Object.keys(RL.ROLES).forEach(function (r) { roleSel.appendChild(h('option', { value: r, text: RL.ROLES[r].label, selected: r === m.role })); });
        unitSel.addEventListener('change', function (e) { m.unit = e.target.value; });
        fillUnits();
        var extra = h('div');
        function fillExtra() {
          extra.innerHTML = '';
          if (/^accel/.test(m.role)) {
            var gs = h('select', { onchange: function (e) { m.gravity = e.target.value; }, title: 'Does this channel read +1 g when the rocket sits on the pad?' });
            [['included', 'incl. gravity'], ['removed', 'gravity removed']].forEach(function (o) { gs.appendChild(h('option', { value: o[0], text: o[1], selected: m.gravity === o[0] })); });
            extra.appendChild(gs);
          }
          if (m.role === 'state') {
            var cur = fl.stateNames[c.name] || {}, txt = Object.keys(cur).map(function (k) { return k + '=' + cur[k]; }).join(', ');
            var vals = st && st.uniqVals ? st.uniqVals.join(', ') : '';
            extra.appendChild(h('input', { style: 'width:220px', placeholder: 'names, e.g. 1=Pad, 3=Boost (values: ' + vals + ')', value: txt, onchange: function (e) { m._stateNames = e.target.value; } }));
          }
        }
        fillExtra();
        tb.appendChild(h('tr', null, h('td', { class: 'mono', text: c.name }), h('td', { class: 'mono dim', style: 'font-size:12px', text: rangeTxt }), h('td', null, roleSel), h('td', null, unitSel), h('td', null, extra), h('td', null, h('span', { class: 'conf ' + (m.conf || 'low'), text: m.conf || 'low' }), ' ', h('span', { class: 'dim', style: 'font-size:12px', text: m.reason || '' }))));
      });
      content.appendChild(h('div', { style: 'overflow-x:auto' }, tbl));
    });
    function apply(remember) {
      src.files.forEach(function (fl) {
        var e = edits[fl.id];
        Object.keys(e).forEach(function (k) {
          var m = e[k];
          if (m._stateNames !== undefined) {
            var o = {}; m._stateNames.split(/[,;]/).forEach(function (p) { var q = p.split('='); if (q.length === 2 && q[0].trim() !== '') o[+q[0].trim()] = q[1].trim(); });
            fl.stateNames[k] = o; delete m._stateNames;
          }
          fl.mapping[k] = m;
        });
        if (remember) {
          var ps = profiles(), pm = {};
          Object.keys(fl.mapping).forEach(function (k) { pm[k] = { role: fl.mapping[k].role, unit: fl.mapping[k].unit, gravity: fl.mapping[k].gravity }; });
          ps[headerSig(fl.table)] = { name: fl.name, label: src.label, mapping: pm, stateNames: fl.stateNames, saved: new Date().toISOString() };
          store.set('profiles', ps);
        }
      });
      back.remove(); rebuild();
      if (remember) toast('Saved — files with the same columns will load with this setup.');
    }
    back.appendChild(h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Column mapping' },
      h('header', null, h('h2', { text: 'Columns · ' + src.label }), h('button', { class: 'btn ghost small', text: '✕', onclick: function () { back.remove(); } })),
      content,
      h('footer', null, h('span', { class: 'hint', style: 'margin-right:auto', text: 'Fix any wrong guesses; analysis re-runs instantly.' }),
        h('button', { class: 'btn', text: 'Cancel', onclick: function () { back.remove(); } }),
        h('button', { class: 'btn', text: 'Apply', onclick: function () { apply(false); } }),
        h('button', { class: 'btn primary', text: 'Apply & remember this layout', onclick: function () { apply(true); } }))));
    document.body.appendChild(back);
  }
  function fmtNum(v) { if (!fin(v)) return '—'; var a = Math.abs(v); return a >= 1e6 || (a < 0.01 && a > 0) ? v.toExponential(2) : a >= 100 ? v.toFixed(0) : v.toFixed(2); }

  function openProfiles() {
    var ps = profiles(), keys = Object.keys(ps);
    var back = h('div', { class: 'modal-back', onclick: function (e) { if (e.target === back) back.remove(); } });
    var ta = h('textarea', { style: 'width:100%;height:160px;font-family:var(--mono);font-size:12px', placeholder: 'Paste a profiles JSON here to import' });
    ta.value = keys.length ? JSON.stringify(ps, null, 1) : '';
    var list = h('div');
    if (!keys.length) list.appendChild(h('p', { class: 'dim', text: 'No saved profiles yet. Open “Columns” on a board and choose “Apply & remember this layout”.' }));
    keys.forEach(function (k) { list.appendChild(h('div', { class: 'note info', style: 'margin-bottom:6px' }, h('div', { style: 'flex:1' }, h('b', { text: ps[k].label || ps[k].name }), h('div', { class: 'dim', style: 'font-size:12px', text: k.split('|').length + ' columns · from ' + ps[k].name })), h('button', { class: 'btn ghost small', text: 'Delete', onclick: function () { delete ps[k]; store.set('profiles', ps); back.remove(); openProfiles(); } }))); });
    back.appendChild(h('div', { class: 'modal', style: 'width:min(720px,100%)' },
      h('header', null, h('h2', { text: 'Board profiles' }), h('button', { class: 'btn ghost small', text: '✕', onclick: function () { back.remove(); } })),
      h('div', { class: 'content' }, h('p', { class: 'dim', style: 'margin-top:0', text: 'A profile remembers your column corrections and state names for one file layout. Profiles live in this browser — copy the JSON to share them with your team.' }), list, ta),
      h('footer', null,
        h('button', { class: 'btn', text: 'Copy JSON', onclick: function () { navigator.clipboard.writeText(ta.value).then(function () { toast('Copied'); }, function () { ta.select(); toast('Select-all done — press Ctrl+C'); }); } }),
        h('button', { class: 'btn primary', text: 'Import pasted JSON', onclick: function () { try { var o = JSON.parse(ta.value); store.set('profiles', Object.assign(profiles(), o)); toast('Imported ' + Object.keys(o).length + ' profiles'); back.remove(); } catch (e) { toast('That is not valid JSON'); } } }))));
    document.body.appendChild(back);
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                              */
  /* ------------------------------------------------------------------ */
  var downloadsCap = null, sampleCap = null;
  function summaryCSV() {
    var fs = flightSources(), rows = [['Metric', 'Unit'].concat(fs.map(function (s) { return s.label; }))];
    metricRows().forEach(function (m) { rows.push([m.k, m.u].concat(fs.map(function (s) { var v = m.v(s.an); return fin(v) ? v.toFixed(m.d) : ''; }))); });
    rows.push([]); rows.push(['Events']); rows.push(['T+ (s)', 'Board', 'Event', 'Type']);
    allEvents().forEach(function (e) { if (fin(e.t) && e.t > -60) rows.push([e.t.toFixed(2), e.src.label, e.label, e.kind]); });
    rows.push([]); rows.push(['Findings']);
    S.sources.forEach(function (s) { (s.an.notes || []).forEach(function (n) { rows.push([s.label, n.text]); }); });
    return rows.map(function (r) { return r.map(function (c) { c = String(c == null ? '' : c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(','); }).join('\n');
  }
  function fileBase() { return ($('#launchName').value || 'flight').replace(/[^\w\-]+/g, '_').slice(0, 60); }
  async function exportSummary() {
    var csv = summaryCSV();
    if (downloadsCap) {
      try { await downloadsCap.save({ filename: fileBase() + '_summary.csv', data: new Blob([csv], { type: 'text/csv' }) }); return; } catch (e) { if (e && e.code === 'cancelled') return; }
    }
    try { await navigator.clipboard.writeText(csv); toast('Summary copied to the clipboard as CSV'); } catch (e) { toast('Could not export here'); }
  }
  function downloadCanvas(u, title) {
    if (!downloadsCap) return;
    var src = u.ctx.canvas, c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    var x = c.getContext('2d'); x.fillStyle = cssVar('--surface-1'); x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0);
    c.toBlob(function (b) { downloadsCap.save({ filename: fileBase() + '_' + title.replace(/[^\w]+/g, '_') + '.png', data: b }).catch(function () { }); }, 'image/png');
  }

  /* ------------------------------------------------------------------ */
  /* Claude assistant                                                    */
  /* ------------------------------------------------------------------ */
  var chat = { history: [], busy: false, abort: null };
  function findChannel(source, channel) {
    var s = S.sources.find(function (x) { return x.label.toLowerCase() === String(source).toLowerCase(); }) || S.sources.find(function (x) { return x.label.toLowerCase().indexOf(String(source).toLowerCase()) >= 0; });
    if (!s) throw new Error('Unknown board "' + source + '". Boards: ' + S.sources.map(function (x) { return x.label; }).join(', '));
    var special = { altitude_agl: function () { var a = s.an.series.alt; if (!a) return null; var o = new Float64Array(a.length); for (var i = 0; i < a.length; i++) o[i] = a[i] - s.an.ground; return { y: o, unit: 'm' }; }, velocity: function () { return s.an.series.v ? { y: s.an.series.v, unit: 'm/s' } : null; }, net_accel_g: function () { var a = s.an.series.thr; if (!a) return null; var o = new Float64Array(a.length); for (var i = 0; i < a.length; i++) o[i] = (a[i] - G) / G; return { y: o, unit: 'g' }; } };
    if (special[channel]) { var r = special[channel](); if (!r) throw new Error('Board has no ' + channel); return { s: s, y: r.y, unit: r.unit, name: channel }; }
    var c = s.ch.list.find(function (x) { return x.name === channel; }) || s.ch.list.find(function (x) { return x.name.toLowerCase() === String(channel).toLowerCase(); });
    if (!c || !c.y) throw new Error('Unknown channel "' + channel + '" on ' + s.label + '. Use list_channels.');
    return { s: s, y: c.y, unit: c.unit, name: c.name };
  }
  function contextSummary() {
    var o = { launch: $('#launchName').value || null, target_apogee_m: parseFloat(S.settings.target) || null, ground_temp_c: +S.settings.groundTemp, reference_board: refSource() ? refSource().label : null, boards: [] };
    S.sources.forEach(function (s) {
      var a = s.an, L = lift(s), b = { name: s.label, files: s.files.map(function (x) { return x.name; }), type: s.kind, rows: s.table.rows, sample_rate_hz: a.sampleRate ? +a.sampleRate.toFixed(1) : null };
      if (s.syncTo) b.synced_to = s.syncTo.label;
      if (a.ok) {
        var r = function (x, d) { return fin(x) ? +x.toFixed(d) : null; };
        b.metrics = { liftoff_method: a.liftMethod, apogee_m_agl: r(a.apogee, 1), t_apogee: r(a.tApo - L, 2), max_velocity_mps: r(a.maxV, 1), max_velocity_source: a.maxVName, t_max_velocity: r(a.maxVT - L, 2), max_velocity_from_pressure_slope_mps: r(a.maxVBaro, 1), mach: r(a.mach, 3), max_net_accel_g: r(a.maxAcc / G, 2), accel_source: a.accName, t_burnout: r(a.tBurn - L, 2), burnout_method: a.burnMethod, drogue_rate_mps: a.desc ? r(a.desc.drogueRate || a.desc.singleRate, 1) : null, main_canopy_effective_t: a.desc ? r(a.desc.mainT - L, 1) : null, main_canopy_alt_m: a.desc ? r(a.desc.mainAlt, 0) : null, main_rate_mps: a.desc ? r(a.desc.mainRate, 1) : null, t_landing: r(a.tLand - L, 1), landing_method: a.landMethod, pad_pressure_pa: r(a.padPressure, 0) };
        if (a.gps) b.gps = { pad: a.gps.pad, landing: a.gps.landing, drift_m: r(a.gps.drift, 0), bearing_deg: r(a.gps.bearing, 0) };
        b.findings = a.notes.map(function (n) { return n.text; });
      }
      b.channels = s.ch.list.filter(function (c) { return c.y; }).map(function (c) { return c.name + ' [' + c.role + (c.unit ? ', ' + c.unit : '') + ']'; });
      o.boards.push(b);
    });
    o.events = allEvents().filter(function (e) { return fin(e.t) && e.t > -60; }).slice(0, 120).map(function (e) { return { t: +e.t.toFixed(2), board: e.src.label, event: e.label, type: e.kind }; });
    return o;
  }
  var SYSTEM = 'You are the flight-data analyst built into "Flight Log Lab", a web app a student rocketry team uses to analyse launch logs (e.g. EuRoC). ' +
    'Below is the current analysis the app computed (JSON). Times are T+ seconds from each board\'s detected liftoff; altitudes are metres above the pad. ' +
    'Use the tools to read exact values instead of guessing — never invent numbers. Channel names are as listed; special channels available on every flight board: altitude_agl, velocity, net_accel_g. ' +
    'When a plot would help, call plot_channels (it draws in the chat). Explain physics plainly (burnout, drag, Mach, recovery, airbrakes, sensor saturation, Kalman bias). ' +
    'Be concise: short paragraphs or bullets, markdown allowed, cite board names and T+ times. If data cannot answer the question, say so and suggest what to log next time.';
  var TOOLS = [
    { name: 'list_channels', description: 'List boards and all their channels with role, unit and min/max over the flight window.', inputSchema: { type: 'object', properties: {} }, execute: function () {
      return S.sources.map(function (s) { var L = lift(s); var a = L == null ? 0 : RL.idxAtTime(s.ch.t, L - 5), b = L == null ? s.ch.t.length - 1 : RL.idxAtTime(s.ch.t, (fin(s.an.tLand) ? s.an.tLand : L + 300) + 5); return { board: s.label, aligned: L != null, channels: s.ch.list.filter(function (c) { return c.y; }).map(function (c) { var mn = Infinity, mx = -Infinity; for (var i = a; i <= b; i++) { var v = c.y[i]; if (fin(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } } return { name: c.name, role: c.role, unit: c.unit, min: fin(mn) ? +mn.toPrecision(5) : null, max: fin(mx) ? +mx.toPrecision(5) : null }; }) }; });
    } },
    { name: 'get_series', description: 'Get time series samples of one channel between two T+ times, downsampled to at most `points` samples (default 60, max 300).', inputSchema: { type: 'object', properties: { board: { type: 'string' }, channel: { type: 'string' }, t_from: { type: 'number' }, t_to: { type: 'number' }, points: { type: 'number' } }, required: ['board', 'channel', 't_from', 't_to'] }, execute: function (inp) {
      var c = findChannel(inp.board, inp.channel), L = lift(c.s); if (L == null) throw new Error('Board not aligned to liftoff');
      var t = c.s.ch.t, a = RL.idxAtTime(t, inp.t_from + L), b = RL.idxAtTime(t, inp.t_to + L), n = Math.min(300, inp.points || 60), step = Math.max(1, Math.ceil((b - a + 1) / n)), out = [];
      for (var i = a; i <= b; i += step) out.push([+(t[i] - L).toFixed(3), fin(c.y[i]) ? +c.y[i].toPrecision(6) : null]);
      return { board: c.s.label, channel: c.name, unit: c.unit, columns: ['t_plus_s', 'value'], samples: out };
    } },
    { name: 'get_stats', description: 'Min, max (with T+ times), mean and first/last value of a channel between two T+ times.', inputSchema: { type: 'object', properties: { board: { type: 'string' }, channel: { type: 'string' }, t_from: { type: 'number' }, t_to: { type: 'number' } }, required: ['board', 'channel', 't_from', 't_to'] }, execute: function (inp) {
      var c = findChannel(inp.board, inp.channel), L = lift(c.s); var t = c.s.ch.t, a = RL.idxAtTime(t, inp.t_from + L), b = RL.idxAtTime(t, inp.t_to + L);
      var mn = Infinity, mx = -Infinity, mnT, mxT, s = 0, n = 0;
      for (var i = a; i <= b; i++) { var v = c.y[i]; if (!fin(v)) continue; n++; s += v; if (v < mn) { mn = v; mnT = t[i] - L; } if (v > mx) { mx = v; mxT = t[i] - L; } }
      return { board: c.s.label, channel: c.name, unit: c.unit, samples: n, min: mn, t_min: mnT, max: mx, t_max: mxT, mean: n ? s / n : null, first: c.y[a], last: c.y[b] };
    } },
    { name: 'plot_channels', description: 'Draw a line chart in the chat. Use the same unit for all series (one y axis).', inputSchema: { type: 'object', properties: { title: { type: 'string' }, t_from: { type: 'number' }, t_to: { type: 'number' }, series: { type: 'array', items: { type: 'object', properties: { board: { type: 'string' }, channel: { type: 'string' } }, required: ['board', 'channel'] } } }, required: ['series', 't_from', 't_to'] }, execute: function (inp) {
      var ser = inp.series.map(function (q, i) { var c = findChannel(q.board, q.channel); return { label: c.s.label + ' · ' + c.name, color: seriesColor(inp.series.length > 1 && inp.series.every(function (z) { return z.board === inp.series[0].board; }) ? i : c.s.slot), x: cachedTp(c.s), y: c.y, unit: c.unit }; });
      var box = h('div', { class: 'msg bot', style: 'max-width:100%;width:100%' }, h('div', { style: 'font-weight:600;font-size:12.5px;margin-bottom:4px', text: inp.title || 'Plot' }));
      $('#chatLog').appendChild(box);
      makeChart(box, { unit: ser[0].unit, series: ser, range: [inp.t_from, inp.t_to], events: eventMarkers({ logged: false }), height: 200 });
      scrollChat();
      return { ok: true, drawn: ser.map(function (s) { return s.label; }) };
    } }
  ];
  function md(text) {
    var lines = esc(text).split('\n'), out = [], list = null, tbl = null;
    function inline(s) { return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>'); }
    function flush() { if (list) { out.push('<' + list.t + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.t + '>'); list = null; } if (tbl) { out.push('<table>' + tbl.map(function (r, i) { return '<tr>' + r.map(function (c) { return (i ? '<td>' : '<th>') + inline(c) + (i ? '</td>' : '</th>'); }).join('') + '</tr>'; }).join('') + '</table>'); tbl = null; } }
    lines.forEach(function (l) {
      var m;
      if (/^\s*\|.*\|\s*$/.test(l)) { if (/^\s*\|[\s:\-|]+\|\s*$/.test(l)) return; if (list) flush(); tbl = tbl || []; tbl.push(l.trim().slice(1, -1).split('|').map(function (c) { return c.trim(); })); return; }
      if ((m = /^\s*[-*•]\s+(.*)/.exec(l))) { if (tbl || (list && list.t !== 'ul')) flush(); list = list || { t: 'ul', items: [] }; list.items.push(m[1]); return; }
      if ((m = /^\s*\d+[.)]\s+(.*)/.exec(l))) { if (tbl || (list && list.t !== 'ol')) flush(); list = list || { t: 'ol', items: [] }; list.items.push(m[1]); return; }
      flush();
      if ((m = /^#{1,4}\s+(.*)/.exec(l))) { out.push('<p><b>' + inline(m[1]) + '</b></p>'); return; }
      if (l.trim()) out.push('<p>' + inline(l) + '</p>');
    });
    flush();
    return out.join('');
  }
  function scrollChat() { var l = $('#chatLog'); l.scrollTop = l.scrollHeight; }
  function addMsg(role, text) { var m = h('div', { class: 'msg ' + role }); if (role === 'bot') m.innerHTML = md(text); else m.textContent = text; $('#chatLog').appendChild(m); scrollChat(); return m; }
  function updateSuggestions() {
    var box = $('#chatSuggest'); box.innerHTML = '';
    if (chat.history.length) return;
    var qs = ['Summarise this flight for our EuRoC report', 'Why do the boards disagree on max velocity?', 'Plot altitude from all boards during ascent', 'Did anything go wrong during recovery?'];
    if (S.sources.some(function (s) { return s.ch.byRole.control; })) qs.splice(2, 0, 'How did the airbrakes behave?');
    qs.forEach(function (q) { box.appendChild(h('button', { text: q, onclick: function () { $('#chatInput').value = q; sendChat(); } })); });
  }
  async function sendChat() {
    var inp = $('#chatInput'), text = inp.value.trim();
    if (!text || chat.busy || !sampleCap) return;
    inp.value = ''; $('#chatSuggest').innerHTML = '';
    addMsg('user', text);
    var first = !chat.history.length;
    chat.history.push({ role: 'user', content: first ? SYSTEM + '\n\nCURRENT ANALYSIS:\n' + JSON.stringify(contextSummary()) + '\n\nQUESTION: ' + text : text });
    var bot = addMsg('bot', 'Thinking…'); chat.busy = true; $('#chatSend').disabled = true;
    chat.abort = new AbortController();
    var tools = TOOLS.map(function (tl) { return { name: tl.name, description: tl.description, inputSchema: tl.inputSchema, execute: async function (input) { var note = h('div', { class: 'msg tool', text: '↳ ' + tl.name + (input && input.channel ? ' · ' + input.board + ' / ' + input.channel : '') }); $('#chatLog').insertBefore(note, bot); try { return tl.execute(input || {}); } catch (e) { note.textContent += ' — ' + e.message; throw e; } } }; });
    try {
      var res = await sampleCap(chat.history, { tools: tools, signal: chat.abort.signal, cache: false, onText: function (p) { bot.innerHTML = md(p.text || 'Thinking…'); $('#chatLog').appendChild(bot); scrollChat(); } });
      bot.innerHTML = md(res.text || '(no answer)'); $('#chatLog').appendChild(bot);
      chat.history.push({ role: 'assistant', content: res.text || '' });
    } catch (e) {
      chat.history.pop();
      if (e && e.code === 'not_granted') { bot.innerHTML = md('The assistant was not allowed to run. You can enable it when prompted next time.'); }
      else if (e && e.code === 'rate_limited') bot.innerHTML = md('Too many requests right now — please wait a moment and try again.');
      else bot.innerHTML = md('Sorry, that failed: ' + ((e && e.message) || e));
    }
    chat.busy = false; $('#chatSend').disabled = false; scrollChat();
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */
  var drop = $('#drop'), fi = $('#fileInput');
  drop.addEventListener('click', function () { fi.click(); });
  drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  $('#addFilesBtn').addEventListener('click', function () { fi.click(); });
  fi.addEventListener('change', function () { addFiles(fi.files); fi.value = ''; });
  ['dragenter', 'dragover'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('drag'); }); });
  document.addEventListener('drop', function (e) { drop.classList.remove('drag'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  $('#tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; S.tab = b.dataset.tab; renderTab(); });
  $('#target').addEventListener('change', function (e) { S.settings.target = e.target.value; store.set('target', e.target.value); renderTab(); });
  $('#groundTemp').addEventListener('change', function (e) { S.settings.groundTemp = +e.target.value || 15; store.set('groundTemp', S.settings.groundTemp); S.sources.forEach(analyzeSource); render(); });
  $('#refSel').addEventListener('change', function (e) { S.settings.ref = e.target.value; renderTab(); });
  $('#clearBtn').addEventListener('click', function () { S.files = []; S.sources = []; chat.history = []; $('#chatLog').innerHTML = ''; document.body.classList.remove('chat-open'); render(); });
  $('#exportBtn').addEventListener('click', exportSummary);
  $('#profilesBtn').addEventListener('click', openProfiles);
  $('#launchName').value = store.get('launchName', '');
  $('#launchName').addEventListener('change', function (e) { store.set('launchName', e.target.value); });
  $('#chatFab').addEventListener('click', function () { document.body.classList.add('chat-open'); updateSuggestions(); setTimeout(function () { $('#chatInput').focus(); window.dispatchEvent(new Event('resize')); }, 220); });
  $('#chatClose').addEventListener('click', function () { document.body.classList.remove('chat-open'); });
  $('#chatClear').addEventListener('click', function () { if (chat.abort) chat.abort.abort(); chat.history = []; $('#chatLog').innerHTML = ''; updateSuggestions(); });
  $('#chatSend').addEventListener('click', sendChat);
  $('#chatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  $('#chatInput').addEventListener('input', function (e) { e.target.style.height = 'auto'; e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px'; });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (S.sources.length) renderTab(); });

  // capabilities (only present when published as an artifact)
  if (window.claude && window.claude.use) {
    window.claude.use('sample').then(function (s) { sampleCap = s; if (S.sources.length) render(); }).catch(function () { });
    window.claude.use('downloads').then(function (d) { downloadsCap = d; if (S.sources.length) render(); }).catch(function () { });
  }
  window.__FLL = { S: S, addFiles: addFiles, rebuild: rebuild, contextSummary: contextSummary, TOOLS: TOOLS };
})();
