/**
 * ST-Auto-Sync 前端扩展模块
 * 支持 SillyTavern 实时消息热重载、设置面板配置与状态监控
 */

const MODULE_NAME = 'st-auto-sync';
const API_BASE = '/api/plugins/st-auto-sync';

/**
 * SillyTavern 对写操作(POST)启用 CSRF 校验:不带 X-CSRF-Token 会被直接 403。
 * token 通过 GET /csrf-token 获取(与酒馆前端 script.js 同一套接口)。
 */
let csrfTokenCache = '';

async function getCsrfToken() {
  if (csrfTokenCache) return csrfTokenCache;
  try {
    const res = await fetch('/csrf-token');
    if (res.ok) {
      const data = await res.json();
      csrfTokenCache = data?.token || '';
    }
  } catch (err) {
    console.warn('[ST-Auto-Sync] Could not fetch CSRF token:', err?.message || err);
  }
  return csrfTokenCache;
}

/**
 * 带 CSRF token 的 JSON POST,并对非 JSON 响应(如 403 的 HTML 错误页)给出可读报错。
 */
async function postJson(path, payload) {
  const token = await getCsrfToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-CSRF-Token'] = token;

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload ?? {}),
  });

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (_) {
    data = null;
  }

  if (!res.ok) {
    if (res.status === 403) {
      // token 可能过期,清掉缓存下次重取
      csrfTokenCache = '';
      throw new Error('被酒馆拒绝(403 CSRF 校验失败),请刷新页面后重试');
    }
    throw new Error(`服务端返回 ${res.status}${data?.error ? ': ' + data.error : ''}`);
  }

  if (data === null) {
    throw new Error('服务端返回了非 JSON 内容,请检查酒馆日志');
  }
  return data;
}

let eventSourceRef = null;
let currentConfig = null;
let sseConnection = null;

/**
 * 安全获取 SillyTavern 全局上下文
 */
function getStContext() {
  if (typeof window !== 'undefined' && window['SillyTavern']) {
    return window['SillyTavern'].getContext?.() || {};
  }
  return {};
}

/**
 * 触发当前聊天界面无感热刷新
 */
async function triggerChatReload(reason = '') {
  console.log(`[ST-Auto-Sync] Reloading current chat view (${reason})...`);
  try {
    // 方式 1: 调用 ST 全局暴露的 reloadCurrentChat
    if (typeof window['reloadCurrentChat'] === 'function') {
      await window['reloadCurrentChat']();
      return;
    }
    // 方式 2: 通过 Context
    const ctx = getStContext();
    if (typeof ctx.reloadCurrentChat === 'function') {
      await ctx.reloadCurrentChat();
      return;
    }
    // 方式 3: 通过重新触发角色切换/加载当前会话
    if (typeof window['getChat'] === 'function') {
      await window['getChat']();
      return;
    }
  } catch (err) {
    console.warn('[ST-Auto-Sync] Error during chat reload:', err);
  }
}

/**
 * 创建顶部栏状态指示灯
 */
