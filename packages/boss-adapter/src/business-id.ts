// Opaque BOSS business IDs use URL-safe letters/digits, underscore, hyphen and
// tilde. Keep them opaque; never decode them or read authentication parameters.
export function businessId(value:unknown):string|null{
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>0?String(value):null;
  return typeof value==='string'&&/^[A-Za-z0-9_~-]{3,200}$/.test(value)&&!['undefined','null','NaN'].includes(value)?value:null;
}
export function recruiterIdentity(value:unknown){
  if(!value||typeof value!=='object')return null;
  const boss=value as Record<string,unknown>;
  const aliases=[...new Set([boss.uid,boss.encryptBossId,boss.encryptUserId,boss.encryptUid,boss.encryptId,boss.bossId,boss.friendId].map(businessId).filter((id):id is string=>!!id))];
  return aliases.length?{recruiterId:aliases[0],aliases}:null;
}
