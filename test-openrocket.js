// Check the OpenRocket import on a real file:  node test-openrocket.js path/to/rocket.ork [motor.eng]
const fs = require('fs'), ORK = require('./src/openrocket.js'), M = require('./src/motor.js');
(async () => {
  const [file, engFile] = process.argv.slice(2);
  if (!file) { console.log('usage: node test-openrocket.js rocket.ork [motor.eng]'); process.exit(1); }
  const buf = fs.readFileSync(file), t0 = Date.now();
  const design = ORK.parse(await ORK.unpack(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
  console.log(design.rocketName, '·', design.creator, '·', design.sims.length, 'simulations ·', Date.now() - t0, 'ms');
  design.sims.forEach(s => console.log('  ', (s.hasData ? '✓' : '·'), s.status.padEnd(9), s.name.padEnd(16), s.motor ? s.motor.designation : '-', s.summary.maxaltitude ? s.summary.maxaltitude + ' m' : ''));
  const sim = ORK.defaultSim(design); if (!sim) { console.log('no simulation with data'); process.exit(1); }
  const d = ORK.derive(sim, design), p = d.pred, m = M.prepare(d.motor);
  console.log('\nimporting', JSON.stringify(sim.name), '(' + sim.status + ')');
  console.log({ wetMass_kg: d.wetMass, diameter_mm: +(d.diameter * 1000).toFixed(1), cd_coast: +d.cd.toFixed(3), rail_m: d.conditions.railLength, angle_deg: d.conditions.angleDeg, padAlt_m: d.conditions.launchAlt, liftoff_s: d.tLift });
  console.log('motor', m.name, '·', m.maker, '· impulse', m.impulse.toFixed(0), 'N·s · peak', m.peak.toFixed(0), 'N · burn', m.burnTime.toFixed(2), 's · prop', m.propMass.toFixed(3), 'kg · total', m.totalMass.toFixed(3), 'kg · curve points', m.curve.length);
  console.log('prediction', Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +(+v).toFixed(3)])));
  let fails = 0; const chk = (n, a, b, tol) => { const ok = Math.abs(a - b) <= tol * Math.abs(b); if (!ok) fails++; console.log((ok ? 'ok  ' : 'FAIL') + ' ' + n.padEnd(40), +a.toFixed(3), 'vs', +b.toFixed(3)); };
  console.log('');
  chk('apogee vs OpenRocket summary', p.apogee, sim.summary.maxaltitude, 1e-6);
  chk('time to apogee (+liftoff) vs summary', p.tApo + d.tLift, sim.events.apogee, 1e-6);
  chk('thrust ends near OR burnout event', p.thrustEnd + d.tLift, sim.events.burnout, 0.05);
  // our own simulator, fed with the imported rocket + motor, should land near OpenRocket
  const ours = M.simulate(m, { liftoffMass: d.wetMass, diameter: d.diameter, cd: d.cd, railLength: d.conditions.railLength, angleDeg: d.conditions.angleDeg },
    { groundTempC: d.conditions.baseTempK - 273.15, padAltitude: d.conditions.launchAlt });
  chk('Flight Log Lab sim apogee vs OpenRocket', ours.apogee, sim.summary.maxaltitude, 0.08);
  chk('Flight Log Lab sim max velocity vs OR', ours.maxV, sim.summary.maxvelocity, 0.05);
  if (engFile) {
    const eng = M.prepare(M.parseEng(fs.readFileSync(engFile, 'utf8')));
    console.log('\n.eng', eng.name, eng.designation, '· impulse', eng.impulse.toFixed(0), '· peak', eng.peak.toFixed(0), '· burn', eng.burnTime.toFixed(2), 's · prop', eng.propMass, 'kg');
    chk('OR thrust-curve impulse vs .eng', m.impulse, eng.impulse, 0.03);
  }
  console.log(fails ? fails + ' check(s) failed' : 'all checks passed'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
