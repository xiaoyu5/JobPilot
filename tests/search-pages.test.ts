import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectSearchPages} from '../packages/boss-adapter/src/search-pages.js';
const card=(id:number)=>({url:`https://www.zhipin.com/job_detail/anonymous_${id}.html`,title:'iOS工程师',company:'匿名公司',salary:'20-30K',city:'深圳',tags:[],recruiterId:null,alreadyContacted:false});
test('search pagination honors job/page/scroll limits and deduplicates overlapping cards',async()=>{
 let page=0,scrolls=0;const jobs:string[]=[];
 const total=await collectSearchPages({id:'another',name:'另一个方案',keyword:'iOS',searchUrl:'',maxJobs:4,maxPages:3,maxScrolls:2},new AbortController().signal,async()=>({cards:page===0?[card(1),card(2)]:[card(2),card(3),card(4)]}),async()=>{scrolls++;},async()=>{page++;return true;},job=>jobs.push(job.id));
 assert.equal(total,4);assert.equal(page,1);assert.equal(scrolls,1);assert.equal(new Set(jobs).size,4);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>collectSearchPages({id:'a',name:'a',keyword:'ios',searchUrl:'',maxJobs:4},controller.signal,async()=>({cards:[card(1)]}),async()=>{},async()=>false,()=>assert.fail()));
});
