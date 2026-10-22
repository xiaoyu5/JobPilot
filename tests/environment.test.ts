import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {Application} from '../packages/worker/src/application.js';
import {EnvironmentSave,readEnvironment,saveEnvironment} from '../packages/worker/src/environment.js';

test('env settings preserve unrelated text, write private atomic files, never return/persist keys and reload on app restart',async()=>{
  const dir=await mkdtemp('/tmp/jp-env-'),path=`${dir}/.env.local`;let app=new Application(dir);const signal=new AbortController().signal;
  try{
    await writeFile(path,'# Preserve comment\nUNRELATED="keep me"\nOPENAI_BASE_URL="http://localhost:1/v1"\nOPENAI_MODEL="fixture"\nOPENAI_API_KEY="old-fixture-secret"\n',{mode:0o600});
    const loaded=await app.dispatch('llm.env.load',{path},signal);assert(!JSON.stringify(loaded).includes('old-fixture-secret'));assert.equal(app.status().llm.hasApiKey,true);
    const newKey='fixture-with-$-#-quotes"-and-backtick`';
    const saved=await app.dispatch('llm.env.save',{path,baseUrl:'http://localhost:2/v1',model:'fixture-2',apiKey:newKey},signal);
    assert(!JSON.stringify(saved).includes(newKey));assert(!JSON.stringify(app.store.config()).includes(newKey));assert(!JSON.stringify(app.status()).includes(newKey));
    const text=await readFile(path,'utf8');assert(text.includes('# Preserve comment'));assert(text.includes('UNRELATED="keep me"'));assert.equal(readEnvironment(path).configuration.apiKey,newKey);assert.equal((await stat(path)).mode&0o777,0o600);
    assert.equal((await readFile(`${dir}/jobpilot.sqlite`)).includes(newKey),false);
    await app.close();app=new Application(dir);assert.equal(app.status().llm.sessionReady,true);assert.equal(app.store.config().llm?.model,'fixture-2');
    await app.dispatch('llm.env.save',{path,baseUrl:'http://localhost:2/v1',model:'fixture-2',apiKey:''},signal);assert.equal(readEnvironment(path).configuration.apiKey,newKey);
    await app.dispatch('llm.env.save',{path,baseUrl:'http://localhost:2/v1',model:'fixture-2',clearKey:true},signal);assert.equal(readEnvironment(path).configuration.apiKey,'');assert.equal(app.status().llm.hasApiKey,false);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('missing/invalid env and unsupported paths fail safely while the app stays available',async()=>{
  const dir=await mkdtemp('/tmp/jp-env-invalid-'),path=`${dir}/.env`;let app=new Application(dir);const signal=new AbortController().signal;
  try{
    await app.dispatch('llm.env.save',{baseUrl:'http://localhost:1/v1',model:'fixture',apiKey:'anonymous'},signal);
    await app.close();await writeFile(path,'OPENAI_BASE_URL="not-a-url"\nOPENAI_API_KEY="do-not-echo"\n');app=new Application(dir);
    assert.equal(app.status().llm.sessionReady,false);assert(app.status().llm.error);assert(!JSON.stringify(app.status()).includes('do-not-echo'));
    assert.equal(app.store.resume().facts.length,0);
    await assert.rejects(app.dispatch('llm.env.load',{path:`${dir}/other.txt`},signal),{code:'ENV_PATH_INVALID'});
    assert.throws(()=>EnvironmentSave.parse({baseUrl:'http://localhost:1/v1',model:'fixture',apiKey:'bad\nkey'}));
    await writeFile(path,'x'.repeat(65537));assert.throws(()=>readEnvironment(path),{code:'ENV_TOO_LARGE'});
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
