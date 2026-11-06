/* Flight Log Lab — OpenRocket (.ork) import. No DOM; runs in the browser and in Node 22+ (node test-openrocket.js file.ork). */
var ORK = (function () {
  'use strict';
  var G = 9.80665;
  function fin(x) { return typeof x === 'number' && isFinite(x); }
  function num(s) { if (s == null) return NaN; var m = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(String(s)); return m ? +m[0] : NaN; }
  function decode(s) { return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
  function tag(xml, name) { var m = new RegExp('<' + name + '(?:\\s[^>]*)?>([^<]*)</' + name + '>').exec(xml); return m ? decode(m[1]) : null; }
  function attrs(s) { var o = {}, re = /([\w:-]+)="([^"]*)"/g, m; while ((m = re.exec(s))) o[m[1]] = decode(m[2]); return o; }
  function median(a) { var b = a.filter(fin).sort(function (x, y) { return x - y; }), n = b.length; return n ? (n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2) : NaN; }

  /* ---------- file container: ZIP (normal .ork), gzip (old .ork) or plain XML ---------- */
  async function inflate(bytes, format) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function unpack(buf) {
    var b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), dec = new TextDecoder('utf-8');
    if (b[0] === 0x50 && b[1] === 0x4b) { // ZIP: read the central directory, take the rocket XML
      var e = b.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
      if (e < 0) throw new Error('Damaged .ork (ZIP) file');
      var n = dv.getUint16(e + 10, true), p = dv.getUint32(e + 16, true), pick = null;
      for (var i = 0; i < n; i++) {
        var method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), fl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
        var name = dec.decode(b.subarray(p + 46, p + 46 + fl));
        if (/\.(ork|xml)$/i.test(name) && (!pick || /rocket\.ork$/i.test(name))) pick = { method: method, csize: csize, lo: lo };
        p += 46 + fl + xl + cl;
      }
      if (!pick) throw new Error('No rocket design found inside the .ork file');
      var start = pick.lo + 30 + dv.getUint16(pick.lo + 26, true) + dv.getUint16(pick.lo + 28, true), data = b.subarray(start, start + pick.csize);
      if (pick.method === 8) data = await inflate(data, 'deflate-raw'); else if (pick.method !== 0) throw new Error('Unsupported compression in .ork file');
      return dec.decode(data);
    }
    if (b[0] === 0x1f && b[1] === 0x8b) return dec.decode(await inflate(b, 'gzip'));
    return dec.decode(b);
  }

  /* ---------- design + simulations ---------- */
  function parse(xml) {
    if (!/<openrocket\b/.test(xml)) throw new Error('This is not an OpenRocket file');
    var head = /<openrocket\b([^>]*)>/.exec(xml), rocketPart = xml.split('<simulations>')[0];
    var res = { creator: head ? attrs(head[1]).creator || '' : '', rocketName: tag(rocketPart, 'name') || 'Rocket', motors: {}, sims: [] };
    var re = /<motor configid="([^"]+)">([\s\S]*?)<\/motor>/g, m;
    while ((m = re.exec(rocketPart))) if (!res.motors[m[1]]) res.motors[m[1]] = { manufacturer: tag(m[2], 'manufacturer') || '', designation: tag(m[2], 'designation') || '', diameter: num(tag(m[2], 'diameter')), length: num(tag(m[2], 'length')) };
    // max body radius as a fallback for the reference diameter
    var rmax = 0, rr = /<(radius|outerradius|aftradius|foreradius)>([^<]*)</g;
    while ((m = rr.exec(rocketPart))) { var r = num(m[2]); if (r > rmax) rmax = r; }
    res.bodyDiameter = rmax ? 2 * rmax : NaN;
    var simPart = xml.slice(xml.indexOf('<simulations>') + 1), sr = /<simulation\b([^>]*)>([\s\S]*?)<\/simulation>/g;
    while ((m = sr.exec(simPart))) {
      var body = m[2], cond = (/<conditions>([\s\S]*?)<\/conditions>/.exec(body) || [, ''])[1];
      var fd = /<flightdata\b([^>]*)>/.exec(body), br = /<databranch\b([^>]*)>([\s\S]*?)<\/databranch>/.exec(body);
      var sim = { name: tag(body, 'name') || 'Simulation', status: attrs(m[1]).status || '', configid: tag(cond, 'configid'),
        conditions: { railLength: num(tag(cond, 'launchrodlength')), angleDeg: num(tag(cond, 'launchrodangle')), windAvg: num(tag(cond, 'windaverage')), launchAlt: num(tag(cond, 'launchaltitude')),
          baseTempK: num(tag(cond, 'basetemperature')), basePressure: num(tag(cond, 'basepressure')), lat: num(tag(cond, 'launchlatitude')), lon: num(tag(cond, 'launchlongitude')) },
        summary: {}, events: {}, hasData: false };
      if (fd) { var fa = attrs(fd[1]); for (var k in fa) sim.summary[k] = num(fa[k]); }
      if (br) {
        sim.types = (attrs(br[1]).types || '').split(',');
        var er = /<event\b([^>]*)\/?>/g, ev; while ((ev = er.exec(br[2]))) { var ea = attrs(ev[1]); if (ea.type && !(ea.type in sim.events)) sim.events[ea.type] = num(ea.time); }
        sim._raw = br[2]; sim.hasData = /<datapoint>/.test(br[2]);
      }
      sim.motor = res.motors[sim.configid] || null;
      res.sims.push(sim);
    }
    return res;
  }
  function columns(sim, wanted) {
    var idx = {}, out = {};
    wanted.forEach(function (w) { var i = sim.types.findIndex(function (t) { return w[1].test(t.trim()); }); idx[w[0]] = i; out[w[0]] = []; });
    var re = /<datapoint>([^<]*)<\/datapoint>/g, m;
    while ((m = re.exec(sim._raw))) {
      var v = m[1].split(',');
      for (var k in idx) out[k].push(idx[k] >= 0 ? +v[idx[k]] : NaN);
    }
    return out;
  }

  /* ---------- everything Flight Log Lab needs from one simulation ---------- */
  function derive(sim, design) {
    if (!sim.hasData) throw new Error('“' + sim.name + '” has no saved flight data. In OpenRocket, run it and save with “Save all simulated data”.');
    var c = columns(sim, [['t', /^time$/i], ['alt', /^altitude$/i], ['vz', /^vertical velocity$/i], ['az', /^vertical acceleration$/i], ['v', /^total velocity$/i],
      ['mass', /^mass$/i], ['motorMass', /^motor mass$/i], ['thrust', /^thrust$/i], ['cd', /^drag coefficient$/i], ['mach', /^mach number$/i], ['refLen', /^reference length$/i]]);
    var n = c.t.length, ev = sim.events, i;
    var tLift = fin(ev.liftoff) ? ev.liftoff : 0, tIgn = fin(ev.ignition) ? ev.ignition : 0, tApo = fin(ev.apogee) ? ev.apogee : sim.summary.timetoapogee;
    function at(arr, t) { var j = 0; while (j < n - 1 && c.t[j] < t) j++; return arr[j]; }
    var out = { name: sim.name, status: sim.status, rocketName: design.rocketName, events: ev, tLift: tLift, summary: sim.summary, conditions: sim.conditions, motorInfo: sim.motor };
    // rocket
    out.wetMass = c.mass.find(fin);
    var refL = median(c.refLen.slice(0, 50)); out.diameter = refL > 0 ? refL : design.bodyDiameter;
    // thrust curve and motor masses
    var pk = 0; for (i = 0; i < n; i++) if (c.thrust[i] > (c.thrust[pk] || 0)) pk = i;
    var peak = c.thrust[pk] || 0, lim = 0.05 * peak, tEnd = NaN;
    for (i = n - 1; i >= pk; i--) if (c.thrust[i] > lim) { tEnd = c.t[i]; break; }
    var curve = [[0, 0]], I = 0, Ifl = 0;
    for (i = 0; i < n; i++) {
      if (!(c.thrust[i] > 0) && c.t[i] > tEnd) { curve.push([c.t[i] - tIgn, 0]); break; }
      if (c.t[i] >= tIgn) curve.push([c.t[i] - tIgn, Math.max(0, c.thrust[i] || 0)]);
      if (i) { var dI = Math.max(0, (c.thrust[i] + c.thrust[i - 1]) / 2) * (c.t[i] - c.t[i - 1]); I += dI; if (c.t[i] > tLift) Ifl += dI; }
    }
    var mm0 = c.motorMass.find(fin), mmEnd = at(c.motorMass, (fin(tEnd) ? tEnd : 0) + 0.3);
    out.motor = { name: (sim.motor && sim.motor.designation) || 'OpenRocket motor', maker: (sim.motor && sim.motor.manufacturer) || '', diameter_mm: sim.motor ? sim.motor.diameter * 1000 : NaN,
      length_mm: sim.motor ? sim.motor.length * 1000 : NaN, delays: '', propMass: fin(mm0) && fin(mmEnd) ? mm0 - mmEnd : NaN, totalMass: mm0, curve: curve, source: 'openrocket', fromSim: sim.name };
    // drag coefficient in the coast (same window the flight analysis uses)
    var cds = [];
    for (i = 0; i < n; i++) if (c.t[i] > tEnd + 0.5 && c.t[i] < tApo - 1 && c.mach[i] > 0.1) cds.push(c.cd[i]);
    out.cd = median(cds); out.cdMach = cds.length ? [Math.min.apply(null, c.mach.filter(function (x, j) { return c.t[j] > tEnd + 0.5 && c.t[j] < tApo - 1 && x > 0.1; })), at(c.mach, tEnd + 0.5)] : null;
    // prediction numbers, T+ from OpenRocket's liftoff
    var maxAz = -Infinity, maxV = -Infinity, burnI = -1;
    for (i = 0; i < n; i++) { if (c.t[i] > tApo) break; if (c.az[i] > maxAz) maxAz = c.az[i]; if (c.v[i] > maxV) maxV = c.v[i]; }
    for (i = pk; i < n; i++) if (c.az[i] < 0) { burnI = i; break; } // net vertical acceleration turns negative = board definition of burnout
    out.pred = {
      impulse: I, avgFlight: fin(tEnd) && tEnd > tLift ? Ifl / (tEnd - tLift) : NaN, peak: peak, thrustEnd: tEnd - tLift,
      tBurn: burnI >= 0 ? c.t[burnI] - tLift : NaN, burnAlt: burnI >= 0 ? c.alt[burnI] : NaN, burnV: burnI >= 0 ? c.vz[burnI] : NaN,
      maxAccNet: maxAz / G, maxV: fin(sim.summary.maxvelocity) ? sim.summary.maxvelocity : maxV, maxMach: sim.summary.maxmach, railExitV: sim.summary.launchrodvelocity,
      apogee: fin(sim.summary.maxaltitude) ? sim.summary.maxaltitude : at(c.alt, tApo), tApo: tApo - tLift, cd: out.cd
    };
    // time series for the charts (up to apogee + 10 s, at most ~3000 points)
    var last = 0; while (last < n - 1 && c.t[last] < tApo + 10) last++;
    var step = Math.max(1, Math.ceil((last + 1) / 3000)), S = { tp: [], alt: [], vz: [], az: [], thrust: [] };
    for (i = 0; i <= last; i += step) { S.tp.push(+(c.t[i] - tLift).toFixed(4)); S.alt.push(c.alt[i]); S.vz.push(c.vz[i]); S.az.push(c.az[i]); S.thrust.push(c.thrust[i]); }
    out.series = S;
    return out;
  }
  // the simulation to suggest: up to date first, then any with data
  function defaultSim(design) {
    var order = ['uptodate', 'loaded', 'outdated'];
    for (var k = 0; k < order.length; k++) { var s = design.sims.find(function (x) { return x.hasData && x.status === order[k]; }); if (s) return s; }
    return design.sims.find(function (x) { return x.hasData; }) || null;
  }

  return { unpack: unpack, parse: parse, derive: derive, defaultSim: defaultSim };
})();
if (typeof module !== 'undefined') module.exports = ORK;
