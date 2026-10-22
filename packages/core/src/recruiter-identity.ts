import type {Store} from '@jobpilot/store';

// Edges come only from business IDs observed together in a bound conversation.
// Names, companies, links and model output never establish identity equivalence.
// Keep previously observed edges when a later rendering exposes fewer fields.
export function recruiterHistory(store:Store,seeds:readonly string[]){
  const ids=new Set(seeds.filter(id=>typeof id==='string'&&id.length>0));
  let rejected=false,hasConversation=false;
  if(!ids.size)return {ids:[],rejected,hasConversation};
  let remaining=store.db.prepare("SELECT recruiter_id,state,json_extract(snapshot_json,'$.recruiterAliases') aliases_json FROM chat_conversations").all().map(row=>{
    const aliases:unknown=JSON.parse((row.aliases_json as string|null)??'[]');
    return {ids:[row.recruiter_id as string,...Array.isArray(aliases)?aliases.filter((id):id is string=>typeof id==='string'&&id.length>0):[]],rejected:row.state==='REJECTED'};
  });
  let changed=true;
  while(changed){
    changed=false;
    remaining=remaining.filter(row=>{
      if(!row.ids.some(id=>ids.has(id)))return true;
      for(const id of row.ids)ids.add(id);
      rejected||=row.rejected;hasConversation=true;changed=true;return false;
    });
  }
  const known=[...ids].sort();
  rejected||=!!store.db.prepare(`SELECT o.job_id FROM job_outcomes o JOIN jobs j ON j.id=o.job_id WHERE o.rejected=1 AND j.recruiter_id IN (${known.map(()=>'?').join(',')}) LIMIT 1`).get(...known);
  rejected||=!!store.db.prepare(`SELECT id FROM contact_locks WHERE kind='rejected' AND recruiter_id IN (${known.map(()=>'?').join(',')}) LIMIT 1`).get(...known);
  hasConversation||=!!store.db.prepare(`SELECT o.job_id FROM job_outcomes o JOIN jobs j ON j.id=o.job_id WHERE o.replied=1 AND j.recruiter_id IN (${known.map(()=>'?').join(',')}) LIMIT 1`).get(...known);
  return {ids:known,rejected,hasConversation};
}
