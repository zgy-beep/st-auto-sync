/**
 * ST-Auto-Sync 前端扩展模块
 * 支持 SillyTavern 实时消息热重载、设置面板配置与状态监控
 */

const MODULE_NAME = 'st-auto-sync';
const API_BASE = '/api/plugins/st-auto-sync';

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
 * 刷新抽屉标题徽标 + 面板内状态徽标
 */
function refreshPanelBadges(status = {}) {
  const drawerText = status.isSyncing ? '同步中…'
    : status.connected ? '已连接'
      : (status.lastError ? '未连接' : '未配置');

  const drawerBadge = document.getElementById('st-sync-drawer-badge');
  if (drawerBadge) drawerBadge.textContent = drawerText;

  const cardBadge = document.getElementById('st-sync-badge-status');
  if (cardBadge) cardBadge.textContent = status.connected ? '已连接' : '未连接';
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
    text.textContent = status.lastError ? '异常' : '未连接';
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
      if (payload) updateIndicator(payload);
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

  const drawerBadgeText = status.isSyncing ? '同步中…'
    : status.connected ? '已连接'
      : (status.lastError ? '未连接' : '未配置');

  panel.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header st-sync-drawer-header">
      <b class="st-sync-drawer-title">🔄 ST-Auto-Sync 多端同步</b>
      <span id="st-sync-drawer-badge" class="st-sync-drawer-badge">${drawerBadgeText}</span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>

    <div class="inline-drawer-content" style="display: none;">
      <div class="st-sync-card">
        <div class="st-sync-headline">
          <b>SillyTavern 多端自动同步</b>
          <span class="st-sync-badge" id="st-sync-badge-status">${status.connected ? '已连接' : '未连接'}</span>
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
      const res = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCfg)
      });
      const data = await res.json();
      if (data.success) {
        if (typeof window['toastr'] !== 'undefined') {
          window['toastr'].success('配置已保存并生效！', 'ST-Auto-Sync');
        }
        currentConfig = newCfg;
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
      const res = await fetch(`${API_BASE}/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        if (typeof window['toastr'] !== 'undefined') {
          window['toastr'].success(`手动同步完成 (上传: ${data.uploadedCount}, 下载: ${data.downloadedCount})`, 'ST-Auto-Sync');
        }
      } else {
        if (typeof window['toastr'] !== 'undefined') {
          window['toastr'].error(`同步失败: ${data.error || data.reason}`, 'ST-Auto-Sync');
        }
      }
    } catch (e) {
      alert('同步失败: ' + e.message);
    }
  });
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

        // 通知插件后端执行广播
        fetch(`${API_BASE}/chat-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatFile: currentChatFile ? `chats/${currentChatFile}.jsonl` : '',
            characterName: charName,
            type
          })
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
})();
