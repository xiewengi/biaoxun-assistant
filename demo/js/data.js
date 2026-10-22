// 从 data/announcements.json 加载真实招标数据
// 其他页面用内联测试数据
async function loadAnnouncements() { return INLINE_ANN; }

async function loadSiteResults() { return INLINE_SITE; }

// 团队数据（测试数据）
const TEAM_GROUPS = [
  { id: 1, name: '潮安组', region: '潮安', admin: '王经理', adminPinyin: 'wangjingli', members: ['张三', '李四', '王五'], memberPinyin: ['zhangsan', 'lisi', 'wangwu'], position: '业务员', createdAt: '2025-01-15' },
  { id: 2, name: '市区一组', region: '市区', admin: '李经理', adminPinyin: 'lijingli', members: ['赵六', '孙七', '周八'], memberPinyin: ['zhaoliu', 'sunqi', 'zhouba'], position: '业务员', createdAt: '2025-02-20' },
  { id: 3, name: '市区二组', region: '市区', admin: '陈经理', adminPinyin: 'chenjingli', members: ['吴九', '郑十'], memberPinyin: ['wujiu', 'zhengshi'], position: '业务员', createdAt: '2025-03-10' },
  { id: 4, name: '饶平组', region: '饶平', admin: '赵经理', adminPinyin: 'zhaojingli', members: ['冯一', '陈二'], memberPinyin: ['fengyi', 'chener'], position: '业务员', createdAt: '2025-04-05' },
  { id: 5, name: '市战客组', region: '市战客', admin: '刘经理', adminPinyin: 'liujingli', members: ['褚三', '卫四', '蒋五', '沈六'], memberPinyin: ['chusan', 'weisi', 'jiangwu', 'shenliu'], position: '业务员', createdAt: '2025-05-18' },
];

// 进度选项（预制）
const PROGRESS_OPTIONS = [
  '待分配', '待跟进', '跟进中', '有意向', '已投标', '已中标', '已完成', '放弃'
];

// 任务提醒数据（根据公告数据动态生成）
function generateReminders(announcements) {
  const reminders = [];
  let id = 1;
  announcements.forEach(a => {
    // 管理员超时未分配提醒
    if (a.progress === '待分配' || !a.currentHandler) {
      reminders.push({
        id: id++,
        type: 'admin-assign',
        label: '管理员分派',
        title: `公告「${a.title.slice(0, 30)}...」已入库 ${Math.floor(Math.random()*3)+1} 天未分配`,
        targetId: a.id,
        time: a.createdAt,
        level: 'urgent'
      });
    }
    // 业务员跟进提醒
    if (a.progress === '待跟进' || a.progress === '跟进中') {
      const daysToFollow = Math.floor(Math.random()*5);
      reminders.push({
        id: id++,
        type: 'sales-follow',
        label: '业务员跟进',
        title: `公告「${a.title.slice(0, 30)}...」需跟进`,
        targetId: a.id,
        time: a.nextFollowUp,
        level: daysToFollow <= 1 ? 'urgent' : (daysToFollow <= 3 ? 'warn' : 'info')
      });
    }
  });
  return reminders.slice(0, 15);
}

// 定时任务配置（部分字段运行时动态更新）
const SCHEDULE_CONFIG = {
  keywordList: '信息化、智能化、弱电、智慧、数字、平台、系统、软件、大数据、云、机房、数据中心、网络、等保、网络安全、监控、安防、视频、雪亮、物联、5G、室分、无线覆盖、WiFi、专线、光缆、通信、IDC、AI、大模型、数字人、无人机、低空、一卡通、门禁、停车、充电桩、光伏、储能、烟感、消防物联、明厨亮灶、在线监测',
  crawlInterval: '每2小时',
  reminderInterval: '每天 09:00, 15:00',
  crawlStatus: '运行中',
  totalSites: 49,
};
