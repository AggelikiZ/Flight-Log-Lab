const RL=require('./src/core.js'), fs=require('fs');
const U=process.argv[2]||'./sample-data/';
const files=['altlog.csv','48a615d4-recovery_events.csv','43f65955-fl007.cfl','28e04d7b-rest.csv','60aac3d3-imu.csv'];
for(const f of files){
  const t0=Date.now(); let tab;
  const buf=fs.readFileSync(U+f);
  const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
  if(RL.looksLikeCATS(ab)) tab=RL.parseCATS(ab); else tab=RL.parseCSV(buf.toString('utf8'));
  const map=RL.detectColumns(tab,f);
  console.log('\n=====',f,tab.rows,'rows',Date.now()-t0,'ms', tab.version||'');
  for(const k in map){const m=map[k]; console.log('  ',k.padEnd(22),m.role.padEnd(15),(m.unit||'').padEnd(8),m.gravity||'',m.reason)}
  const ch=RL.buildChannels(tab,map);
  const r=RL.analyze(ch,{groundTempC:20});
  const o={}; for(const k of ['ok','kind','tLift','liftMethod','tBurn','burnMethod','tApo','apogee','ground','maxV','maxVT','maxVName','maxVBaro','mach','maxAcc','maxAccT','accName','tLand','landMethod','sampleRate','padPressure']) o[k]=r[k];
  if(r.ok){ for(const k of ['tBurn','tApo','maxVT','maxAccT','tLand']) o[k]=+(r[k]-r.tLift).toFixed(2); o.maxAccG=(r.maxAcc/9.80665).toFixed(1);}
  console.log(o); if(r.desc) console.log('desc',r.desc, r.desc.mainT? 'mainT+'+(r.desc.mainT-r.tLift).toFixed(1):'' );
  if(r.gps) console.log('gps',{pad:r.gps.pad,landing:r.gps.landing,drift:r.gps.drift,bearing:r.gps.bearing,lost:r.gps.lost-r.tLift,regain:r.gps.regain-r.tLift,fix:r.gps.landingFixT-r.tLift});
  r.notes.forEach(n=>console.log('  NOTE',n.text));
  const ev=RL.stateEvents(ch,tab.stateNames); console.log('events', ev.length, ev.slice(0,12).map(e=>(e.t-(r.tLift||0)).toFixed(2)+' '+e.label).join(' | '));
  if(tab.events) console.log('cats', tab.events.map(e=>(e.t-r.tLift).toFixed(2)+' '+e.label).join(' | '));
}
