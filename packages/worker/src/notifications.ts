import {createHash} from 'node:crypto';
import {AppError,NotificationPreferences,NotificationSave,type NotificationSettings,type NotificationStatus} from '@jobpilot/contracts';
import type {Store} from '@jobpilot/store';
import {readEnvironmentValues,saveEnvironmentValues} from './environment.js';

const MIN_INTERVAL=60000;
const defaults:NotificationSettings={enabled:false,queueReview:true,chatReview:true,taskAttention:true};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Delivery={receipts:string[];lastAttemptAt:string|null;lastDeliveredAt:string|null;lastError:string|null;retryAt:string|null;failures:number};
const emptyDelivery=():Delivery=>({receipts:[],lastAttemptAt:null,lastDeliveredAt:null,lastError:null,retryAt:null,failures:0});
type Snapshot={keys:string[];counts:NotificationStatus['pending']};

export function validateWebhook(value:string){
  try{
    const url=new URL(value),key=url.searchParams.get('key');
    if(url.protocol!=='https:'||url.hostname!=='qyapi.weixin.qq.com'||url.port||url.username||url.password||url.hash||url.pathname!=='/cgi-bin/webhook/send'||[...url.searchParams.keys()].length!==1||!key||!/^[A-Za-z0-9_-]{8,256}$/.test(key))throw new Error();
    return url.href;
  }catch{throw new AppError('NOTIFICATION_URL_INVALID','请填写企业微信群机器人的 HTTPS Webhook 地址（qyapi.weixin.qq.com）。');}
}

