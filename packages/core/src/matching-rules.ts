import type {MatchReport,ResumeFact} from '@jobpilot/contracts';

// A user's confirmed end-to-end delivery experience covers ordinary app workflows,
// not every language, framework, commercial tenure or specialist discipline.
export function hasAppDeliveryBaseline(facts:ResumeFact[]) {
  return facts.some(fact=>fact.approved&&/app|应用|客户端/i.test(fact.text)&&/独立/.test(fact.text)&&/完成|完整|从\s*0\s*到\s*1/.test(fact.text)&&/发布|上线/.test(fact.text)&&!/未能|不能|尚未|没有|未独立|无法|不具备|不包含/.test(fact.text));
}
const specialist=/内核|底层|协议栈|驱动|编译器|逆向|渗透|加密算法|音视频编解码|后端|服务端|服务器|云端|算法研发|算法研究|模型训练|大模型微调|架构师|安卓|鸿蒙|持续集成|流水线|自动化测试|证书|认证|学历|学位|统招|本科|硕士|博士|英语|日语|德语|法语|口语|外语|带领|管理|[一二三四五六七八九十多\d]+\s*(?:年|人)/u;
const routine=/需求分析|需求澄清|业务需求|需求文档|设计文档|开发文档|编写文档|文档编写|自测|代码规范|编程风格|团队协作|沟通协作|责任心|工作态度|技术分享|学习能力|自我驱动|按(?:照)?(?:项目)?计划/;
const topics=['需求分析','需求澄清','开发文档','自测','代码规范','团队协作'];
export function calibrateAppGaps(gaps:MatchReport['gaps'],facts:ResumeFact[]) {
  let adjusted=0;
  const baseline=hasAppDeliveryBaseline(facts);
  const values=gaps.map(gap=>{
    const namedTechnology=/[a-z][a-z0-9+#._-]{2,}/i.test(gap.requirement.replace(/\b(?:app|ios)\b/gi,''));
    const conflict=facts.some(f=>f.approved&&/从未|不会|不能|不具备|未做过|没有.*经验/.test(f.text)&&topics.some(topic=>gap.requirement.includes(topic)&&f.text.includes(topic)));
    if(!baseline||gap.severity!=='hard'||!routine.test(gap.requirement)||specialist.test(gap.requirement)||namedTechnology||conflict)return gap;
    adjusted++;
    return {...gap,severity:'soft' as const,reason:`常规应用研发流程，可在面试核对，不作为硬性能力冲突。${gap.reason}`.slice(0,800)};
  });
  return {gaps:values,adjusted};
}
