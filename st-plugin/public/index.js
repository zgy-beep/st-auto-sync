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
    // 点击快速跳转到扩展设置抽屉
    const extButton = document.querySelector('#extensions-button') || document.querySelector('#nav-toggle-extensions');
    if (extButton) extButton.click();
    const panel = document.getElementById('st-sync-settings-panel');
    if (panel) panel.scrollIntoView({ behavior: 'smooth' });
  });

  container.appendChild(indicator);
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
 * 渲染前端设置抽屉面板
 */
async function renderSettingsPanel() {
  const targetParent = document.getElementById('extensions_settings');
  if (!targetParent) return;

  let panel = document.getElementById('st-sync-settings-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'st-sync-settings-panel';
    panel.className = 'st-sync-settings-container';
    targetParent.appendChild(panel);
  }

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

  panel.innerHTML = `
    <div class="st-sync-card">
      <div class="st-sync-card-title">
        <span>🔄 SillyTavern 多端自动同步</span>
        <span class="st-sync-badge" id="st-sync-badge-status">${status.connected ? '已连接' : '未连接'}</span>
      </div>

      <div class="st-sync-form-group">
        <label>Hub 服务端地址 (公网服务器 / NAS)：</label>
        <input type="text" id="st-sync-hub-url" class="st-sync-input" placeholder="http://your-server-ip:8765" value="${cfg.hubUrl || ''}" />
      </div>

      <div class="st-sync-form-group">
        <label>同步秘钥 (Token)：</label>
        <input type="password" id="st-sync-token" class="st-sync-input" placeholder="输入任意相同密码以互通" value="${cfg.token || ''}" />
      </div>

      <div class="st-sync-form-group">
        <label>设备名称 (Device Name)：</label>
        <input type="text" id="st-sync-dev-name" class="st-sync-input" placeholder="如 PC-Windows 或 Phone-Termux" value="${cfg.deviceName || ''}" />
      </div>

      <div class="st-sync-form-group">
        <label>同步模式选择：</label>
        <div class="st-sync-mode-selector">
          <label class="st-sync-mode-option">
            <input type="radio" name="st-sync-mode" value="realtime" ${cfg.mode === 'realtime' ? 'checked' : ''} />
            <span>⚡ 实时模式 (同屏即时联动)</span>
          </label>
          <label class="st-sync-mode-option">
            <input type="radio" name="st-sync-mode" value="interval" ${cfg.mode === 'interval' ? 'checked' : ''} />
            <span>⏱️ 定时轮询 (省电/省流)</span>
          </label>
          <label class="st-sync-mode-option">
            <input type="radio" name="st-sync-mode" value="manual" ${cfg.mode === 'manual' ? 'checked' : ''} />
            <span>🛑 仅手动同步</span>
          </label>
        </div>
      </div>

      <div class="st-sync-form-group" id="st-sync-interval-group" style="display: ${cfg.mode === 'interval' ? 'flex' : 'none'};">
        <label>定时同步间隔 (分钟)：</label>
        <input type="number" id="st-sync-interval-val" class="st-sync-input" min="1" max="1440" value="${cfg.intervalMinutes || 10}" />
      </div>

      <div class="st-sync-form-group">
        <label>同步内容选择：</label>
        <div class="st-sync-checkbox-grid">
          <label class="st-sync-checkbox-item"><input type="checkbox" id="sync-cat-chats" checked disabled /> 聊天记录 (增量)</label>
          <label class="st-sync-checkbox-item"><input type="checkbox" id="sync-cat-chars" ${(cfg.syncCategories || []).includes('characters') ? 'checked' : ''} /> 角色卡</label>
          <label class="st-sync-checkbox-item"><input type="checkbox" id="sync-cat-worlds" ${(cfg.syncCategories || []).includes('worlds') ? 'checked' : ''} /> 世界书</label>
          <label class="st-sync-checkbox-item"><input type="checkbox" id="sync-cat-presets" ${(cfg.syncCategories || []).includes('context') ? 'checked' : ''} /> 预设与模板</label>
          <label class="st-sync-checkbox-item"><input type="checkbox" id="sync-cat-settings" ${cfg.syncSettings ? 'checked' : ''} /> 全局设置 (可选)</label>
        </div>
      </div>

      <div class="st-sync-btn-group">
        <button id="st-sync-save-btn" class="st-sync-btn st-sync-btn-primary">💾 保存并应用配置</button>
        <button id="st-sync-now-btn" class="st-sync-btn st-sync-btn-secondary">🔄 立即手动同步</button>
      </div>
    </div>
  `;

  // 绑定事件
  document.querySelectorAll('input[name="st-sync-mode"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const intervalGroup = document.getElementById('st-sync-interval-group');
      if (intervalGroup) {
        intervalGroup.style.display = e.target.value === 'interval' ? 'flex' : 'none';
      }
    });
  });

  document.getElementById('st-sync-save-btn')?.addEventListener('click', async () => {
    const hubUrl = document.getElementById('st-sync-hub-url').value.trim();
    const token = document.getElementById('st-sync-token').value.trim();
    const deviceName = document.getElementById('st-sync-dev-name').value.trim();
    const mode = document.querySelector('input[name="st-sync-mode"]:checked')?.value || 'realtime';
    const intervalMinutes = parseInt(document.getElementById('st-sync-interval-val').value, 10) || 10;

    const syncCategories = ['chats'];
    if (document.getElementById('sync-cat-chars').checked) syncCategories.push('characters');
    if (document.getElementById('sync-cat-worlds').checked) syncCategories.push('worlds');
    if (document.getElementById('sync-cat-presets').checked) {
      syncCategories.push('context', 'instruct');
    }
    const syncSettings = document.getElementById('sync-cat-settings').checked;

    const newCfg = {
      hubUrl,
      token,
      deviceName,
      mode,
      intervalMinutes,
      syncCategories,
      syncSettings
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
  createTopBarIndicator();
  initSseListener();
  hookSillyTavernEvents();

  // 延迟注入设置抽屉，等待 ST UI 元素就绪
  setTimeout(() => {
    renderSettingsPanel();
  }, 1200);
})();
