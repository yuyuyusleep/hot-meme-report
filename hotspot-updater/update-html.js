/**
 * update-html.js
 * 读取 hotspot-data.json，用 AI 生成选题分析，更新两个 HTML 文件
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'hotspot-data.json');
const VIRAL_FILE = path.join(__dirname, 'viral-data.json');
const OWN_FILE = path.join(__dirname, 'own-data.json');
const ADMIN_HTML = path.join(__dirname, '..', 'hotspot-admin.html');
const YISHENGUO_HTML = path.join(__dirname, '..', 'hotspot-yishenguo.html');

// Friday AI API
const FRIDAY_APP_ID = '22028349023677911116';
const AI_API_HOST = 'aigc.sankuai.com';
const AI_API_PATH = '/v1/openai/native/chat/completions';

// ─── AI 生成选题分析 ─────────────────────────────────────────
function callAI(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 3000
    });

    const options = {
      hostname: AI_API_HOST,
      path: AI_API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FRIDAY_APP_ID}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || '';
          if (!content) console.error('[AI] 空响应，原始数据:', data.slice(0, 300));
          resolve(content);
        } catch (e) {
          reject(new Error('AI响应解析失败: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('AI请求超时')); });
    req.write(body);
    req.end();
  });
}

// 过滤时政敏感词条，避免触发内网内容审核
const SENSITIVE_KEYWORDS = ['停火', '战争', '制裁', '海峡', '普京', '乌克兰', '台湾', '习近平', '拜登', '特朗普', '北约', '伊朗', '以色列', '巴勒斯坦', '俄罗斯', '美国', '政治', '军事', '导弹', '核武'];
function isSensitive(title) {
  return SENSITIVE_KEYWORDS.some(kw => title.includes(kw));
}

async function generateAnalysis(platform, items) {
  if (!items || items.length === 0) return items;

  console.log(`[AI] 生成 ${platform} 选题分析...`);

  // 只对非敏感条目做AI分析
  const safeItems = items.filter(item => !isSensitive(item.title));
  if (safeItems.length === 0) return items.map(item => ({ ...item, why: '', suggest: '' }));

  const titlesText = safeItems.map((item, i) => `${i + 1}. ${item.title}${item.hot ? '（' + item.hot + '）' : ''}`).join('\n');

  const prompt = `你是一个专业的短视频内容编导，擅长分析热点话题的传播逻辑和内容创作机会。

以下是${platform}今日热榜 Top ${items.length}：
${titlesText}

请为每条热点生成：
1. 【为什么火】：一句话说明这条内容的传播逻辑（情绪钩子/信息差/争议感等），15字以内
2. 【选题建议】：针对内容创作者的具体选题方向，20字以内，要有可操作性

请严格按以下 JSON 格式返回，不要有任何其他文字：
[
  {"rank": 1, "why": "...", "suggest": "..."},
  {"rank": 2, "why": "...", "suggest": "..."}
]`;

  try {
    const result = await callAI(prompt);
    // 提取 JSON（去掉 markdown 代码块后再匹配）
    const cleaned = result.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('未找到JSON数组');
    const analysis = JSON.parse(match[0]);

    // 建立 safeItems 标题 → 分析结果的映射（用序号1-N对应）
    const titleToAnalysis = {};
    safeItems.forEach((item, i) => {
      const a = analysis.find(x => x.rank === i + 1);
      if (a) titleToAnalysis[item.title] = a;
    });

    return items.map(item => {
      const a = titleToAnalysis[item.title];
      return {
        ...item,
        why: a?.why ? `🔥 ${a.why}` : '',
        suggest: a?.suggest ? `💡 ${a.suggest}` : ''
      };
    });
  } catch (e) {
    console.error(`[AI] ${platform} 分析失败:`, e.message);
    // 降级：不加分析，只保留标题和链接
    return items.map(item => ({ ...item, why: '', suggest: '' }));
  }
}

// ─── 生成跨平台共振摘要 ─────────────────────────────────────
async function generateSummary(data) {
  console.log('[AI] 生成今日摘要...');
  const allTitles = [
    ...data.weibo.slice(0, 5).filter(i => !isSensitive(i.title)).map(i => `微博:${i.title}`),
    ...data.toutiao.slice(0, 5).filter(i => !isSensitive(i.title)).map(i => `头条:${i.title}`),
    ...data.bilibili.slice(0, 3).filter(i => !isSensitive(i.title)).map(i => `B站:${i.title}`),
    ...data.xhs.slice(0, 3).filter(i => !isSensitive(i.title)).map(i => `小红书:${i.title}`)
  ].join('、');

  const prompt = `今日各平台热榜摘要：${allTitles}

请生成一段今日热点摘要，格式如下（直接输出，不要多余文字）：
今日跨平台共振热点 X 个，最强话题：话题A、话题B、话题C。[如有时效性内容加一句紧急提示]

要求：
- X 是你判断的跨平台共振热点数量（2-4个）
- 最强话题选3个最有内容创作价值的
- 如有节日/时事紧急内容，加"⚡ 紧急"提示
- 总字数控制在60字以内`;

  try {
    const result = await callAI(prompt);
    return result.trim();
  } catch (e) {
    console.error('[AI] 摘要生成失败:', e.message);
    const top3 = [...data.weibo.slice(0, 1), ...data.toutiao.slice(0, 1), ...data.bilibili.slice(0, 1)];
    return `今日跨平台热点更新，最强话题：${top3.map(i => i.title).join('、')}。`;
  }
}

// ─── 生成编导精选 ────────────────────────────────────────────
async function generateInsights(data) {
  console.log('[AI] 生成编导精选...');
  const allItems = [
    ...data.weibo.slice(0, 5).filter(i => !isSensitive(i.title)).map(i => `微博:${i.title}`),
    ...data.toutiao.slice(0, 5).filter(i => !isSensitive(i.title)).map(i => `头条:${i.title}`),
    ...data.xhs.slice(0, 3).filter(i => !isSensitive(i.title)).map(i => `小红书:${i.title}`)
  ].join('\n');

  const prompt = `今日热榜：
${allItems}

请选出3个最值得内容创作者关注的跨平台共振话题，生成编导精选，格式：
[
  {"topic": "话题名", "platforms": "平台A+平台B", "reason": "一句话说明为什么值得拍，20字以内", "urgent": false},
  ...
]
urgent=true 表示今天必须拍（时效性强）。直接输出JSON，不要其他文字。`;

  try {
    const result = await callAI(prompt);
    const cleaned = result.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('未找到JSON');
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('[AI] 编导精选失败:', e.message);
    return [];
  }
}

// ─── 生成快速选题灵感 ────────────────────────────────────────
async function generateQuickIdeas(data) {
  console.log('[AI] 生成快速选题灵感...');
  const allTitles = [
    ...data.weibo.slice(0, 3).map(i => i.title),
    ...data.toutiao.slice(0, 3).map(i => i.title)
  ].join('、');

  const prompt = `今日热点：${allTitles}

请生成3个"今天就能拍"的快速选题灵感，格式：
[
  {"title": "选题标题", "hook": "一句话说明拍摄方向和爆点，25字以内"}
]
直接输出JSON。`;

  try {
    const result = await callAI(prompt);
    const cleaned = result.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('未找到JSON');
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('[AI] 快速选题失败:', e.message);
    return [];
  }
}

// ─── 构建热点条目 HTML ───────────────────────────────────────
function buildHotItem(item, index) {
  const isTop3 = index < 3;
  const numClass = isTop3 ? 'hot-num top3' : 'hot-num';
  const rank = index + 1;

  let inner = `<div class="${numClass}">${rank}</div><div class="hot-body">`;
  inner += `<div class="hot-title">${escapeHtml(item.title)}</div>`;
  if (item.hot) inner += `<div class="hot-meta">🔥 ${escapeHtml(item.hot)}</div>`;
  if (item.why) inner += `<div class="hot-why">${escapeHtml(item.why)}</div>`;
  if (item.suggest) inner += `<div class="hot-suggest">${escapeHtml(item.suggest)}</div>`;
  if (item.url) inner += `<a class="hot-link" href="${item.url}" target="_blank">${item.linkText || '🔗 查看'}</a>`;
  inner += `</div>`;

  return `    <div class="hot-item">${inner}</div>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── 构建平台区块 HTML ───────────────────────────────────────
function buildPlatformSection(emoji, name, items) {
  if (!items || items.length === 0) return '';
  const rows = items.map((item, i) => buildHotItem(item, i)).join('\n');
  return `  <!-- ${name} -->
  <div class="platform-section">
    <div class="platform-header"><span>${emoji}</span><span class="platform-name">${name}</span><span class="platform-badge">Top ${items.length}</span></div>
${rows}
  </div>`;
}

// ─── 构建编导精选 HTML ───────────────────────────────────────
function buildInsightSection(insights, quickIdeas) {
  let html = `  <div class="insight-section">
    <div class="insight-title">🎯 编导精选 · 跨平台共振</div>`;

  const nums = ['①', '②', '③', '④', '⑤'];
  insights.forEach((item, i) => {
    const urgentTag = item.urgent ? '<strong>今天就能拍</strong>' : '';
    html += `\n    <div class="insight-item"><div class="insight-num">${nums[i] || (i + 1)}</div><div>${escapeHtml(item.topic)}：${escapeHtml(item.platforms)}，${escapeHtml(item.reason)}${urgentTag ? '，' + urgentTag : ''}</div></div>`;
  });

  html += `\n  </div>`;

  if (quickIdeas.length > 0) {
    html += `\n\n  <div class="insight-section">
    <div class="insight-title">⚡ 快速选题灵感 · 今天就能拍</div>`;
    quickIdeas.forEach((idea, i) => {
      html += `\n    <div class="insight-item"><div class="insight-num">${nums[i] || (i + 1)}</div><div>「${escapeHtml(idea.title)}」→ ${escapeHtml(idea.hook)}</div></div>`;
    });
    html += `\n  </div>`;
  }

  return html;
}

// ─── 构建监控博主卡片 HTML ────────────────────────────────────
function buildBloggerCard(blogger) {
  const notesHtml = (blogger.notes || []).slice(0, 3).map(n => {
    const tag = n.tag || '日常记录';
    const tagClass = { '情感共鸣': 'tag-emotion', '方法论': 'tag-method', '教程干货': 'tag-tutorial',
      '女性励志': 'tag-inspire', '女性议题': 'tag-inspire', '反差对比': 'tag-contrast',
      '日常记录': 'tag-daily', '人物解读': 'tag-contrast' }[tag] || 'tag-daily';
    const stat = n.likes ? `❤️ ${n.likes}` : '';
    return `          <div class="hit-item"><span class="hit-tag ${tagClass}">${escapeHtml(tag)}</span><span class="hit-title">${escapeHtml(n.title)}</span>${stat ? `<span class="hit-stat">${stat}</span>` : ''}</div>`;
  }).join('\n');

  const statsHtml = blogger.likes
    ? `<span class="stat-pill stat-collect">⭐ ${escapeHtml(blogger.likes)} 赞藏</span>`
    : `<span class="stat-pill stat-collect">⭐ 数据更新中</span>`;

  const fansText = blogger.fans ? ` · ${blogger.fans}粉丝` : '';

  return `    <div class="viral-card" style="padding:0;overflow:hidden;">
      <img src="${blogger.img}" style="width:100%;display:block;border-radius:10px 10px 0 0;" alt="${escapeHtml(blogger.name)}主页">
      <div style="padding:14px 16px;">
        <div class="viral-header" style="margin-bottom:6px;">
          <div class="viral-title">${escapeHtml(blogger.name)}</div>
          <div class="viral-stats">${statsHtml}</div>
        </div>
        <div class="viral-author">${escapeHtml(blogger.desc)}${fansText}</div>
        <a class="viral-link" href="${blogger.profileUrl}" target="_blank">🔗 查看主页</a>
        <div class="hit-section">
          <div class="hit-section-title">🔥 本周爆款笔记</div>
${notesHtml || '          <div class="hit-item"><span class="hit-title" style="color:#9b9a97">数据更新中...</span></div>'}
        </div>
      </div>
    </div>`;
}

// ─── 构建账号卡片 HTML ────────────────────────────────────────
function buildAccountCard(account) {
  const notesHtml = (account.weekNotes || []).map((note, i) => {
    const likesTag = note.likes ? `<span class="hit-tag like">👍 ${escapeHtml(note.likes)}</span>` : '';
    const collectTag = note.collects ? `<span class="hit-tag collect">⭐ ${escapeHtml(note.collects)}</span>` : '';
    const commentTag = note.comments ? `<span class="hit-tag comment">💬 ${escapeHtml(note.comments)}</span>` : '';
    return `      <div class="hit-item">
        <div class="hit-rank">${i + 1}</div>
        <div class="hit-body">
          <a class="hit-title" href="${note.url}" target="_blank">${escapeHtml(note.title)}</a>
          <div class="hit-tags">${likesTag}${collectTag}${commentTag}</div>
        </div>
      </div>`;
  }).join('\n');

  const fans = account.fans || '—';
  const weekInteraction = account.weekInteraction ? String(account.weekInteraction) : '—';
  const weekPublished = account.weekPublished || (account.weekNotes || []).length;

  return `    <div class="account-card">
      <div class="account-header">
        <div class="account-name">${escapeHtml(account.name)}</div>
        <div class="account-platform">${escapeHtml(account.platform)}</div>
      </div>
      <div class="account-stats">
        <div class="account-stat">
          <div class="account-stat-val">${escapeHtml(fans)}</div>
          <div class="account-stat-label">粉丝总量</div>
        </div>
        <div class="account-stat">
          <div class="account-stat-val up">—</div>
          <div class="account-stat-label">本周新增</div>
        </div>
        <div class="account-stat">
          <div class="account-stat-val">${weekPublished}</div>
          <div class="account-stat-label">本周发布</div>
        </div>
        <div class="account-stat">
          <div class="account-stat-val">${escapeHtml(weekInteraction)}</div>
          <div class="account-stat-label">本周总互动</div>
        </div>
      </div>
      <div class="sub-section-title">🏆 本周爆款回顾</div>
${notesHtml}
      <div class="sub-section-title">🎯 选题命中率</div>
      <div id="rate-${account.id}"></div>
      <div class="sub-section-title" style="margin-top:14px;">🔗 本周发布内容 · 热点来源</div>
      <div id="track-${account.id}" class="source-track-list"></div>
    </div>`;
}

// ─── 更新监控博主模块（仅 admin 版）────────────────────────────
function updateViralSection(html, viralData) {
  if (!viralData) return html;

  const maleCards = (viralData.male || []).map(b => buildBloggerCard(b)).join('\n\n');
  const femaleCards = (viralData.female || []).map(b => buildBloggerCard(b)).join('\n\n');

  // 更新监控博主概况摘要
  const today = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' });
  const totalMale = (viralData.male || []).length;
  const totalFemale = (viralData.female || []).length;
  const maxLikes = [...(viralData.male || []), ...(viralData.female || [])]
    .map(b => b.likes || '').filter(Boolean).sort().pop() || '—';

  html = html.replace(
    /(<div class="tab-panel"[^>]*id="tab-viral">[\s\S]*?<div class="summary-text">)[\s\S]*?(<\/div>\s*<\/div>)/,
    `$1\n      持续追踪同赛道标杆博主，分析选题规律与数据趋势。男保洁赛道监控 <span class="highlight">${totalMale} 位</span>博主，保洁女团赛道监控 <span class="highlight">${totalFemale} 位</span>博主，合计赞藏量最高达 <span class="highlight">${maxLikes}</span>（数据截至 ${today}）。\n    $2`
  );

  // 替换男保洁博主区块
  if (maleCards) {
    html = html.replace(
      /(<!-- 男保洁对标博主 -->[\s\S]*?<div class="section-label">👨‍🔧 男保洁 · 对标博主<\/div>\s*)[\s\S]*?(?=\s*<\/div>\s*\n\s*<!-- 保洁女团)/,
      `$1\n${maleCards}\n  `
    );
  }

  // 替换保洁女团博主区块
  if (femaleCards) {
    html = html.replace(
      /(<!-- 保洁女团对标博主 -->[\s\S]*?<div class="section-label">👩‍🔧 保洁女团 · 对标博主<\/div>\s*)[\s\S]*?(?=\s*<\/div>\s*\n<\/div><!-- \/tab-viral)/,
      `$1\n${femaleCards}\n  `
    );
  }

  return html;
}

// ─── 更新账号模块（仅 admin 版）──────────────────────────────
function updateOwnSection(html, ownData) {
  if (!ownData || !ownData.accounts) return html;

  const today = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' });

  // 找出本周最强单条
  let bestNote = { title: '', likes: 0 };
  ownData.accounts.forEach(acc => {
    (acc.weekNotes || []).forEach(note => {
      const l = parseInt((note.likes || '0').replace(/[^0-9]/g, '')) || 0;
      if (l > bestNote.likes) bestNote = { title: note.title, likes: l };
    });
  });

  const totalPublished = ownData.accounts.reduce((s, a) => s + (a.weekPublished || 0), 0);

  // 更新账号概况摘要
  html = html.replace(
    /(<div class="tab-panel"[^>]*id="tab-own">[\s\S]*?<div class="summary-text">)[\s\S]*?(<\/div>\s*<\/div>)/,
    `$1\n      共监测 <span class="highlight">${ownData.accounts.length} 个</span>账号，本周发布内容 <span class="highlight">${totalPublished} 条</span>。本周最强单条：<span class="highlight">「${escapeHtml(bestNote.title || '—')}」</span>，点赞 ${bestNote.likes || '—'}。<br><small style="color:#9b9a97">数据截至 ${today}，实时以小红书后台为准。</small>\n    $2`
  );

  // 逐个替换账号卡片
  for (const account of ownData.accounts) {
    const cardHtml = buildAccountCard(account);
    const sectionLabel = account.icon + ' ' + account.label;
    html = html.replace(
      new RegExp(`(<!-- ── ${account.label} ── -->[\\s\\S]*?<div class="section-label">[^<]*<\\/div>\\s*)[\\s\\S]*?(?=\\s*<\\/div>\\s*\\n\\s*<!-- ──|\\s*<\\/div>\\s*\\n<\\/div><!-- \\/tab-own)`),
      `$1\n${cardHtml}\n  `
    );
  }

  return html;
}

// ─── 更新 HTML 文件 ──────────────────────────────────────────
function updateHtmlFile(filePath, data, summary, insights, quickIdeas, viralData, ownData) {
  if (!fs.existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`);
    return false;
  }

  let html = fs.readFileSync(filePath, 'utf8');

  // 1. 更新日期
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
  const dateDisplay = `${mm}/${dd} ${weekdays[now.getDay()]}`;
  html = html.replace(
    /(<div[^>]*class="header-date"[^>]*>)[^<]*/,
    `$1${dateDisplay}`
  );

  // 2. 更新摘要（只替换 summary-text 内部文字，不动外层结构）
  html = html.replace(
    /(<div class="summary-text">)[\s\S]*?(<\/div>)/,
    `$1\n      ${summary}\n    $2`
  );

  // 3. 替换小红书区块
  if (data.xhs.length > 0) {
    const xhsHtml = buildPlatformSection('📕', '小红书', data.xhs);
    html = html.replace(
      /<!-- 小红书 -->[\s\S]*?(?=<!-- 抖音 \/ 头条)/,
      xhsHtml + '\n\n  '
    );
  }

  // 4. 替换抖音/头条区块
  if (data.toutiao.length > 0) {
    const ttHtml = buildPlatformSection('🔴', '抖音 / 头条', data.toutiao);
    html = html.replace(
      /<!-- 抖音 \/ 头条 -->[\s\S]*?(?=<!-- 微博)/,
      ttHtml + '\n\n  '
    );
  }

  // 5. 替换微博区块
  if (data.weibo.length > 0) {
    const wbHtml = buildPlatformSection('💚', '微博', data.weibo);
    html = html.replace(
      /<!-- 微博 -->[\s\S]*?(?=<!-- B站)/,
      wbHtml + '\n\n  '
    );
  }

  // 6. 替换B站区块
  if (data.bilibili.length > 0) {
    const biliHtml = buildPlatformSection('📺', 'B站', data.bilibili);
    html = html.replace(
      /<!-- B站 -->[\s\S]*?(?=<div class="insight-section")/,
      biliHtml + '\n\n  '
    );
  }

  // 7. 替换编导精选区块（仅 admin 版有）
  if (insights.length > 0) {
    const insightHtml = buildInsightSection(insights, quickIdeas);
    html = html.replace(
      /<div class="insight-section">[\s\S]*?<div class="insight-title">🎯[\s\S]*?<\/div>\s*<\/div>[\s\S]*?(?=<div class="insight-section">[\s\S]*?快速|<\/div>\s*<\/div>\s*<\/div>\s*<!-- 监控|$)/,
      insightHtml + '\n\n  '
    );
  }

  // 8. 更新监控博主模块（仅 admin 版）
  if (viralData && filePath === ADMIN_HTML) {
    html = updateViralSection(html, viralData);
  }

  // 9. 更新账号模块（仅 admin 版）
  if (ownData && filePath === ADMIN_HTML) {
    html = updateOwnSection(html, ownData);
  }

  fs.writeFileSync(filePath, html, 'utf8');
  console.log(`✅ 已更新: ${path.basename(filePath)}`);
  return true;
}

