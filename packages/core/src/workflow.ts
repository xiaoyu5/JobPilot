import {z} from 'zod';
import {AppError,type JobRecord,type SearchProfileData} from '@jobpilot/contracts';
import {Store} from '@jobpilot/store';
import {MatchingService} from './index.js';
import {SendingService} from './sending.js';

export const WorkflowInput=z.object({profileId:z.string().min(1).max(100),mode:z.enum(['preview','auto']).default('preview'),draftStyle:z.enum(['natural','rewrite']).optional()}).strict();
export const ScheduleInput=WorkflowInput.extend({enabled:z.boolean(),time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),timeZone:z.string().min(1).max(80)}).strict();
type Checkpoint={profile:SearchProfileData;mode:'preview'|'auto';draftStyle?:'natural'|'rewrite';stamp:string;phase:'discover'|'details'|'analyze'|'send'|'done';jobs:string[];next:number;queueIds:string[];sendRunId?:string};
export interface WorkflowBrowser {search(profile:SearchProfileData,signal:AbortSignal,onJob:(job:JobRecord)=>void):Promise<number>;readJob(job:JobRecord,signal?:AbortSignal):Promise<JobRecord>}
export class WorkflowService{
  private current:{id:string;controller:AbortController;task:Promise<void>}|undefined;
  private timer:ReturnType<typeof setInterval>;private armed=false;private lastBeat:number;
  constructor(readonly store:Store,readonly matching:MatchingService,readonly sending:SendingService,readonly browser:WorkflowBrowser,private unavailable:()=>boolean,private clock=()=>Date.now()){
    this.lastBeat=clock();this.timer=setInterval(()=>{try{this.tick();}catch(error){this.armed=false;this.store.setSetting('scheduleError',error instanceof AppError?error.message:'排程停止，请检查任务。');}},15000);this.timer.unref();
  }
  get busy(){return !!this.current;}
  private available(){if(this.busy||this.unavailable())throw new AppError('RUN_ACTIVE','已有任务正在使用浏览器或模型。');if(!this.store.config().bossReadOnlyConsent)throw new AppError('CONSENT_REQUIRED','请先授权 BOSS 只读访问。');}
  private save(id:string,checkpoint:Checkpoint){this.store.db.prepare('UPDATE runs SET checkpoint_json=? WHERE id=?').run(JSON.stringify(checkpoint),id);}
  start(input:z.infer<typeof WorkflowInput>){
    this.available();if(input.mode==='auto'&&input.draftStyle==='rewrite')throw new AppError('REVIEW_REQUIRED','自然精炼文案需要人工审核，请选择预览模式。');this.store.frozenFacts();const profile=this.store.getSearch(input.profileId);if(!profile)throw new AppError('PROFILE_NOT_FOUND','搜索方案不存在。');
    if(input.mode==='auto'&&!this.sending.status().autoModeConsent)throw new AppError('CONSENT_REQUIRED','请先在 GUI 独立启用首联 Auto。');
    const run=this.store.createRun('boss'),checkpoint:Checkpoint={profile,mode:input.mode,draftStyle:input.draftStyle??'natural',stamp:this.sending.configurationStamp(),phase:'discover',jobs:[],next:0,queueIds:[]};
    this.store.db.prepare("UPDATE runs SET kind='workflow',profile_id=?,execution_mode=? WHERE id=?").run(profile.id,input.mode,run.id);this.save(run.id,checkpoint);return this.launch(run.id,checkpoint);
  }
  resume(id:string){
    this.available();const run=this.store.getRun(id),row=this.store.db.prepare('SELECT checkpoint_json FROM runs WHERE id=?').get(id);
    if(!run||run.kind!=='workflow'||!['PAUSED','NEEDS_HUMAN','FAILED'].includes(run.state)||!row?.checkpoint_json)throw new AppError('CHECKPOINT_NOT_FOUND','该任务没有可恢复的检查点。');
    const checkpoint=JSON.parse(String(row.checkpoint_json)) as Checkpoint;
    if(checkpoint.stamp!==this.sending.configurationStamp()||JSON.stringify(this.store.getSearch(checkpoint.profile.id))!==JSON.stringify(checkpoint.profile))throw new AppError('CONTEXT_CHANGED','事实、规则或搜索方案变化，请新建任务。');
    if(checkpoint.mode==='auto'&&!this.sending.status().autoModeConsent)throw new AppError('CONSENT_REQUIRED','恢复 Auto 前需重新在 GUI 授权。');
    return this.launch(id,checkpoint);
  }
  private launch(id:string,checkpoint:Checkpoint){
    const controller=new AbortController();this.store.db.prepare('UPDATE runs SET finished_at=NULL,error_code=NULL,state=? WHERE id=?').run(checkpoint.phase==='analyze'?'ANALYZING':checkpoint.phase==='send'?'PREFLIGHT':'DISCOVERING',id);
    const task=Promise.resolve().then(()=>this.execute(id,checkpoint,controller.signal)).finally(()=>{if(this.current?.id===id)this.current=undefined;});this.current={id,controller,task};return {runId:id};
  }
  private async execute(id:string,cp:Checkpoint,signal:AbortSignal){
    let beat=this.clock();const watchdog=setInterval(()=>{if(this.clock()-beat>30000||this.clock()<beat)this.current?.controller.abort(new AppError('SYSTEM_RESUMED','休眠后需手动恢复任务。'));beat=this.clock();},1000);watchdog.unref();
    const guard=()=>{signal.throwIfAborted();if(cp.stamp!==this.sending.configurationStamp())throw new AppError('CONTEXT_CHANGED','事实或规则已变化。');};
    try{
      if(cp.phase==='discover'){
        this.store.db.prepare("UPDATE runs SET state='DISCOVERING' WHERE id=?").run(id);
        await this.browser.search(cp.profile,signal,job=>{guard();this.store.upsertJob(job);if(!cp.jobs.includes(job.id))cp.jobs.push(job.id);this.save(id,cp);this.store.db.prepare('UPDATE runs SET discovered_count=? WHERE id=?').run(cp.jobs.length,id);});
        cp.phase='details';cp.next=0;this.save(id,cp);
      }
      if(cp.phase==='details'){
        for(;cp.next<cp.jobs.length;cp.next++){guard();const job=this.store.getJob(cp.jobs[cp.next]);if(!job)throw new AppError('JOB_NOT_FOUND','检查点岗位已不存在。');this.store.upsertJob(await this.browser.readJob(job,signal));this.save(id,{...cp,next:cp.next+1});}
        cp.phase='analyze';cp.next=0;this.save(id,cp);
      }
      if(cp.phase==='analyze'){
        for(;cp.next<cp.jobs.length;cp.next++){
          guard();this.store.db.prepare("UPDATE runs SET state='ANALYZING' WHERE id=?").run(id);const jobId=cp.jobs[cp.next],assessment=await this.matching.analyze(jobId,signal);
          if(!['SKIP','SKIP_RULE'].includes(assessment.decision)&&assessment.score!==null&&assessment.evidenceFactIds.length){
            this.store.db.prepare("UPDATE runs SET state='DRAFTING' WHERE id=?").run(id);const draft=await this.matching.generate(jobId,cp.draftStyle??'natural',signal);guard();
            if(draft.audit.status==='PASS'){const queued=this.matching.queue(jobId,draft.id);if(!cp.queueIds.includes(queued.queueItemId))cp.queueIds.push(queued.queueItemId);}
          }
          this.save(id,{...cp,next:cp.next+1});this.store.db.prepare('UPDATE runs SET processed_count=?,drafted_count=? WHERE id=?').run(cp.next+1,cp.queueIds.length,id);
        }
        cp.phase=cp.mode==='auto'?'send':'done';this.save(id,cp);
      }
      if(cp.phase==='send'){
        guard();if(!cp.sendRunId&&cp.queueIds.length){cp.sendRunId=this.sending.startAuto(cp.queueIds).runId;this.save(id,cp);}
        if(cp.sendRunId){await this.sending.waitForRun(cp.sendRunId);if(this.store.getRun(cp.sendRunId)?.state!=='COMPLETED')throw new AppError('SEND_REVIEW_REQUIRED','发送子任务需要核验或独立恢复，请勿重开首联。');}
        cp.phase='done';this.save(id,cp);
      }
      guard();this.store.finishRun(id,'COMPLETED');this.store.event(id,'WORKFLOW_COMPLETED',`采集、JD、匹配及草稿完成，${cp.queueIds.length} 条进入审核；${cp.mode==='auto'?'发送子任务已单独核验。':'预览没有发送。'}`);
    }catch(error){const code=signal.aborted?'USER_PAUSED':error instanceof AppError?error.code:'WORKFLOW_FAILED';this.store.finishRun(id,signal.aborted?'PAUSED':'NEEDS_HUMAN',code);this.store.event(id,code,'任务已停止并保留检查点，需检查后手动恢复。');}
    finally{clearInterval(watchdog);}
  }
  schedule(){return {preferences:this.store.getSetting('workflowSchedule')??{profileId:'primary',mode:'preview',time:'10:00',timeZone:'Asia/Shanghai'},enabled:this.armed,error:this.store.getSetting('scheduleError')??null,lastDate:this.store.getSetting('scheduleLastDate')??null};}
  saveSchedule(input:z.infer<typeof ScheduleInput>,gui:boolean){
    if(!gui)throw new AppError('GUI_AUTH_REQUIRED','排程必须在应用界面确认。');try{new Intl.DateTimeFormat('en',{timeZone:input.timeZone});}catch{throw new AppError('INVALID_TIME_ZONE','排程时区无效。');}if(!this.store.getSearch(input.profileId))throw new AppError('PROFILE_NOT_FOUND','搜索方案不存在。');
    if(input.mode==='auto'&&input.draftStyle==='rewrite')throw new AppError('REVIEW_REQUIRED','自然精炼文案排程只支持预览，需人工审核。');
    if(input.enabled){if(!this.store.config().bossReadOnlyConsent)throw new AppError('CONSENT_REQUIRED','请先授权只读访问。');if(input.mode==='auto'&&!this.sending.status().autoModeConsent)throw new AppError('CONSENT_REQUIRED','排程不代为开启 Auto，请先独立授权。');}
    const {enabled,...preferences}=input;this.store.setSetting('workflowSchedule',preferences);this.store.setSetting('scheduleError',null);this.armed=enabled;this.lastBeat=this.clock();return this.schedule();
  }
  tick(){
    const now=this.clock(),gap=now-this.lastBeat;this.lastBeat=now;if(!this.armed)return;if(gap>60000||gap<0){this.armed=false;this.store.setSetting('scheduleError','检测到休眠或时钟跳变，请检查后重新启用排程。');return;}
    const prefs=this.schedule().preferences as any,input=WorkflowInput.parse({profileId:prefs.profileId,mode:prefs.mode,draftStyle:prefs.draftStyle});
    const preferences=this.schedule().preferences as any,parts=Object.fromEntries(new Intl.DateTimeFormat('sv-SE',{timeZone:preferences.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(part=>[part.type,part.value]));
    const date=parts.year+'-'+parts.month+'-'+parts.day;if(parts.hour+':'+parts.minute!==preferences.time||this.store.getSetting('scheduleLastDate')===date||this.busy||this.unavailable())return;
    this.store.setSetting('scheduleLastDate',date);this.start(input);
  }
  stop(id?:string){if(!id){this.armed=false;}if(!id||this.current?.id===id){this.current?.controller.abort();if(this.sending.active)this.sending.pause();}}
  async close(){this.stop();clearInterval(this.timer);await this.current?.task;}
}
