'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
require('./release-check.cjs').clearEvidence(root);
for(const args of [['--check','main.js'],['test.js'],['--test','behavior-test.cjs','fix-regression.cjs','scripts/release-check.test.cjs']]) {
 const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
 if(result.error) throw result.error;
 if(result.status!==0) process.exit(result.status||1);
}