// ─── 主函数 ──────────────────────────────────────────────────
async function main() {
  console.log('=== 开始更新 HTML ===', new Date().toLocaleString('zh-CN'));

  if (!fs.existsSync(DATA_FILE)) {
    console.error('❌ 找不到 hotspot-data.json，请先运行 fetch-hotspot.js');
    process.exit(1);
  }

  const rawData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  console.log(`数据时间: ${rawData.updatedAt}`);

  // 并行生成 AI 分析
  console.log('\n--- AI 分析阶段 ---');
  const [weiboWithAI, toutiaoWithAI, biliWithAI, xhsWithAI] = await Promise.all([
    generateAnalysis('微博', rawData.weibo),
    generateAnalysis('头条/抖音', rawData.toutiao),
    generateAnalysis('B站', rawData.bilibili),
    rawData.xhs.length > 0 ? generateAnalysis('小红书', rawData.xhs) : Promise.resolve([])
  ]);

  const enrichedData = {
    ...rawData,
    weibo: weiboWithAI,
    toutiao: toutiaoWithAI,
    bilibili: biliWithAI,
    xhs: xhsWithAI
  };

  // 生成摘要和编导精选
  const [summary, insights, quickIdeas] = await Promise.all([
    generateSummary(enrichedData),
    generateInsights(enrichedData),
    generateQuickIdeas(enrichedData)
  ]);

  console.log('\n摘要:', summary);

  // 读取监控博主和账号数据（如果存在）
  let viralData = null;
  let ownData = null;
  if (fs.existsSync(VIRAL_FILE)) {
    try { viralData = JSON.parse(fs.readFileSync(VIRAL_FILE, 'utf8')); console.log('✅ 已加载监控博主数据'); } catch(e) { console.error('监控博主数据读取失败:', e.message); }
  } else {
    console.log('⚠️ 未找到 viral-data.json，监控博主模块保持不变');
  }
  if (fs.existsSync(OWN_FILE)) {
    try { ownData = JSON.parse(fs.readFileSync(OWN_FILE, 'utf8')); console.log('✅ 已加载账号数据'); } catch(e) { console.error('账号数据读取失败:', e.message); }
  } else {
    console.log('⚠️ 未找到 own-data.json，账号模块保持不变');
  }

  // 更新两个 HTML 文件
  console.log('\n--- 更新 HTML 文件 ---');
  updateHtmlFile(ADMIN_HTML, enrichedData, summary, insights, quickIdeas, viralData, ownData);
  updateHtmlFile(YISHENGUO_HTML, enrichedData, summary, insights, quickIdeas, null, null);

  console.log('\n✅ HTML 更新完成');
}

main().catch(e => {
  console.error('❌ 更新失败:', e);
  process.exit(1);
});
