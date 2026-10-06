import {readFile} from 'node:fs/promises';
import {writeSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {prepare,measure,nodeCases as cases} from './undo-memory-core.mjs';
const directory=path.resolve(process.argv[2]);
const bytes=await readFile(path.join(directory,'engine_wasm_bg.wasm'));
const fixture=await readFile(process.argv[3],'utf8');
const selection=process.argv[4];
const only=selection?.startsWith('--only=') ? selection.slice(7) : undefined;
const selected=only ? undefined : selection;
if(!selected) {
 for(const config of cases.filter(c=>!only || c.caseId===only)) {
  const started=performance.now();
  writeSync(1,JSON.stringify({kind:'child-start',caseId:config.caseId,timeoutMs:120000})+'\n');
  const child=spawnSync(process.execPath,[process.argv[1],process.argv[2],process.argv[3],config.caseId],{stdio:'inherit',timeout:120000});
  writeSync(1,JSON.stringify({kind:'child-exit',caseId:config.caseId,elapsedMs:performance.now()-started,errorCode:child.error?.code??null,status:child.status,signal:child.signal,failureClass:child.error || child.status!==0 ? 'child-failure-not-automatically-memory' : null})+'\n');
  if(child.error || child.status!==0) {process.exitCode=1;break;}
 }
} else for(const config of cases.filter(c=>c.caseId===selected)) {
 const started=performance.now();
 const report=event=>writeSync(1,JSON.stringify({kind:'stage',caseId:config.caseId,elapsedMs:performance.now()-started,...event})+'\n');
 try {
 report({stage:'census-initialize'});
 const census=await import(pathToFileURL(path.join(directory,'engine_wasm.js'))+'?census='+config.caseId);
 await census.default({module_or_path:await WebAssembly.compile(bytes)});
 const prepared=await prepare(census,fixture,config,report);
 census.clear_game_state();
 report({stage:'measurement-initialize'});
 const engine=await import(pathToFileURL(path.join(directory,'engine_wasm.js'))+'?measure='+config.caseId);
 const wasm=await engine.default({module_or_path:await WebAssembly.compile(bytes)});
 const result=await measure(engine,wasm.memory,fixture,config,()=>({nodeMemory:process.memoryUsage(),scope:'process includes census instance; not incremental Undo RSS'}),prepared,report);
 console.log(JSON.stringify({runtime:'node',...result}));
 if(!result.pass) {process.exitCode=1;break;}
 } catch {console.log(JSON.stringify({pass:false,caseId:config.caseId,stage:'prepare',failureClass:'preparation-failure'}));process.exitCode=1;break;}
}
