import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeChrome} from '../packages/boss-adapter/src/native.js';
import {AppError,type JobRecord} from '@jobpilot/contracts';

test('default receipt falls back once to read-only Continue navigation without repeating first contact or changing the approved identity',async()=>{
  for(const mode of ['modal','alias','challenge','not-contacted','wrong-chat']){
    const native=new NativeChrome('/tmp/jp-contact-fixture') as any;
    const job={platformJobId:'approved_job',recruiterId:'approved_encrypted_recruiter'} as JobRecord;
    const operations:string[]=[];let reads=0;
    native.command=async(operation:string,_url:unknown,payload:any)=>{
      operations.push(operation);assert.equal(payload.jobId,job.platformJobId);assert.equal(payload.recruiterId,job.recruiterId);
      if(mode==='challenge')throw new AppError('BOSS_CHALLENGE','fixture');
      if(mode!=='modal'&&reads++===0)throw new AppError('TARGET_MISMATCH','modal alias differs');
      if(mode==='wrong-chat')throw new AppError('TARGET_MISMATCH','full chat does not contain original alias');
      return {state:'CONFIRMED',messageId:'bound_default_receipt',message:'fixture'};
    };
    native.openExistingChat=async(target:JobRecord)=>{assert.equal(target,job);operations.push('continue-read-only');if(mode==='not-contacted')throw new AppError('ALREADY_CONTACTED','no Continue entry');};
    const result=native.verifyContact(job,new AbortController().signal);
    if(mode==='challenge')await assert.rejects(result,{code:'BOSS_CHALLENGE'});
    else if(mode==='not-contacted')await assert.rejects(result,{code:'ALREADY_CONTACTED'});
    else if(mode==='wrong-chat')await assert.rejects(result,{code:'TARGET_MISMATCH'});
    else assert.equal((await result).state,'CONFIRMED');
    assert(!operations.some(op=>/submit|prepare/.test(op)));
    assert.equal(operations.filter(op=>op==='continue-read-only').length,['alias','not-contacted','wrong-chat'].includes(mode)?1:0);
  }
});

test('Continue navigation tolerates transient loading but stops at an explicit login challenge',async()=>{
  for(const challenge of [false,true]){
    const native=new NativeChrome('/tmp/jp-contact-fixture') as any;let reads=0;const commands:string[]=[];
    native.readJob=async()=>({platformJobId:'approved_job',recruiterId:'approved_recruiter',alreadyContacted:true});
    native.command=async(op:string)=>{commands.push(op);return {opened:true};};
    native.read=async()=>{reads++;return reads===1?{state:challenge?'CHALLENGE':'UNKNOWN',message:'loading',url:'https://www.zhipin.com/web/geek/chat'}:{state:'LOGGED_IN',message:'ready',url:'https://www.zhipin.com/web/geek/chat'};};
    const result=native.openExistingChat({} as JobRecord,new AbortController().signal);
    if(challenge)await assert.rejects(result,{code:'BOSS_CHALLENGE'});else{assert.equal((await result).state,'LOGGED_IN');assert.equal(reads,2);}
    assert.deepEqual(commands,['greeting-chat-continue']);
  }
});
