export function advanceSearchPage(){
 const fail=(message:string)=>({ok:false,code:'ADAPTER_CHANGED',message});
 if(location.origin!=='https://www.zhipin.com'||!/^\/web\/geek\/jobs?$/.test(location.pathname))return fail('当前不是 BOSS 搜索页。');
 const buttons=[...document.querySelectorAll<HTMLElement>('.options-pages .next,.pagination .next,.pagination-next,.next-page,[aria-label="下一页"]')].filter(node=>node.getClientRects().length>0&&!node.matches(':disabled,[aria-disabled="true"],.disabled,.disable')&&!node.parentElement?.matches('.disabled,.disable'));
 if(!buttons.length)return {ok:true,data:{advanced:false}};
 if(buttons.length!==1)return fail('下一页入口不唯一，已停止。');
 const button=buttons[0];if(button instanceof HTMLAnchorElement){const url=new URL(button.href);if(url.origin!==location.origin||url.pathname!==location.pathname||url.username||url.password)return fail('下一页链接不属于当前搜索页。');for(const key of ['query','city','experience','degree','salary','industry','position','stage','scale','jobType'])if(url.searchParams.get(key)!==new URL(location.href).searchParams.get(key))return fail('下一页改变了搜索条件，已停止。');}
 button.click();return {ok:true,data:{advanced:true}};
}
