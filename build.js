const fs=require('fs');
let t=fs.readFileSync('src/template.html','utf8');
const rep=(k,v)=>{t=t.split(k).join(v.replace(/<\/script/gi,'<\\/script'));};
rep('/*UPLOT_CSS*/',fs.readFileSync('node_modules/uplot/dist/uPlot.min.css','utf8'));
rep('/*UPLOT_JS*/',fs.readFileSync('node_modules/uplot/dist/uPlot.iife.min.js','utf8'));
rep('/*CORE_JS*/',fs.readFileSync('src/core.js','utf8'));
rep('/*MOTOR_JS*/',fs.readFileSync('src/motor.js','utf8'));
rep('/*APP_JS*/',fs.readFileSync('src/app.js','utf8'));
fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html',t);console.log('built',t.length);