function createTopBarIndicator() {
  if (document.getElementById('st-sync-topbar-icon')) return;

  const container = document.querySelector('#top-bar') || document.querySelector('#header_bar') || document.body;
  const indicator = document.createElement('div');
  indicator.id = 'st-sync-topbar-icon';
  indicator.title = 'ST-Auto-Sync 同步状态';
  indicator.innerHTML = `
    <span class="st-sync-dot offline" id="st-sync-status-dot"></span>
    <span id="st-sync-status-text">同步</span>
  `;

  indicator.addEventListener('click', () => {
    // 点击快速跳转到扩展设置抽屉,并把本插件那一格展开
    const extButton = document.querySelector('#extensions-button') || document.querySelector('#nav-toggle-extensions');
    if (extButton) extButton.click();

    const panel = document.getElementById('st-sync-settings-panel');
    if (!panel) return;

    const content = panel.querySelector(':scope > .inline-drawer-content');
    if (content && content.style.display === 'none') {
      panel.querySelector(':scope > .inline-drawer-toggle')?.click();
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  container.appendChild(indicator);
}

/**
 * 统一的状态文案:抽屉徽标、面板徽标、顶栏都走这一个函数,避免两处说法不一致。
 *   未配置 = 还没填 Hub 地址或 Token
 *   未连接 = 填了但连不上(鼠标悬停看 lastError)
 *   已连接 / 同步中
 */
function statusBadgeText(status = {}) {
  const cfg = status.config || currentConfig || {};
  const configured = !!(cfg.hubUrl && cfg.token);

  if (status.isSyncing) return '同步中…';
  if (status.connected) return '已连接';
  if (!configured) return '未配置';
  return '未连接';
}

function statusTooltip(status = {}) {
  const cfg = status.config || currentConfig || {};
  const text = statusBadgeText(status);
  const details = [
    `状态: ${text}`,
    `Hub: ${cfg.hubUrl || '(未填写)'}`,
    `设备: ${cfg.deviceName || '(未填写)'}`,
  ];
  if (status.lastError) details.push(`错误: ${status.lastError}`);
  return details.join('\n');
}

/**
 * 刷新抽屉标题徽标 + 面板内徽标(统一文案)
 */
function refreshPanelBadges(status = {}) {
  const text = statusBadgeText(status);
  const tip = statusTooltip(status);

  for (const id of ['st-sync-drawer-badge', 'st-sync-badge-status']) {
    const badge = document.getElementById(id);
    if (badge) {
      badge.textContent = text;
      badge.title = tip;
    }
  }
}

/**
 * 更新指示灯状态
 */
function updateIndicator(status) {
  const dot = document.getElementById('st-sync-status-dot');
  const text = document.getElementById('st-sync-status-text');
  if (!dot || !text) return;

  dot.className = 'st-sync-dot';

  if (status.isSyncing) {
    dot.classList.add('syncing');
    text.textContent = '同步中...';
  } else if (status.connected && status.config?.mode === 'realtime') {
    dot.classList.add('online');
    text.textContent = `实时 (${status.onlineCount || 1}端)`;
  } else if (status.config?.mode === 'interval') {
    dot.classList.add('interval');
    text.textContent = `定时 (${status.config.intervalMinutes}m)`;
  } else {
    dot.classList.add('offline');
    // 与抽屉/面板保持同一套文案:未配置 = 没填地址或 Token
    text.textContent = status.lastError ? '异常' : statusBadgeText(status);
  }
}

/**
 * 监听服务端推送的 SSE 实时事件
 */
function initSseListener() {
  if (sseConnection) {
    sseConnection.close();
  }

  sseConnection = new EventSource(`${API_BASE}/events`);

  sseConnection.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerEvent(data.event, data.payload);
    } catch (_) {}
  };

  sseConnection.onerror = () => {
    updateIndicator({ connected: false, lastError: 'SSE Disconnected' });
  };
}

/**
 * 处理服务端分发的事件
 */
async function handleServerEvent(eventType, payload) {
  switch (eventType) {
    case 'connected':
    case 'status_changed':
    case 'presence_changed':
      if (payload) {
        updateIndicator(payload);
        refreshPanelBadges(payload);
      }
      break;

    case 'chat_updated':
      // 收到远端消息：1. 弹出优雅 Toast 提醒
      if (typeof window['toastr'] !== 'undefined' && payload.characterName) {
        window['toastr'].info(
          `收到来自【${payload.characterName}】的新消息，切换会话或点击刷新`,
          'ST-Auto-Sync',
          { timeOut: 4000 }
        );
      }
      // 2. 尽力而为安全热重载（仅当用户启用实验性自动重载，或在安全环境下）
      if (currentConfig?.experimentalAutoReload) {
        await triggerChatReload('Remote live message received (experimental)');
      }
      break;

    case 'chat_archived':
      if (typeof window['toastr'] !== 'undefined') {
        window['toastr'].warning(
          `检测到部署前的历史分叉，已将本地旧记录安全归档至【${payload.archiveFile}】，主会话已同步为权威最新进度。`,
          'ST-Auto-Sync 历史安全归档',
          { timeOut: 8000 }
        );
      }
      break;

    case 'sync_start':
      updateIndicator({ isSyncing: true });
      break;

    case 'sync_complete':
      updateIndicator({ isSyncing: false, connected: true, config: currentConfig });
      if (typeof window['toastr'] !== 'undefined') {
        window['toastr'].success(`同步成功：上传 ${payload.uploaded}，下载 ${payload.downloaded}`, 'ST-Auto-Sync');
      }
      // 如果下载了变动文件，尝试刷新当前视图
      if (payload.downloaded > 0) {
        triggerChatReload('Downloaded remote updates');
      }
      break;

    case 'restore_done':
      updateIndicator({ isSyncing: false, connected: true, config: currentConfig });
      if (payload && (payload.restored > 0 || payload.restoredBytes > 0)) {
        triggerChatReload('Restore completed from Hub');
      }
      break;

    case 'cloud_profile_updated':
      updateCloudProfileUI(payload);
      break;

    case 'sync_error':
      updateIndicator({ isSyncing: false, lastError: payload.error });
      if (typeof window['toastr'] !== 'undefined') {
        window['toastr'].error(`同步失败: ${payload.error}`, 'ST-Auto-Sync');
      }
      break;
  }
}

/**
 * 找到扩展抽屉中用于挂载面板的容器。
 * 不同 SillyTavern 版本/皮肤把面板容器放在 #extensions_settings2 或 #extensions_settings,
 * 所以两个都试,避免"面板明明装好了却不在抽屉里"。
 */
function findPanelContainer() {
  const selectors = ['#extensions_settings2', '#extensions_settings', '#extensions_settings_container'];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

let settingsPanelEl = null;

function ensurePanelElement() {
  // 关键:面板元素在挂载前并不在 document 里,getElementById 找不到,
  // 所以必须自己持有引用,否则"容器延迟出现"时会挂上一个空白面板。
  if (settingsPanelEl && settingsPanelEl.isConnected) {
    return settingsPanelEl;
  }

  const existing = document.getElementById('st-sync-settings-panel');
  if (existing) {
    settingsPanelEl = existing;
    return settingsPanelEl;
  }

  if (!settingsPanelEl) {
    settingsPanelEl = document.createElement('div');
    settingsPanelEl.id = 'st-sync-settings-panel';
    // 与 ST 其它扩展一致:用 inline-drawer 结构,才能在抽屉里显示为可折叠条目
    settingsPanelEl.className = 'inline-drawer st-sync-settings-container';
  }
  return settingsPanelEl;
}

/**
 * 把面板挂进抽屉;抽屉容器是延迟渲染的,所以带重试。
 */
function mountSettingsPanel(attemptsLeft = 20, delayMs = 500) {
  const panel = ensurePanelElement();
  const container = findPanelContainer();

  if (container) {
    if (panel.parentElement !== container) {
      container.appendChild(panel);
      console.log(`[ST-Auto-Sync] Settings panel mounted into #${container.id}`);
    }
    return true;
  }

  if (attemptsLeft > 0) {
    setTimeout(() => mountSettingsPanel(attemptsLeft - 1, delayMs), delayMs);
    return false;
  }

  // 兜底:极端情况下挂到 body,至少保证功能可用,并在控制台说明原因
  if (!panel.parentElement) {
    document.body.appendChild(panel);
    console.warn('[ST-Auto-Sync] Could not find an extensions drawer container; panel mounted to <body> as a fallback.');
  }
  return false;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTimestamp(ts) {
  if (!ts) return '(未知时间)';
  try {
    return new Date(Number(ts)).toLocaleString();
  } catch (_) {
    return String(ts);
  }
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 渲染 Hub 备份总览(哪些文件有历史版本)
 */
function renderBackupList(box, files) {
  if (!files.length) {
    box.innerHTML = '<small class="st-sync-help-text">还没有历史版本 —— Hub 会在每次「覆盖/删除」前才留存旧版本,所以刚接入时是空的。</small>';
    return;
  }

  box.innerHTML = files.map((f) => `
    <div class="st-sync-backup-row">
      <div class="st-sync-backup-name" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
      <div class="st-sync-backup-meta">${f.versions} 个版本 · 最近 ${fmtTimestamp(f.latestTimestamp)} · 来源 ${escapeHtml(f.latestDevice)}</div>
      <div class="menu_button menu_button_icon st-sync-backup-open" data-path="${escapeHtml(f.path)}">查看版本</div>
    </div>
  `).join('');

  box.querySelectorAll('.st-sync-backup-open').forEach((el) => {
    el.addEventListener('click', async () => {
      const relPath = el.getAttribute('data-path');
      box.innerHTML = `<small class="st-sync-help-text">正在读取「${escapeHtml(relPath)}」的历史版本…</small>`;
      try {
        const res = await fetch(`${API_BASE}/versions?path=${encodeURIComponent(relPath)}`);
        const data = await res.json();
        renderVersionList(box, relPath, data.versions || []);
      } catch (e) {
        box.innerHTML = `<small class="st-sync-help-text">读取失败: ${escapeHtml(e.message)}</small>`;
      }
    });
  });
}

/**
 * 渲染某个文件的历史版本列表,每行可一键回滚
 */
function renderVersionList(box, relPath, versions) {
  const header = `
    <div class="st-sync-backup-head">
      <span title="${escapeHtml(relPath)}">📄 ${escapeHtml(relPath)}</span>
      <div class="menu_button menu_button_icon st-sync-backup-back">← 返回列表</div>
    </div>
  `;

  const rows = versions.length
    ? versions.map((v) => `
        <div class="st-sync-backup-row">
          <div class="st-sync-backup-name">${fmtTimestamp(v.timestamp)}</div>
          <div class="st-sync-backup-meta">来源 ${escapeHtml(v.deviceId)} · ${fmtSize(v.size)} · #${escapeHtml(v.hashShort)}</div>
          <div class="menu_button menu_button_icon st-sync-version-restore"
               data-path="${escapeHtml(relPath)}" data-version="${escapeHtml(v.id)}">恢复此版本</div>
        </div>
      `).join('')
    : '<small class="st-sync-help-text">该文件没有历史版本。</small>';

  box.innerHTML = header + rows;

  box.querySelector('.st-sync-backup-back')?.addEventListener('click', async () => {
    const res = await fetch(`${API_BASE}/backups`);
    const data = await res.json();
    renderBackupList(box, data.files || []);
  });

  box.querySelectorAll('.st-sync-version-restore').forEach((el) => {
    el.addEventListener('click', async () => {
      const path2 = el.getAttribute('data-path');
      const versionId = el.getAttribute('data-version');
      if (!window.confirm(`把「${path2}」回滚到这个版本?\n\n本机当前文件会先另存到 .stsync/restore-backup/ 下。`)) return;
      el.classList.add('disabled');
      try {
        const result = await postJson('/restore-version', { path: path2, versionId });
        window['toastr']?.success?.(`已回滚:${path2}(${fmtSize(result.restoredBytes)})`, 'ST-Auto-Sync');
        if (!result.archivedLocalCopy) {
          window['toastr']?.info?.('本机原本没有这个文件,已直接写入', 'ST-Auto-Sync');
        }
        await triggerChatReload(`Version rollback for ${path2}`);
      } catch (e) {
        alert('回滚失败: ' + e.message);
      } finally {
        el.classList.remove('disabled');
      }
    });
  });
}

/**
 * =============================================================================
 * 云酒馆配置中心 (Cloud Profile Master)
 * 解决云服务器部署下，新设备/新浏览器初次访问变空白、必须重新配置 API 的痛点。
 * =============================================================================
 */

async function fetchCloudProfile() {
  try {
    const res = await fetch(`${API_BASE}/cloud-profile`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.profile || null;
  } catch (err) {
    console.warn('[ST-Auto-Sync] Failed to fetch cloud profile:', err);
    return null;
  }
}

/**
 * 将云端母版配置灌入当前浏览器
 * 严格执行安全过滤：绝不将明文私钥落盘至浏览器的 localStorage 或 DOM，直接利用服务端反代请求
 */
async function applyCloudProfile(profile, isAuto = false) {
  if (!profile || !profile.settings) {
    if (!isAuto) {
      window['toastr']?.warning?.('云端服务器尚未固化配置母版，请先在已配好的设备上点击「固化当前配置为云端母版」', 'ST-Auto-Sync 云酒馆');
    }
    return false;
  }

  const s = profile.settings;
  const ctx = getStContext();

  // 1. 注入 localStorage (仅注入模型、预设等非敏感项，严格过滤明文密钥)
  for (const [k, v] of Object.entries(s)) {
    const lower = k.toLowerCase();
    if (lower.startsWith('api_key') || lower.includes('secret') || lower.includes('token') || lower.includes('password')) {
      continue;
    }
    if (typeof v === 'string') {
      localStorage.setItem(k, v);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      localStorage.setItem(k, String(v));
    }
  }

  // 2. 注入 SillyTavern 运行时上下文与设置（过滤掉敏感字段）
  if (ctx && ctx.settings && typeof ctx.settings === 'object') {
    const safeSettings = { ...s };
    for (const k of Object.keys(safeSettings)) {
      const lower = k.toLowerCase();
      if (lower.startsWith('api_key') || lower.includes('secret') || lower.includes('token') || lower.includes('password')) {
        delete safeSettings[k];
      }
    }
    Object.assign(ctx.settings, safeSettings);
    try { ctx.saveSettingsDebounced?.(); } catch (_) {}
  }

  // 3. 联动 DOM 控件（若已在页面渲染）
  const setVal = (selector, val) => {
    const el = document.querySelector(selector);
    if (el && typeof val !== 'undefined' && val !== null) {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  setVal('#main_api', s.main_api);
  setVal('#api_server_openai', s.api_server_openai);
  // 注意：云端酒馆直接使用服务端 secrets.json 进行后端安全代理，无需在前端输入框反显明文私钥
  setVal('#model_openai_select', s.model_openai || s.openai_model);
  setVal('#settings_preset', s.preset);
  setVal('#context_preset', s.context);
  setVal('#instruct_preset', s.instruct);

  // 标记本机已完成注水，避免每次页面刷新反复覆盖用户自定义微调
  try {
    localStorage.setItem('st_auto_sync_hydrated_v1', 'true');
  } catch (_) {}

  const sum = profile.summary || {};
  const msg = `已注入云端母版: ${sum.main_api || 'API'} (${sum.model || '模型'}) · 预设: ${sum.preset || '默认'}`;
  window['toastr']?.success?.(msg, 'ST-Auto-Sync 云酒馆就绪');

  // 触发 API 检测
  setTimeout(() => {
    document.querySelector('#api_button')?.click?.();
    document.querySelector('#api_loading_openai')?.click?.();
  }, 300);

  return true;
}

/**
 * 将当前浏览器的完整环境提取并固化为云端母版
 */
async function saveBrowserAsCloudProfile() {
  const ctx = getStContext();
  const s = (ctx && ctx.settings) ? ctx.settings : {};
  const collected = { ...s };

  // 补齐 localStorage 中存有的所有 API / 模型键值
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (
      k.startsWith('api_') ||
      k.startsWith('model_') ||
      k.startsWith('custom_url_') ||
      k === 'main_api' ||
      k === 'preset' ||
      k === 'context' ||
      k === 'instruct' ||
      k === 'openai_model' ||
      k === 'claude_model'
    ) {
      collected[k] = localStorage.getItem(k);
    }
  }

  const payload = {
    profile: {
      settings: collected,
      secrets: (ctx && ctx.secrets) ? ctx.secrets : null
    },
    deviceName: currentConfig?.deviceName || 'Web-Browser'
  };

  const res = await postJson('/cloud-profile/save', payload);
  if (res.success && res.profile) {
    const sum = res.profile.summary || {};
    window['toastr']?.success?.(`云端母版已固化！包含 API: ${sum.main_api}, 模型: ${sum.model}, 预设: ${sum.preset}`, 'ST-Auto-Sync');
    localStorage.setItem('st_auto_sync_hydrated_v1', 'true');
    updateCloudProfileUI(res.profile);
  } else {
    throw new Error(res.error || '保存失败');
  }
}

/**
 * 新设备打开页面时自动检测并注水
 * 修复：通过 st_auto_sync_hydrated_v1 杜绝每次页面刷新都重复注水覆盖用户修改的严重问题
 */
async function checkAndHydrateCloudProfile() {
  if (localStorage.getItem('st_auto_sync_auto_hydrate') === 'false') {
    return;
  }

  // 1. 已注水标记检查：防止每次刷新页面重复注水，冲垮手机/当前设备运行时的微调设置
  if (localStorage.getItem('st_auto_sync_hydrated_v1') === 'true') {
    return;
  }

  // 2. 检测当前设备是否已自行配置过（已有配置则不自动覆盖，仅补齐已注水标记）
  const ctx = getStContext();
  const ctxSettings = ctx?.settings || {};
  const hasConfig = !!localStorage.getItem('api_key_openai') ||
                    !!localStorage.getItem('api_server_openai') ||
                    !!localStorage.getItem('main_api') ||
                    !!ctxSettings.api_server_openai ||
                    !!(ctxSettings.main_api && ctxSettings.main_api !== 'disabled');

  if (hasConfig) {
    localStorage.setItem('st_auto_sync_hydrated_v1', 'true');
    return;
  }

  // 3. 空白新设备：从云端拉取母版注水
  console.log('[ST-Auto-Sync] New browser/device detected without settings. Hydrating from cloud profile...');
  const profile = await fetchCloudProfile();
  if (profile && profile.settings) {
    await applyCloudProfile(profile, true);
    localStorage.setItem('st_auto_sync_hydrated_v1', 'true');
  }
}

function updateCloudProfileUI(profile) {
  const badge = document.getElementById('st-sync-cloud-badge');
  const summaryBox = document.getElementById('st-sync-cloud-summary');
  if (!badge || !summaryBox) return;

  if (profile && profile.summary) {
    badge.textContent = '已固化母版';
    badge.style.background = 'rgba(16, 185, 129, 0.2)';
    badge.style.color = '#10b981';

    const sum = profile.summary;
    const timeStr = fmtTimestamp(profile.updated_at);
    summaryBox.style.display = 'block';
    summaryBox.innerHTML = `
      <div><b>云端母版状态：</b>已生效</div>
      <div>· 接口与模型: <code>${escapeHtml(sum.main_api || 'openai')}</code> (<code>${escapeHtml(sum.model || '未指定')}</code>)</div>
      <div>· 预设与模板: <code>${escapeHtml(sum.preset || '默认')}</code> / <code>${escapeHtml(sum.instruct || '默认')}</code></div>
      <div style="opacity: 0.75; font-size: 0.75rem; margin-top: 3px;">固化设备: ${escapeHtml(profile.updated_by || '未知')} · 更新于: ${timeStr}</div>
    `;
  } else {
    badge.textContent = '未固化母版';
    badge.style.background = 'rgba(255, 255, 255, 0.1)';
    badge.style.color = 'inherit';
    summaryBox.style.display = 'none';
    summaryBox.innerHTML = '';
  }
}

async function renderSettingsPanel() {
  mountSettingsPanel();

  let panel = ensurePanelElement();

  // 获取当前后端状态
  let status = {};
  try {
    const res = await fetch(`${API_BASE}/status`);
    status = await res.json();
    currentConfig = status.config || {};
  } catch (err) {
    console.error('[ST-Auto-Sync] Failed to fetch status:', err);
  }

  const cfg = currentConfig || {};

  const badgeText = statusBadgeText(status);

  panel.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header st-sync-drawer-header">
      <b class="st-sync-drawer-title">🔄 ST-Auto-Sync 多端同步</b>
      <span id="st-sync-drawer-badge" class="st-sync-drawer-badge">${badgeText}</span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>

    <div class="inline-drawer-content" style="display: none;">
      <div class="st-sync-card">
        <div class="st-sync-headline">
          <b>SillyTavern 多端自动同步</b>
          <span class="st-sync-badge" id="st-sync-badge-status">${badgeText}</span>
        </div>

        <label for="st-sync-hub-url">Hub 服务端地址</label>
        <input type="text" id="st-sync-hub-url" class="text_pole" placeholder="http://你的服务器:8765" value="${cfg.hubUrl || ''}" />
        <small class="st-sync-help-text">填 Hub 地址;用 https:// 会自动走 wss 加密连接。</small>

        <label for="st-sync-token">同步秘钥 (Token)</label>
        <input type="password" id="st-sync-token" class="text_pole" placeholder="所有设备填同一个" value="${cfg.token || ''}" />

        <label for="st-sync-dev-name">设备名称</label>
        <input type="text" id="st-sync-dev-name" class="text_pole" placeholder="如 PC-Windows 或 Phone-Termux" value="${cfg.deviceName || ''}" />

        <label>同步模式</label>
        <div class="st-sync-options">
          <label class="checkbox_label">
            <input type="radio" name="st-sync-mode" value="realtime" ${cfg.mode === 'realtime' ? 'checked' : ''} />
            <span>⚡ 实时模式(同屏即时联动)</span>
          </label>
          <label class="checkbox_label">
            <input type="radio" name="st-sync-mode" value="interval" ${cfg.mode === 'interval' ? 'checked' : ''} />
            <span>⏱️ 定时轮询(省电省流量)</span>
          </label>
          <label class="checkbox_label">
            <input type="radio" name="st-sync-mode" value="manual" ${cfg.mode === 'manual' ? 'checked' : ''} />
            <span>🛑 仅手动同步</span>
          </label>
        </div>

        <div id="st-sync-interval-group" style="display: ${cfg.mode === 'interval' ? 'block' : 'none'};">
          <label for="st-sync-interval-val">定时同步间隔(分钟)</label>
          <input type="number" id="st-sync-interval-val" class="text_pole" min="1" max="1440" value="${cfg.intervalMinutes || 10}" />
        </div>

        <div class="st-sync-notice">
          <label class="checkbox_label">
            <input type="checkbox" id="sync-env" ${cfg.syncEnvironment !== false ? 'checked' : ''} />
            <span>🚀 开箱即聊环境同步(API / Key / 模型 / 预设)</span>
          </label>
          <small class="st-sync-help-text">
            同步 API 密钥 (secrets.json)、模型选型、反代地址与生成预设,新设备装好即聊;各端 UI 主题与窗口布局互不影响。
          </small>
        </div>

        <label>同步数据类别</label>
        <div class="st-sync-options">
          <label class="checkbox_label">
            <input type="checkbox" id="sync-cat-chats" checked disabled />
            <span>聊天记录(无损合并)</span>
          </label>
          <label class="checkbox_label">
            <input type="checkbox" id="sync-cat-chars" ${(cfg.syncCategories || []).includes('characters') ? 'checked' : ''} />
            <span>角色卡与头像</span>
          </label>
          <label class="checkbox_label">
            <input type="checkbox" id="sync-cat-worlds" ${(cfg.syncCategories || []).includes('worlds') ? 'checked' : ''} />
            <span>世界书 (Lorebooks)</span>
          </label>
          <label class="checkbox_label">
            <input type="checkbox" id="sync-cat-presets" ${(cfg.syncCategories || []).includes('presets') || (cfg.syncCategories || []).includes('context') ? 'checked' : ''} />
            <span>提示词与预设包</span>
          </label>
          <label class="checkbox_label">
            <input type="checkbox" id="sync-cat-personas" ${(cfg.syncCategories || []).includes('personas') ? 'checked' : ''} />
            <span>个人人设 (Personas)</span>
          </label>
        </div>

        <div class="st-sync-actions">
          <div id="st-sync-save-btn" class="menu_button menu_button_icon">💾 保存并应用配置</div>
          <div id="st-sync-now-btn" class="menu_button menu_button_icon">🔄 立即手动同步</div>
        </div>

        <div class="st-sync-notice">
          <label class="checkbox_label">
            <span><b>🗂 备份与恢复</b></span>
          </label>
          <small class="st-sync-help-text">
            Hub 会在每次覆盖/删除前自动留存旧版本(每文件最多 20 份)。这里可以查看历史版本并回滚,或一键以 Hub 为准恢复本机。
          </small>
          <div class="st-sync-actions">
            <div id="st-sync-restore-btn" class="menu_button menu_button_icon">⬇️ 从 Hub 全量恢复</div>
            <div id="st-sync-backups-btn" class="menu_button menu_button_icon">📋 查看备份版本</div>
          </div>
          <div id="st-sync-backups-panel" class="st-sync-backups-panel" style="display: none;"></div>
        </div>

        <div class="st-sync-notice st-sync-cloud-profile-box">
          <div class="st-sync-cloud-header">
            <b>☁️ 云酒馆配置中心 (新设备免配即聊)</b>
            <span id="st-sync-cloud-badge" class="st-sync-badge">读取中…</span>
          </div>
          <small class="st-sync-help-text">
            专为云端部署（VPS/服务器）打造：解决在电脑配好后、手机等新设备登入变白板的问题。把当前 API/Key/模型/预设固化为云端母版，任何新设备首次打开网页自动注水填充，直接开聊！
          </small>
          <div id="st-sync-cloud-summary" class="st-sync-cloud-summary" style="display: none;"></div>
          <div class="st-sync-actions">
            <div id="st-sync-cloud-save-btn" class="menu_button menu_button_icon">⭐ 固化当前设置为云端母版</div>
            <div id="st-sync-cloud-load-btn" class="menu_button menu_button_icon">📥 从云端载入母版到当前设备</div>
          </div>
          <label class="checkbox_label" style="margin-top: 6px;">
            <input type="checkbox" id="st-sync-auto-hydrate-chk" ${localStorage.getItem('st_auto_sync_auto_hydrate') !== 'false' ? 'checked' : ''} />
            <span>新设备初次访问时自动注水激活</span>
          </label>
        </div>
      </div>
    </div>
  `;

  // 内容填充完毕后再确认一次挂载:如果抽屉容器是在 await 期间才出现的,这里能补上
  mountSettingsPanel();

  // 徽标按最新状态刷新
  refreshPanelBadges(status);

  // 绑定事件
  document.querySelectorAll('input[name="st-sync-mode"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const intervalGroup = document.getElementById('st-sync-interval-group');
      if (intervalGroup) {
        intervalGroup.style.display = e.target.value === 'interval' ? 'block' : 'none';
      }
    });
  });

  document.getElementById('st-sync-save-btn')?.addEventListener('click', async () => {
    const hubUrl = document.getElementById('st-sync-hub-url').value.trim();
    const token = document.getElementById('st-sync-token').value.trim();
    const deviceName = document.getElementById('st-sync-dev-name').value.trim();
    const mode = document.querySelector('input[name="st-sync-mode"]:checked')?.value || 'realtime';
    const intervalMinutes = parseInt(document.getElementById('st-sync-interval-val').value, 10) || 10;
    const syncEnvironment = document.getElementById('sync-env').checked;

    const syncCategories = ['chats'];
    if (document.getElementById('sync-cat-chars').checked) syncCategories.push('characters');
    if (document.getElementById('sync-cat-worlds').checked) syncCategories.push('worlds');
    if (document.getElementById('sync-cat-presets').checked) {
      syncCategories.push(
        'context',
        'instruct',
        'OpenAI Settings',
        'textgen_settings',
        'kobold_settings',
        'novelai_settings',
        'presets'
      );
    }
    if (document.getElementById('sync-cat-personas').checked) {
      syncCategories.push('personas');
    }

    const newCfg = {
      hubUrl,
      token,
      deviceName,
      mode,
      intervalMinutes,
      syncCategories,
      syncEnvironment
    };

    try {
      const data = await postJson('/config', newCfg);
      if (data.success) {
        if (typeof window['toastr'] !== 'undefined') {
          window['toastr'].success('配置已保存并生效！', 'ST-Auto-Sync');
        }
        currentConfig = { ...newCfg };
        updateIndicator(data);
        refreshPanelBadges(data);
      } else {
        alert('保存失败: ' + (data.error || '未知错误'));
      }
    } catch (e) {
      alert('保存失败: ' + e.message);
    }
  });

  document.getElementById('st-sync-now-btn')?.addEventListener('click', async () => {
    try {
      updateIndicator({ isSyncing: true });
      const data = await postJson('/sync', {});
      if (data.success) {
        if (typeof window['toastr'] !== 'undefined') {
          window['toastr'].success(`手动同步完成 (上传: ${data.uploadedCount || 0}, 下载: ${data.downloadedCount || 0})`, 'ST-Auto-Sync');
        }
      } else {
        const reasonMap = {
          Unconfigured: '还没配置 Hub 地址或同步秘钥,请先填写并点「保存并应用配置」',
          'Hub URL or Token is not configured': '还没配置 Hub 地址或同步秘钥,请先填写并点「保存并应用配置」'
        };
        const reason = data.error || data.reason || '未知原因';
        if (typeof window['toastr'] !== 'undefined') {
          window['toastr'].error(`同步失败: ${reasonMap[reason] || reason}`, 'ST-Auto-Sync');
        }
      }
    } catch (e) {
      alert('同步失败: ' + e.message);
    }
  });

  // 6. 从 Hub 全量恢复(只拉不推)
  document.getElementById('st-sync-restore-btn')?.addEventListener('click', async () => {
    const ok = window.confirm('将从 Hub 拉取全部文件并覆盖本机。\n\n本机被覆盖的旧文件会先另存到 data/.../.stsync/restore-backup/ 下,可随时找回。\n\n确定继续吗?');
    if (!ok) return;

    const btn = document.getElementById('st-sync-restore-btn');
    if (btn) btn.classList.add('disabled');
    try {
      const data = await postJson('/restore', {});
      const msg = `恢复完成:拉取 ${data.restored} 个文件` + (data.archived ? `,本机旧文件另存 ${data.archived} 个` : '');
      window['toastr']?.success?.(msg, 'ST-Auto-Sync');
      if (data.archiveDir) console.log('[ST-Auto-Sync] 本机旧文件备份目录:', data.archiveDir);
      if (data.failed?.length) {
        console.warn('[ST-Auto-Sync] 恢复失败的文件:', data.failed);
        window['toastr']?.warning?.(`有 ${data.failed.length} 个文件恢复失败(详见控制台)`, 'ST-Auto-Sync');
      }
      if (data.restored > 0) {
        await triggerChatReload('Full restore from Hub completed');
      }
    } catch (e) {
      alert('恢复失败: ' + e.message);
    } finally {
      if (btn) btn.classList.remove('disabled');
    }
  });

  // 7. 查看 Hub 上的历史版本(可回滚)
  document.getElementById('st-sync-backups-btn')?.addEventListener('click', async () => {
    const box = document.getElementById('st-sync-backups-panel');
    if (!box) return;

    if (box.style.display !== 'none' && box.innerHTML.trim()) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }

    box.style.display = 'block';
    box.innerHTML = '<small class="st-sync-help-text">正在读取 Hub 备份列表…</small>';
    try {
      const res = await fetch(`${API_BASE}/backups`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderBackupList(box, data.files || []);
    } catch (e) {
      box.innerHTML = `<small class="st-sync-help-text">读取失败: ${escapeHtml(e.message)}(检查 Hub 地址/Token 是否已保存)</small>`;
    }
  });

  // 8. 云酒馆配置中心：固化当前配置为云端母版
  document.getElementById('st-sync-cloud-save-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('st-sync-cloud-save-btn');
    if (btn) btn.classList.add('disabled');
    try {
      await saveBrowserAsCloudProfile();
    } catch (e) {
      alert('固化失败: ' + e.message);
    } finally {
      if (btn) btn.classList.remove('disabled');
    }
  });

  // 8.1 从云端载入母版到当前设备
  document.getElementById('st-sync-cloud-load-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('st-sync-cloud-load-btn');
    if (btn) btn.classList.add('disabled');
    try {
      const profile = await fetchCloudProfile();
      await applyCloudProfile(profile, false);
    } catch (e) {
      alert('载入失败: ' + e.message);
    } finally {
      if (btn) btn.classList.remove('disabled');
    }
  });

  // 8.2 自动注水开关切换
  document.getElementById('st-sync-auto-hydrate-chk')?.addEventListener('change', (e) => {
    localStorage.setItem('st_auto_sync_auto_hydrate', e.target.checked ? 'true' : 'false');
    window['toastr']?.info?.(
      e.target.checked ? '已开启新设备初次访问自动注水' : '已关闭自动注水',
      'ST-Auto-Sync 云酒馆'
    );
  });

  // 异步获取并刷新云端母版状态
  fetchCloudProfile().then((p) => updateCloudProfileUI(p));
}

/**
 * 监听 SillyTavern 原生消息事件
 */
function hookSillyTavernEvents() {
  const tryHook = () => {
    // 监听全局 eventSource
    const evSource = window['eventSource'] || getStContext().eventSource;
    const evTypes = window['event_types'] || getStContext().event_types;

    if (!evSource || !evTypes) {
      setTimeout(tryHook, 1000);
      return;
    }

    const onMessageEvent = (type) => {
      try {
        const charName = window['characters']?.[window['this_chid']]?.name || '';
        const currentChatFile = window['selected_chat'] || '';

        // 通知插件后端执行广播(需带 CSRF token)
        postJson('/chat-event', {
          chatFile: currentChatFile ? `chats/${currentChatFile}.jsonl` : '',
          characterName: charName,
          type
        }).catch(() => {});
      } catch (_) {}
    };

    if (evTypes.MESSAGE_SENT) {
      evSource.on(evTypes.MESSAGE_SENT, () => onMessageEvent('sent'));
    }
    if (evTypes.CHAT_COMPLETED) {
      evSource.on(evTypes.CHAT_COMPLETED, () => onMessageEvent('completed'));
    }

    console.log('[ST-Auto-Sync] Hooked into SillyTavern eventSource successfully.');
  };

  tryHook();
}

// 扩展自启动入口
(function initExtension() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  if (window.__ST_TEST_SKIP_INIT) {
    return;
  }

  console.log('[ST-Auto-Sync] Initializing ST-Auto-Sync client extension...');

  // 面板挂载优先且独立:任何一步出错都不能连累它
  try {
    renderSettingsPanel();
  } catch (err) {
    console.error('[ST-Auto-Sync] Failed to render settings panel:', err);
  }

  try {
    createTopBarIndicator();
  } catch (err) {
    console.error('[ST-Auto-Sync] Failed to create top bar indicator:', err);
  }

  try {
    initSseListener();
  } catch (err) {
    console.error('[ST-Auto-Sync] Failed to open SSE channel:', err);
  }

  try {
    hookSillyTavernEvents();
  } catch (err) {
    console.error('[ST-Auto-Sync] Failed to hook SillyTavern events:', err);
  }

  // 抽屉容器可能晚于脚本就绪,再补挂一次
  setTimeout(() => {
    try {
      mountSettingsPanel();
    } catch (_) { }
  }, 1200);

  // 延迟检测并执行云酒馆配置自动注水（新设备打开即自动载入 API/Key/模型）
  setTimeout(() => {
    try {
      checkAndHydrateCloudProfile();
    } catch (_) { }
  }, 800);

  // 定期拉取状态:页面刚打开时插件后端可能尚未连上 Hub,
  // 徽标只渲染一次会一直停在「未配置/未连接」,这里让它自己纠正过来。
  const pollStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/status`);
      if (!res.ok) return;
      const status = await res.json();
      currentConfig = status.config || currentConfig;
      updateIndicator(status);
      refreshPanelBadges(status);
    } catch (_) { }
  };

  pollStatus();
  setInterval(() => {
    if (!document.hidden) pollStatus();
  }, 10000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      pollStatus();
    }
  });
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    applyCloudProfile,
    saveBrowserAsCloudProfile,
    checkAndHydrateCloudProfile,
    fetchCloudProfile,
    updateCloudProfileUI
  };
}
