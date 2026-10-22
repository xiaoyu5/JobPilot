import type {DatabaseSync} from 'node:sqlite';
import {AppError,redact,type ConversionStats,type JobOutcome,type OutcomeList,type OutcomeUpdate,type StatsQuery} from '@jobpilot/contracts';
import type {z} from 'zod';
type Row=Record<string,any>;
function view(row:Row):JobOutcome{return {jobId:row.id,title:row.title,company:row.company,source:row.source,confirmedUnits:row.confirmed_units??0,deliveryState:row.delivery_state??null,replied:!!row.replied,rejected:!!row.rejected,interview:!!row.interview,note:row.note??'',version:row.version??0,updatedAt:row.updated_at??null};}
const select=`SELECT j.id,j.title,j.company,j.source,o.replied,o.rejected,o.interview,o.note,o.version,o.updated_at,s.confirmed_units,s.state delivery_state FROM jobs j LEFT JOIN job_outcomes o ON o.job_id=j.id LEFT JOIN send_outbox s ON s.job_id=j.id`;
export function listOutcomes(db:DatabaseSync,input:z.infer<typeof OutcomeList>){
  const query=`%${input.query.replace(/[\\%_]/g,'\\$&')}%`,where="WHERE j.source=? AND (j.title LIKE ? ESCAPE '\\' OR j.company LIKE ? ESCAPE '\\')",args=[input.source,query,query];
  return {items:(db.prepare(`${select} ${where} ORDER BY coalesce(o.updated_at,s.created_at,j.fetched_at) DESC,j.id LIMIT ? OFFSET ?`).all(...args,input.limit,input.offset) as Row[]).map(view),total:Number(db.prepare(`SELECT count(*) n FROM jobs j ${where}`).get(...args)!.n)};
}
export function updateOutcome(db:DatabaseSync,input:z.infer<typeof OutcomeUpdate>){
  const job=db.prepare('SELECT id,recruiter_id,company FROM jobs WHERE id=?').get(input.jobId);if(!job)throw new AppError('JOB_NOT_FOUND','岗位不存在。');
  const prior=db.prepare('SELECT version FROM job_outcomes WHERE job_id=?').get(input.jobId);
  if((prior?.version??0)!==input.expectedVersion)throw new AppError('VERSION_CONFLICT','标记已被修改，请刷新后重试。');
  db.prepare(`INSERT INTO job_outcomes(job_id,replied,rejected,interview,note,version,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(job_id) DO UPDATE SET replied=excluded.replied,rejected=excluded.rejected,interview=excluded.interview,note=excluded.note,version=job_outcomes.version+1,updated_at=excluded.updated_at`).run(input.jobId,Number(input.replied),Number(input.rejected),Number(input.interview),redact(input.note),new Date().toISOString());
  if(input.replied)db.prepare('UPDATE jobs SET already_contacted=1 WHERE id=?').run(input.jobId);
  if(input.rejected)db.prepare("INSERT OR IGNORE INTO contact_locks(id,kind,job_id,recruiter_id,name,company) VALUES(?,'rejected',?,?,?,?)").run('manual-rejection:'+input.jobId,input.jobId,job.recruiter_id??'','',job.company);
  return view(db.prepare(`${select} WHERE j.id=?`).get(input.jobId) as Row);
}
export function conversionStats(db:DatabaseSync,input:z.infer<typeof StatsQuery>,clock=Date.now()):ConversionStats{
  const since=input.days?new Date(clock-input.days*86400000).toISOString():'',rows=db.prepare(`SELECT s.*,o.replied,o.rejected,o.interview FROM send_outbox s JOIN jobs j ON j.id=s.job_id LEFT JOIN job_outcomes o ON o.job_id=j.id WHERE j.source=? AND s.created_at>=?`).all(input.source,since) as Row[];
  const contacted=rows.filter(row=>row.confirmed_units>0),replied=contacted.filter(row=>row.replied).length,interviews=contacted.filter(row=>row.interview).length;
  const externallyMarked=Number(db.prepare(`SELECT count(*) n FROM job_outcomes o JOIN jobs j ON j.id=o.job_id LEFT JOIN send_outbox s ON s.job_id=o.job_id WHERE j.source=? AND o.updated_at>=? AND (o.replied=1 OR o.rejected=1 OR o.interview=1) AND coalesce(s.confirmed_units,0)=0`).get(input.source,since)!.n);
  const pageConfirmedContacts=contacted.filter(row=>row.state==='SENT_CONFIRMED'||row.phase==='CONFIRMED'||row.default_phase==='CONFIRMED').length;
  return {source:input.source,days:input.days,confirmedContacts:contacted.length,confirmedMessages:rows.reduce((sum,row)=>sum+row.confirmed_units,0),pageConfirmedContacts,manuallyConfirmedContacts:contacted.length-pageConfirmedContacts,partialContacts:contacted.filter(row=>row.confirmed_units<row.message_units).length,replied,rejected:contacted.filter(row=>row.rejected).length,interviews,replyRate:contacted.length?replied/contacted.length:null,interviewRate:contacted.length?interviews/contacted.length:null,externallyMarked,needsVerify:rows.filter(row=>row.state==='NEEDS_VERIFY').length};
}