export class NotificationService{
  private timer:ReturnType<typeof setInterval>|undefined;
  private controller:AbortController|undefined;
  private task:Promise<void>|undefined;
  private stopped=false;
  private clock:()=>number;
  private fetcher:typeof fetch;
  constructor(private store:Store,private environmentPath:()=>string,private suspended:()=>boolean,private automatedChats:()=>string[],private options:{fetch?:typeof fetch;clock?:()=>number;intervalMs?:number;timeoutMs?:number}={}){
    this.clock=options.clock??Date.now;this.fetcher=options.fetch??fetch;
  }
  start(){if(this.timer||this.stopped)return;this.timer=setInterval(()=>{void this.check().catch(()=>{});},this.options.intervalMs??5000);this.timer.unref();}
  private settings(){const parsed=NotificationPreferences.safeParse(this.store.getSetting('notificationSettings'));return parsed.success?parsed.data:{...defaults};}
  private delivery(){return {...emptyDelivery(),...this.store.getSetting<Delivery>('notificationDelivery')};}
  private connection(){
    try{
      const values=readEnvironmentValues(this.environmentPath(),true),raw=values.WECOM_WEBHOOK_URL||values.HOOK_URL||'';
      return {url:raw?validateWebhook(raw):'',error:null};
    }catch(error){return {url:'',error:error instanceof AppError?error.message:'无法读取企业微信配置。'};}
  }
  private snapshot():Snapshot{
    const settings=this.settings(),keys:string[]=[],counts={queue:0,chats:0,verification:0,tasks:0},db=this.store.db;
    if(settings.queueReview){
      const rows=db.prepare("SELECT q.id,q.draft_id,q.state,COALESCE(json_extract(d.detail_json,'$.version'),1) version FROM review_queue q JOIN jobs j ON j.id=q.job_id JOIN greeting_drafts d ON d.id=q.draft_id WHERE j.source='boss' AND q.state IN ('PENDING','BLOCKED','STALE') AND NOT EXISTS(SELECT 1 FROM send_outbox s WHERE s.job_id=q.job_id)").all();
      counts.queue=rows.length;for(const row of rows)keys.push(hash(['queue',row.id,row.draft_id,row.version,row.state]));
    }
    if(settings.chatReview){
      const auto=new Set(this.automatedChats());
      const rows=db.prepare("SELECT id,state,last_inbound_id,snapshot_json FROM chat_conversations WHERE state IN ('REVIEW','REPLY_NEEDED')").all();
      for(const row of rows){if(row.state==='REPLY_NEEDED'&&auto.has(String(row.id)))continue;let messages;try{messages=JSON.parse(String(row.snapshot_json)).messages;}catch{messages=[];}counts.chats++;keys.push(hash(['chat',row.id,row.state,row.last_inbound_id??hash(messages)]));}
    }
    if(settings.taskAttention){
      const intents=db.prepare("SELECT 'initial' kind,id FROM send_outbox WHERE state='NEEDS_VERIFY' UNION ALL SELECT 'reply' kind,id FROM chat_outbox WHERE state='NEEDS_VERIFY'").all();
      counts.verification=intents.length;for(const row of intents)keys.push(hash(['verify',row.kind,row.id]));
      // Resolved verification runs remain historical records; they are not new pending work.
      const runs=db.prepare("SELECT r.id,r.error_code FROM runs r WHERE r.source='boss' AND r.state='NEEDS_HUMAN' AND COALESCE(r.error_code,'')<>'NEEDS_VERIFY' AND NOT EXISTS(SELECT 1 FROM runs newer WHERE newer.source='boss' AND newer.kind=r.kind AND newer.rowid>r.rowid)").all();
      counts.tasks=runs.length;for(const row of runs)keys.push(hash(['run',row.id,row.error_code]));
    }
    return {keys:keys.sort(),counts};
  }
  status():NotificationStatus{
    const settings=this.settings(),connection=this.connection(),delivery=this.delivery();
    const changed=connection.url&&this.store.getSetting('notificationDestination')!==hash(connection.url);
    return {settings,configured:!!connection.url,error:connection.error??(settings.enabled&&changed?'Webhook 已变化，请在应用中重新保存通知配置。':null),pending:this.snapshot().counts,lastAttemptAt:delivery.lastAttemptAt,lastDeliveredAt:delivery.lastDeliveredAt,lastError:delivery.lastError,retryAt:delivery.retryAt,busy:!!this.task};
  }
  save(payload:unknown,gui:boolean){
    if(!gui)throw new AppError('GUI_AUTH_REQUIRED','请在应用设置中保存通知配置。');
    const input=NotificationSave.parse(payload),{webhookUrl,clearWebhook,...settings}=input;
    let url='';
    if(clearWebhook&&webhookUrl)throw new AppError('NOTIFICATION_URL_INVALID','填写新地址与清除地址不能同时选择。');
    if(!clearWebhook)url=webhookUrl?validateWebhook(webhookUrl):this.connection().url;
    if(settings.enabled&&!url)throw new AppError('NOTIFICATION_NOT_CONFIGURED','请先填写有效的企业微信 Webhook 地址。');
    if(clearWebhook||webhookUrl)saveEnvironmentValues(this.environmentPath(),{WECOM_WEBHOOK_URL:url,...(clearWebhook?{HOOK_URL:''}:{})});
    const changed=this.store.getSetting('notificationDestination')!==hash(url);
    this.controller?.abort();
    this.store.setSetting('notificationSettings',settings);this.store.setSetting('notificationDestination',hash(url));
    const previous=this.delivery();this.store.setSetting('notificationDelivery',{...previous,receipts:changed?[]:previous.receipts,lastError:null,retryAt:null,failures:0});
    return this.status();
  }
  private content(snapshot:Snapshot){
    const {queue,chats,verification,tasks}=snapshot.counts,lines=['JobPilot · 需要你处理'];
    if(queue)lines.push(`首联草稿待审核：${queue} 条。请回 Mac 打开“审核队列”，核对岗位和文案。`);
    if(chats)lines.push(`BOSS 会话待回复或需人工处理：${chats} 个。可在手机 BOSS 查看消息，回 Mac 打开“会话助手”处理。`);
    if(verification)lines.push(`发送结果待核验：${verification} 条。请先核对 BOSS 历史，再在 JobPilot 标记结果，勿直接重发。`);
    if(tasks)lines.push(`任务需人工处理：${tasks} 个。请回 Mac 查看“执行记录”，处理登录、验证或任务异常。`);
    lines.push('BOSS 消息页：https://www.zhipin.com/web/geek/chat','这是单向通知，不能在企业微信回复以批准发送；通知不包含简历、草稿或聊天正文。');
    return lines.join('\n');
  }
  private async post(url:string,content:string,signal:AbortSignal){
    const response=await this.fetcher(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({msgtype:'text',text:{content}}),signal:AbortSignal.any([signal,AbortSignal.timeout(this.options.timeoutMs??10000)])});
    if(!response.ok)throw new AppError('NOTIFICATION_HTTP_ERROR',`企业微信通知请求失败（HTTP ${response.status}）。`);
    const reader=response.body?.getReader();if(!reader)throw new AppError('NOTIFICATION_RESPONSE_INVALID','企业微信返回了无效结果。');
    let bytes=0;const chunks:Uint8Array[]=[];
    try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>16384)throw new Error();chunks.push(value);}}catch{await reader.cancel().catch(()=>{});throw new AppError('NOTIFICATION_RESPONSE_INVALID','企业微信返回了无效结果。');}finally{reader.releaseLock();}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('NOTIFICATION_RESPONSE_INVALID','企业微信返回了无效结果。');}
    if(result?.errcode!==0)throw new AppError('NOTIFICATION_REJECTED',`企业微信未接收通知${Number.isSafeInteger(result?.errcode)?`（错误码 ${result.errcode}）`:''}，请检查机器人配置。`);
  }
  private async deliver(url:string,content:string,keys:string[]){
    const controller=new AbortController();this.controller=controller;
    let accepted=false;
    const attempt=new Date(this.clock()).toISOString();this.store.setSetting('notificationDelivery',{...this.delivery(),lastAttemptAt:attempt});
    const task=(async()=>{
      try{
        await this.post(url,content,controller.signal);controller.signal.throwIfAborted();
        const delivery=this.delivery();this.store.setSetting('notificationDelivery',{...delivery,receipts:[...new Set([...delivery.receipts,...keys])],lastDeliveredAt:new Date(this.clock()).toISOString(),lastError:null,retryAt:null,failures:0});
        accepted=true;
      }catch(error){
        if(controller.signal.aborted)return;
        const delivery=this.delivery(),failures=delivery.failures+1;
        const message=error instanceof AppError?error.message:'企业微信通知超时或网络不可用，请检查网络后重试。';
        this.store.setSetting('notificationDelivery',{...delivery,failures,lastError:message+(failures>=3?' 已停止自动重试，请点击“检查待办并通知”。':''),retryAt:failures>=3?null:new Date(this.clock()+MIN_INTERVAL*failures).toISOString()});
      }
    })();
    this.task=task;try{await task;return accepted;}finally{if(this.task===task){this.task=undefined;this.controller=undefined;}}
  }
  async check(manual=false,gui=false){
    if(manual&&!gui)throw new AppError('GUI_AUTH_REQUIRED','请在应用中检查通知待办。');
    if(this.stopped||this.suspended()||this.task)return this.status();
    const snapshot=this.snapshot(),delivery=this.delivery(),active=new Set(snapshot.keys),receipts=delivery.receipts.filter(key=>active.has(key));
    if(receipts.length!==delivery.receipts.length)this.store.setSetting('notificationDelivery',{...delivery,receipts});
    const connection=this.connection();
    if(!this.settings().enabled||!connection.url||connection.error||this.store.getSetting('notificationDestination')!==hash(connection.url)||!snapshot.keys.some(key=>!receipts.includes(key)))return this.status();
    if(delivery.lastAttemptAt&&this.clock()-Date.parse(delivery.lastAttemptAt)<MIN_INTERVAL)return this.status();
    if(!manual&&(delivery.failures>=3||(delivery.retryAt&&Date.parse(delivery.retryAt)>this.clock())))return this.status();
    await this.deliver(connection.url,this.content(snapshot),snapshot.keys);return this.status();
  }
  async test(gui:boolean){
    if(!gui)throw new AppError('GUI_AUTH_REQUIRED','请在应用中发送测试通知。');
    if(this.stopped||this.suspended()||this.task)throw new AppError('NOTIFICATION_BUSY','通知或本机数据操作正在进行，请稍后重试。');
    const connection=this.connection();if(!connection.url||connection.error)throw new AppError('NOTIFICATION_NOT_CONFIGURED',connection.error??'请先保存企业微信 Webhook 地址。');
    const delivery=this.delivery();if(delivery.lastAttemptAt&&this.clock()-Date.parse(delivery.lastAttemptAt)<MIN_INTERVAL)throw new AppError('NOTIFICATION_RATE_LIMIT','通知间隔至少一分钟，请稍后重试。');
    const accepted=await this.deliver(connection.url,'JobPilot 测试通知\n企业微信通知连接测试。\n这是单向提醒；草稿审核和发送确认仍需回到 Mac 的 JobPilot 操作。',[]);
    const status=this.status();if(status.lastError)throw new AppError('NOTIFICATION_FAILED',status.lastError);if(!accepted)throw new AppError('NOTIFICATION_CANCELLED','通知已取消，未确认送达。');return status;
  }
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.controller?.abort();await this.task;}
}
