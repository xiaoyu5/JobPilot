import React,{useEffect,useState} from 'react';
import type {NotificationSettings,NotificationStatus} from '@jobpilot/contracts';
import {request} from './api';

export function NotificationSettingsPanel({disabled,act}:{disabled:boolean;act:(key:string,fn:()=>Promise<unknown>)=>void}){
  const [state,setState]=useState<NotificationStatus>(),[form,setForm]=useState<NotificationSettings>(),[webhook,setWebhook]=useState(''),[clear,setClear]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const load=async(initial=false)=>{const value=await request<NotificationStatus>('notifications.status');setState(value);if(initial)setForm(value.settings);};
  useEffect(()=>{void load(true).catch(e=>setError(e.message));const timer=setInterval(()=>{void load().catch(e=>setError(e.message));},5000);return()=>clearInterval(timer);},[]);
  const changed=!!form&&(!state||JSON.stringify(form)!==JSON.stringify(state.settings)||!!webhook||clear);
  const busy=disabled||state?.busy;
  const run=(key:string,fn:()=>Promise<unknown>)=>act(key,async()=>{setNotice('');setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'通知操作失败。');}finally{await load();}});
  const when=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN'):'尚无';
  return <section className="panel notification-settings"><div className="section-title"><h2>企业微信通知</h2><span className="badge blue">单向提醒</span></div>
    <p>需要你审核或接手时，向企业微信群机器人发一条汇总，手机企业微信可接收。请回 Mac 完成审核；会话消息也可在手机 BOSS 查看。</p>
    {form&&<form onSubmit={e=>{e.preventDefault();void run('save-notifications',async()=>{const value=await request<NotificationStatus>('notifications.save',{...form,webhookUrl:webhook||undefined,clearWebhook:clear});setState(value);setForm(value.settings);setWebhook('');setClear(false);setNotice('通知配置已保存。开启后会检查现有待办。');});}}>
      <label>群机器人 Webhook <span className="hint">{state?.configured?'已配置，留空保留':'尚未配置'}</span><input aria-label="企业微信 Webhook" type="password" autoComplete="off" value={webhook} disabled={busy} onChange={e=>{setWebhook(e.target.value);setNotice('');}} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"/></label>
      <label className="checkbox"><input aria-label="清除企业微信 Webhook" type="checkbox" checked={clear} disabled={busy} onChange={e=>setClear(e.target.checked)}/>清除本机 Webhook</label>
      <label className="checkbox"><input aria-label="启用企业微信通知" type="checkbox" checked={form.enabled} disabled={busy} onChange={e=>setForm({...form,enabled:e.target.checked})}/>启用企业微信通知</label>
      {([['queueReview','首联草稿待审核或已失效'],['chatReview','已读取的 BOSS 会话需人工回复或处理'],['taskAttention','发送结果待核验、任务需人工处理']] as const).map(([key,label])=><label className="checkbox" key={key}><input aria-label={label} type="checkbox" checked={form[key]} disabled={busy} onChange={e=>setForm({...form,[key]:e.target.checked})}/>{label}</label>)}
      <p className="hint">通知只含待办数量和处理入口，不含简历、草稿或聊天正文。Webhook 保存在当前本机 .env，不回显。群内回复不能批准发送。</p>
      <div className="actions"><button disabled={busy||!changed}>保存通知配置</button><button type="button" className="secondary" disabled={busy||changed||!state?.configured} onClick={()=>void run('test-notifications',async()=>{await request('notifications.test');setNotice('企业微信已接收测试通知，请在手机确认。');})}>发送测试通知</button><button type="button" className="secondary" disabled={busy||changed||!state?.settings.enabled||!state.configured} onClick={()=>void run('check-notifications',async()=>{const result=await request<NotificationStatus>('notifications.check');setNotice(result.lastError?'未发送成功，请查看下方状态。':'已检查待办；相同内容不重复通知，通知间隔至少一分钟。');})}>检查待办并通知</button></div>
    </form>}
    {notice&&<p role="status" className="banner info">{notice}</p>}{error&&<p role="alert" className="audit-issue">{error}</p>}
    {state&&<><p className="hint">待审核 {state.pending.queue} · 会话待处理 {state.pending.chats} · 待核验 {state.pending.verification} · 任务异常 {state.pending.tasks}<br/>最近成功：{when(state.lastDeliveredAt)}{state.retryAt&&<><br/>下次重试：{when(state.retryAt)}</>}</p>{(state.error||state.lastError)&&<p className="audit-issue">{state.error||state.lastError}</p>}</>}
    <details><summary>如何配置与接收</summary><p>在企业微信内部群添加群机器人，复制其 Webhook 到上方，保存后测试。也可在当前 .env 填写 WECOM_WEBHOOK_URL（兼容 HOOK_URL），再在这里启用。</p><p className="hint">JobPilot 运行时约每 5 秒检查本机待办，合并通知并按版本去重。会话提醒依赖你读取过的会话或已授权的聊天 Auto 扫描，不会监听整个 BOSS 收件箱；App 退出或 Mac 休眠时不检查。修改 Webhook 或恢复备份后需重新保存配置。</p></details>
  </section>;
}
