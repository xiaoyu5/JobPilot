import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {AppError,SendPolicyInput,redact,type CommunicationInspection,type JobRecord,type SendBlock,type SendPlan,type SendPolicy,type OutboxRecord,type SendVerification} from '@jobpilot/contracts';
import {Store} from '@jobpilot/store';
import {MatchingService} from './index.js';
import {recruiterHistory} from './recruiter-identity.js';

type Row=Record<string,any>;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface SendTransport {
  inspectCommunication(job:JobRecord,signal:AbortSignal):Promise<{job:JobRecord;inspection:CommunicationInspection}>;
  prepareGreeting(job:JobRecord,content:string,signal:AbortSignal,intentId:string,initialMessageId?:string):Promise<void>;
  submitGreeting(job:JobRecord,content:string,signal:AbortSignal,intentId:string,initialMessageId?:string):Promise<void>;
  startContact?(job:JobRecord,signal:AbortSignal,intentId:string):Promise<void>;
  verifyContact?(job:JobRecord,signal:AbortSignal):Promise<SendVerification>;
  verifyGreeting(job:JobRecord,content:string,signal:AbortSignal):Promise<SendVerification>;
}
type Checkpoint={kinds?:Record<string,'direct'|'default-then-ai'>;queueIds:string[];nextIndex:number;fingerprints:Record<string,string>;policyVersion:number;authorizationId:string;context:string};
export class SendingService {
  private current:{id:string;mode:'review'|'auto';controller:AbortController;promise:Promise<void>}|undefined;
  private autoAuthorization:{id:string;context:string}|undefined;
  private heartbeat=0;
  constructor(readonly store:Store,readonly matching:MatchingService,readonly transport:SendTransport,private health:(signal:AbortSignal)=>Promise<boolean>,private clock=()=>Date.now()){}
  get active(){return this.current;}
  private now(){return new Date(this.clock()).toISOString();}
  private gui(authorized:boolean){if(!authorized)throw new AppError('GUI_AUTH_REQUIRED','此操作需要在 JobPilot 界面明确确认，MCP 不能授予发送权限。');}
  policy():SendPolicy{return this.store.getSetting<SendPolicy>('sendPolicy')??{version:1,confirmed:false,liveEnabled:false,threshold:80,maxPerRun:5,maxPerDay:15,minIntervalSeconds:15,maxRunsPerDay:2,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,startTime:'09:00',endTime:'21:00'};}
  private context(){return digest([this.policy(),{llm:this.store.config().llm,envPath:this.store.config().llmEnvPath,environmentRevision:this.store.getSetting('sendEnvironmentRevision')??0,consent:this.store.config().bossReadOnlyConsent},this.store.resume().version,this.store.resume().frozenVersion,this.matching.policy()]);}
  private revokeAuto(){this.autoAuthorization=undefined;this.store.db.prepare('UPDATE send_authorizations SET revoked_at=? WHERE mode=\'auto\' AND revoked_at IS NULL').run(this.now());}
  savePolicy(input:unknown,gui:boolean){
    this.gui(gui);if(this.current)throw new AppError('RUN_ACTIVE','请先暂停当前发送任务。');
    const {acknowledged,...settings}=SendPolicyInput.parse(input),policy={...settings,version:this.policy().version+1,confirmed:true};
    this.store.transaction(()=>{this.store.setSetting('sendPolicy',policy);this.revokeAuto();});return policy;
  }
  private isAutoAuthorized(){if(this.autoAuthorization?.context!==this.context()){if(this.autoAuthorization)this.revokeAuto();return false;}return true;}
  setAuto(enabled:boolean,gui:boolean){
    this.gui(gui);if(!enabled){this.revokeAuto();this.pause();return {enabled:false};}
    const policy=this.policy();if(!policy.confirmed||!policy.liveEnabled)throw new AppError('CONSENT_REQUIRED','请先确认并保存真实发送规则。');
    if(this.store.getSetting('sendEmergencyStop'))throw new AppError('EMERGENCY_STOPPED','请先处理待核验记录，再在界面解除急停。');
    this.store.frozenFacts();const id=randomUUID(),context=this.context();
    this.store.db.prepare('INSERT INTO send_authorizations VALUES(?,?,?,?,?,?,NULL)').run(id,'auto',policy.version,context,JSON.stringify({maxPerRun:policy.maxPerRun,maxPerDay:policy.maxPerDay}),this.now());
    this.autoAuthorization={id,context};return {enabled:true,policyVersion:policy.version};
  }
  private day(timestamp:number){return new Intl.DateTimeFormat('en-CA',{timeZone:this.policy().timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(timestamp);}
  budget(){
    const today=this.day(this.clock()),rows=this.store.db.prepare('SELECT run_id,created_at,message_units units FROM send_outbox UNION ALL SELECT run_id,created_at,1 units FROM chat_outbox').all() as Row[];
    const todays=rows.filter(row=>row.created_at&&this.day(Date.parse(row.created_at))===today);
    const last=rows.reduce((n,row)=>Math.max(n,Date.parse(row.created_at)||0),0);
    const action=Date.parse(this.store.getSetting<string>('lastSendActionAt')??'')||0;
    return {usedToday:todays.reduce((n,row)=>n+row.units,0),runsToday:new Set(todays.map(row=>row.run_id)).size,lastIntentAt:last||null,lastActionAt:Math.max(last,action)||null};
  }
  outbox(limit=20,offset=0){const rows=this.store.db.prepare('SELECT * FROM send_outbox ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(limit,offset) as Row[];return {items:rows.map(row=>this.row(row)),total:Number((this.store.db.prepare('SELECT count(*) n FROM send_outbox').get() as Row).n)};}
  private row(row:Row):OutboxRecord{const job=this.store.getJob(row.job_id);return {id:row.id,runId:row.run_id,jobId:row.job_id,title:job?.title??row.job_id,company:job?.company??'',recruiterId:row.recruiter_id,draftId:row.draft_id,draftVersion:row.draft_version,state:row.state,phase:row.phase,policyVersion:row.policy_version,resumeVersion:row.resume_version,contentHash:row.content_hash,content:row.content_snapshot,createdAt:row.created_at,sentAt:row.sent_at,detail:row.verify_detail??'',version:row.version,messageUnits:row.message_units,confirmedUnits:row.confirmed_units,deliveryKind:row.delivery_kind,defaultPhase:row.default_phase};}
  private record(id:string){const row=this.store.db.prepare('SELECT * FROM send_outbox WHERE id=?').get(id) as Row|undefined;if(!row)throw new AppError('OUTBOX_NOT_FOUND','发送记录不存在。');return this.row(row);}
  status(){return {policy:this.policy(),autoModeConsent:this.isAutoAuthorized(),emergencyStopped:!!this.store.getSetting('sendEmergencyStop'),activeRunId:this.current?.id??null,mode:this.current?.mode??'preview',budget:this.budget(),needsVerify:Number((this.store.db.prepare("SELECT ((SELECT count(*) FROM send_outbox WHERE state='NEEDS_VERIFY')+(SELECT count(*) FROM chat_outbox WHERE state='NEEDS_VERIFY')) n").get() as Row).n)};}
  configurationStamp(){return this.context();}
  statusNeedsVerify(){return Number((this.store.db.prepare("SELECT ((SELECT count(*) FROM send_outbox WHERE state='NEEDS_VERIFY')+(SELECT count(*) FROM chat_outbox WHERE state='NEEDS_VERIFY')) n").get() as Row).n);}
  checkGate(units=1,reserved=false){this.throwBlocks(this.baseBlocks(reserved));if(!reserved&&this.budget().usedToday+units>this.policy().maxPerDay)throw new AppError('DAILY_LIMIT','剩余消息额度不足。');}
  private queue(id:string){const row=this.store.db.prepare('SELECT * FROM review_queue WHERE id=?').get(id) as Row|undefined;if(!row)throw new AppError('QUEUE_NOT_FOUND','审核条目不存在。');return row;}
  private fingerprint(id:string){const row=this.queue(id),value=this.matching.validateForSend(row.draft_id);return digest([row.id,row.version,row.state,[value.job.id,value.job.platformJobId,value.job.source,value.job.recruiterId,value.job.title,value.job.company,value.job.jdHash,value.job.jdText,value.job.alreadyContacted],value.assessment.id,value.draft.id,value.draft.version,value.draft.content,this.context()]);}
  private baseBlocks(reserved=false):SendBlock[]{
    const blocks:SendBlock[]=[],policy=this.policy(),add=(code:string,message:string)=>blocks.push({code,message});
    if(!policy.confirmed||!policy.liveEnabled)add('CONSENT_REQUIRED','真实发送尚未启用，请在设置确认限制。');
    if(!this.store.config().bossReadOnlyConsent)add('CONSENT_REQUIRED','请先保存 BOSS 会话访问授权。');
    if(this.store.getSetting('sendEmergencyStop'))add('EMERGENCY_STOPPED','急停已锁定，需要在界面解除。');
    if(this.statusNeedsVerify())add('NEEDS_VERIFY','存在不确定发送，请先核验，不能继续发送。');
    const time=new Intl.DateTimeFormat('en-GB',{timeZone:policy.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(this.clock());
    const inWindow=policy.startTime<policy.endTime?time>=policy.startTime&&time<policy.endTime:time>=policy.startTime||time<policy.endTime;
    if(!inWindow)add('OUTSIDE_WORK_HOURS',`当前不在允许时段 ${policy.startTime}–${policy.endTime}（${policy.timeZone}）。`);
    if(reserved?this.budget().usedToday>policy.maxPerDay:this.budget().usedToday>=policy.maxPerDay)add('DAILY_LIMIT','已达到每日发送意图上限，含待核验记录。');
    return blocks;
  }
  private itemBlocks(queueId:string,mode:'review'|'auto',requireIdentity=true):SendBlock[]{
    const blocks:SendBlock[]=[],add=(code:string,message:string)=>blocks.push({code,message});
    try{
      const row=this.queue(queueId),currentJob=this.store.getJob(row.job_id);if(currentJob?.alreadyContacted)add('ALREADY_CONTACTED','该岗位已经沟通，应进入聊天流程，不重复首联。');const {job,draft,assessment}=this.matching.validateForSend(row.draft_id);
      if(job.source!=='boss')add('DEMO_SEND_FORBIDDEN','匿名演示岗位不能真实发送。');
      if(mode==='review'&&row.state!=='REVIEWED')add('REVIEW_REQUIRED','请先核对文案并标记本地已审核。');
      if(!['REVIEWED','PENDING'].includes(row.state))add('DRAFT_STALE','队列或草稿已失效。');
      let recruiterName='';try{recruiterName=JSON.parse(job.snapshot).recruiterName??'';}catch{}
      const compact=(value:string)=>value.replace(/\s+/g,'').toLocaleLowerCase();
      const history=recruiterHistory(this.store,job.recruiterId?[job.recruiterId]:[]);
      const rejected=history.rejected||!!this.store.db.prepare('SELECT job_id FROM job_outcomes WHERE job_id=? AND rejected=1 UNION ALL SELECT job_id FROM contact_locks WHERE kind=\'rejected\' AND job_id=?').get(job.id,job.id)||(this.store.db.prepare("SELECT name,company FROM chat_conversations WHERE state='REJECTED' UNION ALL SELECT name,company FROM contact_locks WHERE kind='rejected'").all() as Row[]).some(row=>typeof recruiterName==='string'&&recruiterName.length>=2&&job.company.length>=2&&compact(row.name)===compact(recruiterName)&&compact(row.company)===compact(job.company));
      if(rejected)add('CONVERSATION_REJECTED','该招聘人已有明确拒绝记录，停止联系。');
      if(requireIdentity&&!job.recruiterId)add('RECRUITER_UNKNOWN','页面未提供可靠招聘人标识，禁止发送。');
      if(assessment.score===null||assessment.score<this.policy().threshold||['SKIP','SKIP_RULE'].includes(assessment.decision))add('SCORE_BELOW_THRESHOLD','匹配结果未达到发送阈值。');
      if(assessment.gaps.some(gap=>gap.severity==='hard'))add('HARD_GAP','岗位存在硬性能力冲突，不能发送。');
      if(this.store.db.prepare(`SELECT id FROM send_outbox WHERE job_id=? OR recruiter_id IN (${history.ids.map(()=>'?').join(',')||'NULL'}) LIMIT 1`).get(job.id,...history.ids))add('DUPLICATE_SEND','岗位或招聘人已有发送意图，禁止重复联系。');
      if(this.store.db.prepare(`SELECT id FROM contact_locks WHERE kind='initial' AND (job_id=? OR recruiter_id IN (${history.ids.map(()=>'?').join(',')||'NULL'})) LIMIT 1`).get(job.id,...history.ids))add('DUPLICATE_SEND','该岗位或招聘人的历史联系锁已保留，禁止重复首联。');
      if(history.hasConversation)add('ALREADY_CONTACTED','该招聘人已有已导入会话，应在会话助手处理，不重复首联。');
      if(!draft.content.trim())add('DRAFT_BLOCKED','最终文案为空。');
    }catch(error){add(error instanceof AppError?error.code:'POLICY_BLOCKED',error instanceof AppError?error.message:'无法核对发送上下文。');}
    return blocks;
  }
  private throwBlocks(blocks:SendBlock[]){if(blocks.length)throw new AppError(blocks[0].code,blocks.map(block=>block.message).join(' '));}
  async inspect(queueId:string,signal:AbortSignal){
    if(!this.store.config().bossReadOnlyConsent)throw new AppError('CONSENT_REQUIRED','请先保存 BOSS 只读访问授权。');
    const row=this.queue(queueId),job=this.store.getJob(row.job_id);if(!job||job.source!=='boss')throw new AppError('DEMO_SEND_FORBIDDEN','只能检查真实 BOSS 岗位。');
    const result=await this.transport.inspectCommunication(job,signal);signal.throwIfAborted();this.store.upsertJob({...result.job,alreadyContacted:result.job.alreadyContacted||result.inspection.alreadyContacted});return result.inspection;
  }
  async prepare(queueIds:string[],signal:AbortSignal):Promise<SendPlan>{
    if(this.current)throw new AppError('RUN_ACTIVE','已有发送任务运行中。');
    const unique=[...new Set(queueIds)];if(unique.length>this.policy().maxPerRun)throw new AppError('BATCH_LIMIT','选中数量超过单次上限。');
    const items:SendPlan['items']=[];
    for(const queueId of unique){
      const row=this.queue(queueId),job=this.store.getJob(row.job_id)!;let browserBlocks:SendBlock[]=[],deliveryKind:'direct'|'default-then-ai'='direct';
      // Inspection is read-only. Do not open an unknown "立即沟通" entry.
      if(job.source==='boss'&&!this.itemBlocks(queueId,'review',false).length){try{const info=await this.inspect(queueId,signal);deliveryKind=info.entryKind==='instant-send'?'default-then-ai':'direct';if(!info.identityBound||(!info.composerReady&&!info.canOpenPreview&&info.entryKind!=='instant-send'))browserBlocks.push({code:'NEEDS_HUMAN',message:info.message});}catch(error){browserBlocks.push({code:error instanceof AppError?error.code:'ADAPTER_CHANGED',message:error instanceof AppError?error.message:'页面检查未完成。'});}}
      const latest=this.store.getJob(job.id)!,draft=this.matching.draft(row.draft_id)!;
      items.push({queueId,jobId:job.id,title:job.title,company:job.company,recruiterId:latest.recruiterId,draftId:draft.id,draftVersion:draft.version,content:draft.content,deliveryKind,messageUnits:deliveryKind==='default-then-ai'?2:1,score:this.matching.assessment(job.id)?.score??null,blocks:[...this.baseBlocks(),...this.itemBlocks(queueId,'review'),...browserBlocks]});
    }
    const units=items.reduce((n,item)=>n+(item.messageUnits??1),0);if(units>this.policy().maxPerRun||this.budget().usedToday+units>this.policy().maxPerDay)for(const item of items)item.blocks.push({code:'MESSAGE_LIMIT',message:'默认招呼与 AI 文案分别占用一条额度，当前消息额度不足。'});
    const plan:SendPlan={id:randomUUID(),mode:'review',policyVersion:this.policy().version,expiresAt:new Date(this.clock()+5*60000).toISOString(),items};
    const stamp=digest(unique.map(id=>{try{return this.fingerprint(id);}catch{return id;}}));
    this.store.db.prepare('INSERT INTO send_plans VALUES(?,?,?,?,0)').run(plan.id,JSON.stringify(plan),stamp,plan.expiresAt);return plan;
  }
  commit(planId:string,gui:boolean){
    this.gui(gui);const row=this.store.db.prepare('SELECT * FROM send_plans WHERE id=?').get(planId) as Row|undefined;
    if(!row||row.used||Date.parse(row.expires_at)<this.clock())throw new AppError('CONFIRMATION_EXPIRED','发送确认已失效，请重新检查最终文案。');
    const plan=JSON.parse(row.detail_json) as SendPlan;
    if(plan.recoveryOutboxId)throw new AppError('INVALID_SEND_PLAN','续发计划只能通过独立确认入口执行。');
    this.throwBlocks(plan.items.flatMap(item=>item.blocks));
    if(digest(plan.items.map(item=>this.fingerprint(item.queueId)))!==row.context_hash)throw new AppError('CONTEXT_CHANGED','确认后内容或配置发生变化，请重新检查。');
    this.throwBlocks([...this.baseBlocks(),...plan.items.flatMap(item=>this.itemBlocks(item.queueId,'review'))]);
    const id=randomUUID(),context=this.context();
    this.store.transaction(()=>{this.store.db.prepare('UPDATE send_plans SET used=1 WHERE id=? AND used=0').run(planId);this.store.db.prepare('INSERT INTO send_authorizations VALUES(?,?,?,?,?,?,NULL)').run(id,'review',this.policy().version,context,JSON.stringify(plan.items.map(item=>({jobId:item.jobId,draftId:item.draftId,draftVersion:item.draftVersion,deliveryKind:item.deliveryKind,messageUnits:item.messageUnits}))),this.now());});
    return this.begin(plan.items.map(item=>item.queueId),'review',id,context,undefined,Object.fromEntries(plan.items.map(item=>[item.queueId,item.deliveryKind??'direct'])));
  }
  private followupContext(record:OutboxRecord){return digest([record,this.context(),this.store.getSetting('sendStopRevision')??0,this.matching.validateForSend(record.draftId).draft]);}
  private followupCheck(record:OutboxRecord){
    if(record.state!=='NEEDS_VERIFY'||record.deliveryKind!=='default-then-ai'||!['INTENT','PREPARED'].includes(record.phase)||record.confirmedUnits>1||!['CLICK_DISPATCHED','CONFIRMED'].includes(record.defaultPhase))throw new AppError('FOLLOWUP_NOT_ELIGIBLE','只能继续有记录证明 AI 从未提交的两条首联；提交结果不明的 AI 绝不重发。');
    const {job,draft,assessment}=this.matching.validateForSend(record.draftId);
    if(record.policyVersion!==this.policy().version||record.resumeVersion!==draft.resumeVersion||record.draftVersion!==draft.version||record.content!==draft.content||record.recruiterId!==job.recruiterId)throw new AppError('CONTEXT_CHANGED','原发送规则、事实、文案或目标已变化，不能续发。');
    if(this.statusNeedsVerify()!==1)throw new AppError('NEEDS_VERIFY','还有其他不确定发送，请先分别核验。');
    const queue=this.store.db.prepare('SELECT id FROM review_queue WHERE draft_id=? AND job_id=?').get(draft.id,job.id) as Row|undefined;if(!queue)throw new AppError('QUEUE_NOT_FOUND','原审核条目不存在。');
    this.throwBlocks([...this.baseBlocks(true).filter(b=>!['NEEDS_VERIFY','EMERGENCY_STOPPED'].includes(b.code)),...this.itemBlocks(queue.id,'review').filter(b=>!['DUPLICATE_SEND','ALREADY_CONTACTED'].includes(b.code))]);
    return {job,draft,assessment,queue};
  }
  async prepareFollowup(id:string,signal:AbortSignal):Promise<SendPlan>{
    if(this.current)throw new AppError('RUN_ACTIVE','已有发送任务运行中。');const record=this.record(id),value=this.followupCheck(record);
    if(!this.transport.verifyContact)throw new AppError('ADAPTER_CHANGED','适配器不能核验默认招呼。');
    const proof=await this.transport.verifyContact(value.job,signal);if(proof.state!=='CONFIRMED'||!proof.messageId)throw new AppError('NEEDS_VERIFY','当前目标的默认招呼仍缺少可靠回执，不能继续 AI。');
    const plan:SendPlan={id:randomUUID(),mode:'review',policyVersion:record.policyVersion,recoveryOutboxId:id,expiresAt:new Date(this.clock()+300000).toISOString(),items:[{queueId:value.queue.id,jobId:record.jobId,title:record.title,company:record.company,recruiterId:record.recruiterId,draftId:record.draftId,draftVersion:record.draftVersion,content:record.content,deliveryKind:'direct',messageUnits:1,score:value.assessment.score,blocks:[]}]};
    this.store.db.prepare('INSERT INTO send_plans VALUES(?,?,?,?,0)').run(plan.id,JSON.stringify({...plan,defaultProof:digest(proof.messageId)}),this.followupContext(record),plan.expiresAt);return plan;
  }
  commitFollowup(planId:string,gui:boolean){
    this.gui(gui);if(this.current)throw new AppError('RUN_ACTIVE','已有发送任务运行中。');const saved=this.store.db.prepare('SELECT * FROM send_plans WHERE id=?').get(planId) as Row|undefined;
    if(!saved||saved.used||Date.parse(saved.expires_at)<this.clock())throw new AppError('CONFIRMATION_EXPIRED','续发确认已失效，请重新只读检查。');
    const plan=JSON.parse(saved.detail_json) as SendPlan&{defaultProof:string};if(!plan.recoveryOutboxId)throw new AppError('INVALID_SEND_PLAN','不是单条 AI 续发计划。');
    const record=this.record(plan.recoveryOutboxId);this.followupCheck(record);if(saved.context_hash!==this.followupContext(record))throw new AppError('CONTEXT_CHANGED','续发检查后上下文已变化。');
    const controller=new AbortController(),stamp=this.context(),stopRevision=this.store.getSetting('sendStopRevision')??0;
    this.store.transaction(()=>{this.store.db.prepare('UPDATE send_plans SET used=1 WHERE id=?').run(plan.id);this.store.db.prepare('INSERT INTO send_authorizations VALUES(?,?,?,?,?,?,NULL)').run(randomUUID(),'review',record.policyVersion,stamp,JSON.stringify({outboxId:record.id,remainingAI:1,planId:plan.id}),this.now());this.store.event(record.runId,'AI_FOLLOWUP_AUTHORIZED','用户重新确认仅继续从未提交的 AI 文案；不重复平台默认招呼，保留原意图与两条额度。');});
    this.heartbeat=this.clock();const watchdog=setInterval(()=>{const gap=this.clock()-this.heartbeat;if(gap>30000||gap<0)controller.abort(new AppError('SYSTEM_RESUMED','检测到休眠或时钟跳变，已停止续发。'));this.heartbeat=this.clock();},1000);watchdog.unref();
    const promise=Promise.resolve().then(()=>this.executeFollowup(record,plan.defaultProof,stamp,stopRevision,controller.signal)).finally(()=>{clearInterval(watchdog);if(this.current?.id===record.runId)this.current=undefined;});this.current={id:record.runId,mode:'review',controller,promise};return {runId:record.runId};
  }
  private async executeFollowup(record:OutboxRecord,expectedProof:string,stamp:string,stopRevision:unknown,signal:AbortSignal){
    let resumed=false;const check=()=>{signal.throwIfAborted();const gap=this.clock()-this.heartbeat;if(gap>30000||gap<0)throw new AppError('SYSTEM_RESUMED','检测到休眠或时钟跳变，已停止续发。');if(stamp!==this.context()||stopRevision!==(this.store.getSetting('sendStopRevision')??0))throw new AppError('CONTEXT_CHANGED','续发期间配置、事实或急停状态已变化。');this.throwBlocks(this.baseBlocks(true).filter(b=>!['NEEDS_VERIFY','EMERGENCY_STOPPED'].includes(b.code)));this.matching.validateForSend(record.draftId);};
    try{
      check();const {job}=this.followupCheck(this.record(record.id));if(!await this.health(signal))throw new AppError('LLM_UNAVAILABLE','模型服务不可用，未继续 AI。');check();
      const last=this.budget().lastActionAt;while(last!==null&&this.clock()-last<this.policy().minIntervalSeconds*1000){await delay(250,undefined,{signal});check();}
      const proof=await this.transport.verifyContact!(job,signal);if(proof.state!=='CONFIRMED'||!proof.messageId||digest(proof.messageId)!==expectedProof)throw new AppError('CONVERSATION_CHANGED','默认招呼回执或当前会话已变化，未继续 AI。');check();
      this.store.transaction(()=>{const latest=this.record(record.id);this.followupCheck(latest);this.store.db.prepare("UPDATE send_outbox SET state='SENDING',default_phase='CONFIRMED',default_proof=?,confirmed_units=1,version=version+1 WHERE id=?").run(expectedProof,record.id);this.store.db.prepare("UPDATE runs SET state='SENDING',finished_at=NULL,error_code=NULL,sent_count=sent_count+?,needs_verify_count=max(0,needs_verify_count-1) WHERE id=?").run(1-latest.confirmedUnits,record.runId);});resumed=true;
      await this.transport.prepareGreeting(job,record.content,signal,record.id,proof.messageId);check();
      this.store.db.prepare("UPDATE send_outbox SET phase='PREPARED',version=version+1 WHERE id=?").run(record.id);this.store.event(record.runId,'GREETING_PREPARED','仅 AI 文案编辑完成，平台默认招呼没有重发。');check();
      this.store.db.prepare("UPDATE send_outbox SET phase='CLICK_DISPATCHED',version=version+1 WHERE id=?").run(record.id);this.store.setSetting('lastSendActionAt',this.now());this.store.event(record.runId,'SEND_CLICK_DISPATCHED','提交重新确认的单条 AI 文案。');
      await this.transport.submitGreeting(job,record.content,signal,record.id,proof.messageId);this.store.setSetting('lastSendActionAt',this.now());const result=await this.transport.verifyGreeting(job,record.content,signal);
      if(result.state!=='CONFIRMED')throw new AppError('NEEDS_VERIFY',result.message);this.confirm(record.id,result.messageId??'visible-confirmation');this.store.finishRun(record.runId,'COMPLETED');this.store.db.prepare('UPDATE runs SET checkpoint_json=NULL WHERE id=?').run(record.runId);this.store.event(record.runId,'SENT_CONFIRMED','默认招呼及重新确认的 AI 文案均有页面回执；原意图完成。');
    }catch(error){if(resumed){this.store.db.prepare("UPDATE send_outbox SET state='NEEDS_VERIFY',verify_detail=?,version=version+1 WHERE id=? AND state='SENDING'").run('AI 续发已停止；请核验，禁止自动重发。',record.id);this.store.db.prepare('UPDATE runs SET needs_verify_count=needs_verify_count+1 WHERE id=?').run(record.runId);}this.store.finishRun(record.runId,'NEEDS_HUMAN','NEEDS_VERIFY');this.store.event(record.runId,'NEEDS_VERIFY',error instanceof AppError?error.message:'AI 续发停止，保留原意图及去重锁。');}
  }
  startAuto(){
    if(!this.isAutoAuthorized())throw new AppError('CONSENT_REQUIRED','Auto 尚未在界面启用，MCP 无法代为授权。');
    this.throwBlocks(this.baseBlocks());
    const rows=this.store.db.prepare("SELECT id FROM review_queue WHERE state IN ('PENDING','REVIEWED') ORDER BY created_at,id").all() as Row[];
    const ids=rows.filter(row=>!this.itemBlocks(row.id,'auto').length).slice(0,this.policy().maxPerRun).map(row=>row.id);
    if(!ids.length)throw new AppError('NO_ELIGIBLE_JOBS','队列中没有满足全部条件的真实岗位。');
    return this.begin(ids,'auto',this.autoAuthorization!.id,this.autoAuthorization!.context);
  }
  private begin(ids:string[],mode:'review'|'auto',authorizationId:string,context:string,resumeId?:string,kinds?:Record<string,'direct'|'default-then-ai'>){
    if(this.current)throw new AppError('RUN_ACTIVE','已有发送任务运行中。');
    if(!resumeId&&this.store.db.prepare("SELECT id FROM runs WHERE kind='send' AND state IN ('PAUSED','NEEDS_HUMAN') AND checkpoint_json IS NOT NULL LIMIT 1").get())throw new AppError('CHECKPOINT_PENDING','请先继续或结束已有发送任务。');
    const resumedToday=resumeId&&(this.store.db.prepare('SELECT created_at FROM send_outbox WHERE run_id=?').all(resumeId) as Row[]).some(row=>this.day(Date.parse(row.created_at))===this.day(this.clock()));
    if(this.budget().runsToday>=this.policy().maxRunsPerDay&&!resumedToday)throw new AppError('DAILY_RUN_LIMIT','已达到每日发送轮次上限。');
    const run=resumeId?this.store.getRun(resumeId)!:this.store.createRun('boss');
    const checkpoint:Checkpoint=resumeId?JSON.parse((this.store.db.prepare('SELECT checkpoint_json FROM runs WHERE id=?').get(run.id) as Row).checkpoint_json):{kinds,queueIds:ids,nextIndex:0,fingerprints:Object.fromEntries(ids.map(id=>[id,this.fingerprint(id)])),policyVersion:this.policy().version,authorizationId,context};
    checkpoint.authorizationId=authorizationId;
    this.store.db.prepare("UPDATE runs SET execution_mode=?,kind='send',state='PREFLIGHT',checkpoint_json=?,finished_at=NULL,error_code=NULL WHERE id=?").run(mode,JSON.stringify(checkpoint),run.id);
    const controller=new AbortController();this.heartbeat=this.clock();
    const watchdog=setInterval(()=>{const gap=this.clock()-this.heartbeat;if(gap>30000||gap<0){controller.abort(new AppError('SYSTEM_RESUMED','检测到休眠或时钟跳变，请核验并手动继续。'));}this.heartbeat=this.clock();},1000);watchdog.unref();
    const promise=Promise.resolve().then(()=>this.execute(run.id,mode,checkpoint,controller.signal)).finally(()=>{clearInterval(watchdog);if(this.current?.id===run.id)this.current=undefined;});
    this.current={id:run.id,mode,controller,promise};return {runId:run.id};
  }
  private guard(checkpoint:Checkpoint,signal:AbortSignal,mode:'review'|'auto',reserved=false){
    signal.throwIfAborted();const gap=this.clock()-this.heartbeat;if(gap>30000||gap<0)throw new AppError('SYSTEM_RESUMED','检测到休眠或时钟跳变，已停止后续动作。');
    if(checkpoint.context!==this.context()||checkpoint.policyVersion!==this.policy().version)throw new AppError('CONTEXT_CHANGED','简历、配置或发送规则已变化，请重新确认。');
    if(mode==='auto'&&!this.isAutoAuthorized())throw new AppError('CONSENT_REQUIRED','Auto 授权已失效。');
    this.throwBlocks(this.baseBlocks(reserved));
  }
  private async execute(runId:string,mode:'review'|'auto',checkpoint:Checkpoint,signal:AbortSignal){
    this.store.event(runId,'SEND_RUN_STARTED',`${mode==='auto'?'Auto':'人工确认'}任务开始，发送规则 v${checkpoint.policyVersion}；授权 ${checkpoint.authorizationId}。`);
    let intent:OutboxRecord|undefined;
    try{
      for(let index=checkpoint.nextIndex;index<checkpoint.queueIds.length;index++){
        this.guard(checkpoint,signal,mode);const queueId=checkpoint.queueIds[index];
        this.throwBlocks(this.itemBlocks(queueId,mode,false));
        if(this.fingerprint(queueId)!==checkpoint.fingerprints[queueId])throw new AppError('CONTEXT_CHANGED','待发文案或队列版本已变化。');
        const last=this.budget().lastActionAt;
        if(last!==null&&this.policy().minIntervalSeconds*1000-(this.clock()-last)>0){this.store.event(runId,'INTERVAL_WAIT','等待配置的最小发送间隔。');while(this.policy().minIntervalSeconds*1000-(this.clock()-last)>0){await delay(Math.min(1000,this.policy().minIntervalSeconds*1000-(this.clock()-last)),undefined,{signal});this.guard(checkpoint,signal,mode);}}
        this.guard(checkpoint,signal,mode);
        if(!await this.health(signal))throw new AppError('LLM_UNAVAILABLE','模型服务不可用，队列已保留，停止后续发送。');
        this.guard(checkpoint,signal,mode);
        const inspected=await this.inspect(queueId,signal);this.guard(checkpoint,signal,mode);
        if(!inspected.identityBound||(!inspected.composerReady&&!inspected.canOpenPreview&&inspected.entryKind!=='instant-send'))throw new AppError('NEEDS_HUMAN',inspected.message);
        this.throwBlocks(this.itemBlocks(queueId,mode));
        // Read-only capture can refresh timestamps and recruiter ID; bind the exact refreshed context.
        if(this.fingerprint(queueId)!==checkpoint.fingerprints[queueId])throw new AppError('CONTEXT_CHANGED','页面检查后目标身份或文案已变化，请重新确认。');
        const kind=inspected.entryKind==='instant-send'?'default-then-ai':'direct',units=kind==='default-then-ai'?2:1;
        if(checkpoint.kinds?.[queueId]&&checkpoint.kinds[queueId]!==kind)throw new AppError('CONTEXT_CHANGED','实际发送条数或入口发生变化，请重新确认。');
        if(kind==='default-then-ai'&&(!this.transport.startContact||!this.transport.verifyContact))throw new AppError('ADAPTER_CHANGED','适配器不支持两条首联流程。');
        const usedRun=Number((this.store.db.prepare('SELECT coalesce(sum(message_units),0) n FROM send_outbox WHERE run_id=?').get(runId) as Row).n);
        if(usedRun+units>this.policy().maxPerRun){this.store.event(runId,'MESSAGE_LIMIT','本轮剩余消息额度不足，未处理条目留在队列。');break;}
        this.checkGate(units);
        const row=this.queue(queueId),{job,draft}=this.matching.validateForSend(row.draft_id);
        const id=randomUUID(),created=this.now();
        this.store.transaction(()=>{
          this.guard(checkpoint,signal,mode);this.throwBlocks(this.itemBlocks(queueId,mode));
          try{this.store.db.prepare(`INSERT INTO send_outbox(id,job_id,recruiter_id,idem_key,draft_id,state,authorized_at,verify_detail,run_id,phase,policy_version,resume_version,draft_version,content_hash,content_snapshot,created_at,message_units,delivery_kind,default_phase) VALUES(?,?,?,?,?,'SENDING',?,'',?,'INTENT',?,?,?,?,?,?,?,?,?)`).run(id,job.id,job.recruiterId!,digest(['boss',job.platformJobId,job.recruiterId]),draft.id,created,runId,checkpoint.policyVersion,draft.resumeVersion,draft.version,digest(draft.content),draft.content,created,units,kind,kind==='default-then-ai'?'PENDING':'NOT_APPLICABLE');}catch{throw new AppError('DUPLICATE_SEND','岗位或招聘人已锁定发送意图，禁止重试。');}
          checkpoint.nextIndex=index+1;this.store.db.prepare("UPDATE runs SET state='SENDING',checkpoint_json=? WHERE id=?").run(JSON.stringify(checkpoint),runId);
          this.store.event(runId,'SEND_INTENT',`发送意图 ${id} 已持久化；草稿 v${draft.version}，事实 v${draft.resumeVersion}。`);
        });
        intent=this.record(id);
        let initialMessageId:string|undefined;
        if(kind==='default-then-ai'){
          this.store.db.prepare("UPDATE send_outbox SET default_phase='CLICK_DISPATCHED',version=version+1 WHERE id=?").run(id);this.store.setSetting('lastSendActionAt',this.now());this.store.event(runId,'DEFAULT_GREETING_DISPATCHED','首次点击将发送平台默认招呼；不是预览动作。');
          await this.transport.startContact!(job,signal,id);this.store.setSetting('lastSendActionAt',this.now());
          const proof=await this.transport.verifyContact!(job,signal);if(proof.state!=='CONFIRMED'||!proof.messageId)throw new AppError('NEEDS_VERIFY','平台默认招呼未确定送达，禁止追加或重新首联。');initialMessageId=proof.messageId;
          this.store.transaction(()=>{this.store.db.prepare("UPDATE send_outbox SET default_phase='CONFIRMED',default_proof=?,confirmed_units=1,version=version+1 WHERE id=?").run(digest(proof.messageId),id);this.store.db.prepare('UPDATE runs SET sent_count=sent_count+1 WHERE id=?').run(runId);this.store.event(runId,'DEFAULT_GREETING_CONFIRMED','平台默认招呼已确认；AI 文案尚未提交。');});
          const lastAction=this.budget().lastActionAt!;while(this.clock()-lastAction<this.policy().minIntervalSeconds*1000){await delay(Math.min(1000,this.policy().minIntervalSeconds*1000-(this.clock()-lastAction)),undefined,{signal});this.guard(checkpoint,signal,mode,true);}
          if(!await this.health(signal))throw new AppError('LLM_UNAVAILABLE','模型不可用，已停在默认招呼之后，不能继续追加。');
          this.guard(checkpoint,signal,mode,true);
        }
        await this.transport.prepareGreeting(job,draft.content,signal,id,initialMessageId);
        // Ignore this intent only for global pending-verification guard; no other intent may proceed.
        this.guard(checkpoint,signal,mode,true);this.matching.validateForSend(draft.id);
        this.store.db.prepare("UPDATE send_outbox SET phase='PREPARED',version=version+1 WHERE id=?").run(id);
        this.store.event(runId,'GREETING_PREPARED','目标身份和最终文案已再次核对，尚未认定发送成功。');
        signal.throwIfAborted();
        this.store.db.prepare("UPDATE send_outbox SET phase='CLICK_DISPATCHED',version=version+1 WHERE id=?").run(id);
        this.store.setSetting('lastSendActionAt',this.now());
        this.store.event(runId,'SEND_CLICK_DISPATCHED','准备提交已确认文案；后续结果不确定时禁止重发。');
        await this.transport.submitGreeting(job,draft.content,signal,id,initialMessageId);
        this.store.setSetting('lastSendActionAt',this.now());
        this.store.db.prepare("UPDATE runs SET state='VERIFYING' WHERE id=?").run(runId);
        const verification=await this.transport.verifyGreeting(job,draft.content,signal);
        if(verification.state!=='CONFIRMED')throw new AppError('NEEDS_VERIFY',verification.message);
        this.confirm(id,verification.messageId??'visible-confirmation');
        this.store.event(runId,'SENT_CONFIRMED',`发送意图 ${id} 已通过页面确认；消息证据 ${digest(verification.messageId??'visible-confirmation').slice(0,16)}。`);
        intent=undefined;
      }
      this.store.finishRun(runId,'COMPLETED');this.store.db.prepare('UPDATE runs SET checkpoint_json=NULL WHERE id=?').run(runId);this.store.event(runId,'SEND_RUN_COMPLETED','发送任务完成。');
    }catch(error){
      const code=signal.aborted?(signal.reason instanceof AppError?signal.reason.code:'USER_PAUSED'):error instanceof AppError?error.code:'SEND_FAILED';
      if(intent){const current=this.record(intent.id);if(current.defaultPhase==='CONFIRMED'&&current.phase!=='CLICK_DISPATCHED'&&['CONVERSATION_REJECTED','CONVERSATION_CHANGED'].includes(code)){this.store.db.prepare("UPDATE send_outbox SET state='PARTIAL_CONFIRMED',verify_detail='默认招呼已发；会话已变化或拒绝，AI 未提交并跳过。',version=version+1 WHERE id=?").run(intent.id);this.store.db.prepare('UPDATE runs SET processed_count=processed_count+1 WHERE id=?').run(runId);this.store.finishRun(runId,'NEEDS_HUMAN',code);this.store.event(runId,'AI_FOLLOWUP_CANCELLED','默认招呼后会话变化，未点击 AI 发送。');return;}}
      if(intent){this.store.db.prepare("UPDATE send_outbox SET state='NEEDS_VERIFY',verify_detail=?,version=version+1 WHERE id=? AND state='SENDING'").run('动作可能已提交，请检查 BOSS 可见结果，禁止自动重发。',intent.id);this.store.db.prepare('UPDATE runs SET needs_verify_count=needs_verify_count+1 WHERE id=?').run(runId);this.store.setSetting('sendEmergencyStop',true);}
      this.store.finishRun(runId,signal.aborted&&!intent?'PAUSED':'NEEDS_HUMAN',intent?'NEEDS_VERIFY':code);
      this.store.event(runId,intent?'NEEDS_VERIFY':code,error instanceof AppError?error.message:signal.aborted?'任务已暂停，保留持久化检查点。':'发送已停止，请检查页面和状态。');
    }
  }
  private confirm(id:string,messageId:string){this.store.transaction(()=>{const record=this.record(id);if(!['SENDING','NEEDS_VERIFY'].includes(record.state))return;this.store.db.prepare("UPDATE send_outbox SET state='SENT_CONFIRMED',confirmed_units=message_units,phase='CONFIRMED',sent_at=?,verify_detail=?,version=version+1 WHERE id=?").run(this.now(),'页面消息确认：'+digest(messageId).slice(0,20),id);this.store.db.prepare('UPDATE runs SET processed_count=processed_count+1,sent_count=sent_count+?,needs_verify_count=max(0,needs_verify_count-?) WHERE id=?').run(record.messageUnits-record.confirmedUnits,record.state==='NEEDS_VERIFY'?1:0,record.runId);});}
  pause(id?:string){if(this.current&&(!id||this.current.id===id))this.current.controller.abort();return {accepted:true};}
  stop(){this.store.setSetting('sendEmergencyStop',true);this.store.setSetting('sendStopRevision',(this.store.getSetting<number>('sendStopRevision')??0)+1);this.revokeAuto();this.pause();return {stopped:true};}
  reset(gui:boolean){this.gui(gui);if(this.current)throw new AppError('RUN_ACTIVE','请等待当前动作停止。');if(this.status().needsVerify)throw new AppError('NEEDS_VERIFY','请先核验不确定发送记录。');this.store.setSetting('sendEmergencyStop',false);return {reset:true};}
  async verify(id:string,signal:AbortSignal){
    if(this.current)throw new AppError('RUN_ACTIVE','请等待当前任务停止后核验。');const record=this.record(id);
    if(record.state!=='NEEDS_VERIFY')return {state:record.state};
    if(record.deliveryKind==='default-then-ai'&&record.defaultPhase!=='CONFIRMED')return {state:'UNKNOWN',message:'默认招呼未确认，请人工核验两条消息，禁止自动续发。'};
    const job=this.store.getJob(record.jobId)!;const result=await this.transport.verifyGreeting(job,record.content,signal);
    if(result.state==='CONFIRMED'){this.confirm(id,result.messageId??'visible-confirmation');this.store.event(record.runId,'RECONCILED_CONFIRMED',`发送意图 ${id} 经只读核验已确认，未重新发送。`);}return result;
  }
  resolve(id:string,version:number,result:'sent'|'not-sent'|'default-only',gui:boolean){
    this.gui(gui);if(this.current)throw new AppError('RUN_ACTIVE','请先等待任务停止。');const record=this.record(id);
    if(record.version!==version||record.state!=='NEEDS_VERIFY')throw new AppError('VERSION_CONFLICT','记录已变化，请刷新。');
    if(result==='not-sent'&&record.confirmedUnits>0)throw new AppError('PARTIAL_DELIVERY','默认招呼已经确认，请选择仅默认已发并跳过 AI。');
    if(result==='default-only'&&record.deliveryKind!=='default-then-ai')throw new AppError('INVALID_RESOLUTION','此记录不是两条首联。');
    const confirmed=result==='sent'?record.messageUnits:result==='default-only'?1:0;
    this.store.transaction(()=>{this.store.db.prepare('UPDATE send_outbox SET state=?,sent_at=?,verify_detail=?,version=version+1,confirmed_units=? WHERE id=?').run(result==='sent'?'MANUALLY_CONFIRMED':result==='default-only'?'PARTIAL_CONFIRMED':'NOT_SENT',confirmed?this.now():null,result==='sent'?'用户在 BOSS 页面人工确认已发送；不是自动页面核验。':result==='default-only'?'仅默认招呼已发，AI 跳过；去重锁保留。':'用户确认未发送并跳过；幂等锁保留，不自动补发。',confirmed,id);this.store.db.prepare('UPDATE runs SET processed_count=processed_count+1,sent_count=sent_count+?,needs_verify_count=max(0,needs_verify_count-1) WHERE id=?').run(confirmed-record.confirmedUnits,record.runId);});
    this.store.event(record.runId,'MANUAL_RECONCILIATION',`发送意图 ${id} 已人工处理，结果 ${result}；不执行补发。`);return {resolved:true};
  }
  resume(id:string,gui:boolean){
    this.gui(gui);if(this.current)throw new AppError('RUN_ACTIVE','已有任务运行中。');this.throwBlocks(this.baseBlocks());
    const row=this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row|undefined;
    if(!row||row.kind!=='send'||!['PAUSED','NEEDS_HUMAN'].includes(row.state)||!row.checkpoint_json)throw new AppError('CHECKPOINT_NOT_FOUND','没有可继续的发送检查点。');
    const checkpoint=JSON.parse(row.checkpoint_json) as Checkpoint;
    if(checkpoint.context!==this.context())throw new AppError('CONTEXT_CHANGED','配置或事实已变化，请结束本轮并重新审核。');
    if(row.execution_mode==='auto'&&!this.isAutoAuthorized())throw new AppError('CONSENT_REQUIRED','请先在界面重新启用 Auto。');
    const auth=randomUUID();this.store.db.prepare('INSERT INTO send_authorizations VALUES(?,?,?,?,?,?,NULL)').run(auth,row.execution_mode,this.policy().version,this.context(),JSON.stringify({resumeRun:id,nextIndex:checkpoint.nextIndex}),this.now());
    return this.begin(checkpoint.queueIds,row.execution_mode,auth,this.context(),id);
  }
  checkpoint(id:string){
    const row=this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row|undefined;
    if(!row||!row.checkpoint_json||row.kind!=='send')throw new AppError('CHECKPOINT_NOT_FOUND','没有可继续的发送检查点。');
    const checkpoint=JSON.parse(row.checkpoint_json) as Checkpoint;
    return {runId:id,mode:row.execution_mode,contextUnchanged:checkpoint.context===this.context(),remaining:checkpoint.queueIds.slice(checkpoint.nextIndex).map(queueId=>{const item=this.queue(queueId),job=this.store.getJob(item.job_id)!,draft=this.matching.draft(item.draft_id)!;return {title:job.title,company:job.company,content:draft.content,blocks:this.itemBlocks(queueId,row.execution_mode)};}),blocks:this.baseBlocks()};
  }
  cancel(id:string,gui:boolean){this.gui(gui);if(this.current)throw new AppError('RUN_ACTIVE','请先暂停任务。');const run=this.store.getRun(id);if(!run||run.kind!=='send')throw new AppError('RUN_NOT_FOUND','发送任务不存在。');this.store.finishRun(id,'COMPLETED','USER_CANCELLED');this.store.db.prepare('UPDATE runs SET checkpoint_json=NULL WHERE id=?').run(id);this.store.event(id,'SEND_RUN_CANCELLED','用户结束本轮；已有发送意图和去重锁保留。');return {cancelled:true};}
  async close(){this.pause();await this.current?.promise;}
}
