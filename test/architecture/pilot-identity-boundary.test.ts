import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('the pilot loads without the demo actor, seed or CLI, and refuses demo identity before opening a database', () => {
  const probe = `
    import {register} from 'node:module';
    const hook='export async function resolve(specifier,ctx,next){const result=await next(specifier,ctx);if(["/local-demo-actor.","/agent-cli.","/measure-page.","/domain/src/app/seed."].some(part=>result.url.includes(part)))throw new Error("DEMO_IMPORT");return result;}';
    register('data:text/javascript,'+encodeURIComponent(hook),import.meta.url);
    const {createPilotApplication}=await import('./apps/api/src/pilot-composition-root.ts');
    if(await createPilotApplication({localDemoIdentity:true}).then(()=>false,e=>e.name!=='Error'||e.message!=='Staff access could not be verified.')) throw new Error('demo flag accepted');
    let caught=false;
    try{await import('./apps/api/src/composition-root.ts');}catch(e){caught=e.message==='DEMO_IMPORT';}
    if(!caught)throw new Error('import boundary control did not fire');`;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', probe],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
