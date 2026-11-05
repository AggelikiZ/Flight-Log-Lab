// Self-checks for src/motor.js:  node test-motor.js
const M = require('./src/motor.js'), G = M.G;
let fails = 0;
function check(name, got, want, tol) {
  const ok = Math.abs(got - want) <= tol * Math.abs(want || 1);
  if (!ok) fails++;
  console.log((ok ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(46) + String(+got.toFixed(4)).padStart(12) + '   expected ' + +want.toFixed(4) + ' ±' + (tol * 100) + ' %');
}

// 1. RASP .eng (fictional test motor, boxcar 1500 N for ~4 s)
const eng = `; test motor, not a real product
TEST-M1500 98 732 P 3.2 6.1 Test
0.00 0
0.01 1500
3.99 1500
4.00 0
`;
let m = M.prepare(M.parseEng(eng));
check('eng total impulse (N·s)', m.impulse, 0.01 * 750 + 3.98 * 1500 + 0.01 * 750, 1e-9);
check('eng prop mass (kg)', m.propMass, 3.2, 0);
check('eng burn time (s)', m.burnTime, 3.999, 1e-3);
console.log('      designation', m.designation, '· class', m.cls, '· Isp', m.isp.toFixed(1), 's');
if (m.cls !== 'M') { fails++; console.log('FAIL  class letter'); }

// 2. RockSim .rse
const rse = `<engine-database><engine-list><engine code="TEST-K500" mfg="Test" dia="54" len="400" propWt="800" Initwt="1500" delays="P">
<data><eng-data t="0" f="0" m="800"/><eng-data t="0.1" f="500"/><eng-data t="2.9" f="500"/><eng-data t="3" f="0"/></data></engine></engine-list></engine-database>`;
const r = M.prepare(M.parseRse(rse));
check('rse impulse', r.impulse, 0.1 * 250 + 2.8 * 500 + 0.1 * 250, 1e-9);
check('rse prop mass (g → kg)', r.propMass, 0.8, 0);

// 3. plain table in ms / kN
const tab = M.prepare(M.parseThrustTable('time_ms,thrust_kN\n0,0\n100,2\n1900,2\n2000,0\n', 'bench'));
check('table impulse (ms, kN converted)', tab.impulse, 0.1 * 1000 + 1.8 * 2000 + 0.1 * 1000, 1e-9);

// 4. simulation vs closed-form rocket equation (no drag, vertical, constant thrust)
const F = 2000, tb = 4, mp = 3, m0 = 25;
const box = M.prepare({ name: 'box', propMass: mp, curve: [[0, F], [tb, F], [tb + 1e-6, 0]] });
const env = { groundTempC: 15, padAltitude: 0 };
const sim = M.simulate(box, { liftoffMass: m0, diameter: 0.1, cd: 0, railLength: 0.01, angleDeg: 0 }, env);
const mdot = mp / tb, ve = F / mdot, m1 = m0 - mp;
const vbo = ve * Math.log(m0 / m1) - G * tb;
const hbo = ve * ((m1 / mdot) * Math.log(m1 / m0) + tb) - G * tb * tb / 2;
check('sim burnout velocity (m/s)', sim.motorEndV, vbo, 0.003);
check('sim apogee, no drag (m)', sim.apogee, hbo + vbo * vbo / (2 * G), 0.003);

// 5. round trip: simulate a real-ish flight, feed the "measured" data back, recover thrust & Cd
const rk = { liftoffMass: 25, diameter: 0.13, cd: 0.5, railLength: 12, angleDeg: 0 };
const fl = M.simulate(m, rk, env), S = fl.series, n = S.t.length;
const t = [], f = [], v = [], alt = [];
for (let x = -5; x < 0; x += 0.01) { t.push(x); f.push(G); v.push(0); alt.push(0); }
for (let i = 0; i < n; i++) { t.push(S.t[i] - fl.tLift); f.push(S.sf[i]); v.push(S.vz[i]); alt.push(S.alt[i]); }
const ex = M.extractThrust({ t: Float64Array.from(t), f: Float64Array.from(f), v: Float64Array.from(v), alt: Float64Array.from(alt), tApo: fl.tApo - fl.tLift }, m, rk, env, { preLiftImpulse: M.impulseAt(m, fl.tLift) });
check('extracted total impulse (N·s)', ex.impulseTotal, m.impulse, 0.01);
check('extracted peak thrust (N)', ex.peak, m.peak, 0.02);
check('drag coefficient from coast', ex.cd, rk.cd, 0.03);
console.log('      simulated apogee', fl.apogee.toFixed(0), 'm · max v', fl.maxV.toFixed(0), 'm/s · rail exit', fl.railExitV.toFixed(1), 'm/s');

console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
process.exit(fails ? 1 : 0);
