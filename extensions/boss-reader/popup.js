const output=document.querySelector('#result');
const origin='https://www.zhipin.com/*',scriptId='jobpilot-boss-reader';
async function current(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id||new URL(tab.url).origin!=='https://www.zhipin.com')throw new Error('请先切换到专用 Chrome 的 BOSS 标签页。');return tab.id;}
document.querySelector('#connect').onclick=async()=>{try{const tabId=await current();const results=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:['bridge.js']});output.textContent=JSON.stringify(results[0]?.result??{connected:true},null,2);}catch(error){output.textContent=String(error);}};
document.querySelector('#remember').onclick=async()=>{try{
 if(!await chrome.permissions.request({origins:[origin]})){output.textContent='未允许网站访问，仍可使用单次连接。';return;}
 const script={id:scriptId,matches:['https://www.zhipin.com/web/geek/chat*','https://www.zhipin.com/job_detail/*'],js:['bridge.js'],world:'MAIN',runAt:'document_idle',persistAcrossSessions:true,allFrames:false};
 const registered=await chrome.scripting.getRegisteredContentScripts({ids:[scriptId]});if(registered.length)await chrome.scripting.updateContentScripts([script]);else await chrome.scripting.registerContentScripts([script]);
 const tabId=await current();await chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:['bridge.js']});output.textContent='已记住只读连接；BOSS 消息和岗位页刷新、重启后自动启用。';
}catch(error){output.textContent=String(error);}};
document.querySelector('#stop').onclick=async()=>{try{
 const registered=await chrome.scripting.getRegisteredContentScripts({ids:[scriptId]});if(registered.length)await chrome.scripting.unregisterContentScripts({ids:[scriptId]});
 try{const tabId=await current();await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>{window.__JobPilotReadonlyBridge_v1__?.stop();}});}finally{await chrome.permissions.remove({origins:[origin]});}
 output.textContent='已断开并移除当前标记，自动连接和 BOSS 网站授权已关闭。';
}catch(error){output.textContent=String(error);}};
