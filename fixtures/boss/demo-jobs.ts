import { createHash } from 'node:crypto';
import { type JobRecord } from '@jobpilot/contracts';

// Entirely synthetic; no platform account, real employer, or candidate data.
export function demoJobs(): JobRecord[] {
  const titles = ['高级 iOS 工程师', '智能硬件 iOS 工程师', '音视频客户端工程师', 'BLE 设备通信工程师', 'Flutter + Native 工程师'];
  return Array.from({length: 20}, (_, index) => {
    const id = `fixture-${String(index + 1).padStart(2, '0')}`;
    const title = titles[index % titles.length];
    const jdText = `【匿名演示数据】\n${title}\n负责 Swift / Objective-C 客户端迭代，与设备和服务端团队协作。\n技能方向：${['UIKit、GCD', 'IoT SDK、MQTT、地图渲染', '视频解码、Metal', 'BLE、分包和重传', 'Flutter 混合模块、Native Bridge'][index % 5]}。\n实际匹配与话术生成功能在 M2 提供，本条数据不代表真实招聘。`;
    return {id: `demo:${id}`, platformJobId: id, recruiterId: null, source: 'demo', title, company: `匿名示例公司 ${String.fromCharCode(65 + index)}`, salary: `${18 + index % 8}-${28 + index % 8}K`, city: ['深圳', '杭州', '上海', '北京'][index % 4], experience: '5–10 年', education: '未指定', url: '', jdText, jdHash: createHash('sha256').update(jdText).digest('hex'), fetchedAt: new Date().toISOString(), snapshot: JSON.stringify({fixture: true, id}), alreadyContacted: false};
  });
}
