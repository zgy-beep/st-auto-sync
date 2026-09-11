# 🔄 ST-Auto-Sync (SillyTavern 多端自动与实时同步系统)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![SillyTavern Compatible](https://img.shields.io/badge/SillyTavern-1.12%2B-ff69b4.svg)](https://github.com/SillyTavern/SillyTavern)

**ST-Auto-Sync** 是专为 [SillyTavern (酒馆)](https://github.com/SillyTavern/SillyTavern) 打造的多端数据同步全栈解决方案。支持在 **PC（电脑端）** 与 **手机（Termux / Android / 浏览器）** 以及多台设备之间实现**低延迟实时联动**与**定时/按需增量同步**。

---

## 🌟 4.1 工业级核心特性

- ⚡ **双模自由切换**：
  - **实时同屏模式 (Real-time Stream)**：基于 WebSocket 长连接，PC 和手机同时在线时，打字和 AI 回复毫秒级同步互通，前端界面带安全降级保护与优雅 Toast 提示。
  - **定时轮询模式 (Interval Polling)**：手机端极度省电与节省流量模式，按需设定间隔（如 5/10/30 分钟）或在切回应用时自动静默增量比对。
- 🛡️ **消息槽位唯一身份 (`mid`) 与不可变因果链**：
  - 彻底抛弃脆弱的内容哈希指纹，无论消息如何被编辑或重生成，消息槽位的 `mid` 终身不变。
  - **Tombstone 墓碑删除优先律**：以 `mid` 为准剔除被删消息，数学上彻底根除“编辑后删除导致复活”与“连续相同文本误杀”两大经典漏洞。
  - **分代 GC 与 Stale 排除**：30 天独立生命周期；离线超过 30 天的设备自动标记为 Stale，不阻塞 GC 回收，彻底拔除死锁。
- 🎯 **Swipe Candidate 结构化与 `sid` 显式重映射**：
  - 为每个重生成候选赋予全局唯一 `sid`，重映射公式：`swipe_id = extra.swipe_sids.indexOf(extra.active_sid)`。彻底杜绝雷同文本在 `indexOf` 匹配时发生下标漂移的严重 bug。
- 🌿 **因果分支保护 (Branch DAG) 与防套娃限制**：
  - 采用 **OR-2 启发式分叉判定**（用户双向主动输入、轮次 $\ge 2$、文本相似度 $< 0.65$ 等满足两项即触发）；
  - 触发深度分叉时**绝不强行交错拉平导致问答倒错**，而是自动另存为 `{Name} (冲突分支-来自{Device}).jsonl`，注入父子 DAG 血缘元数据；
  - 深度上限限制为 2 级，超限时**严禁静默丢弃**，自动冻结并转入人工合并队列。
- 🔒 **本地双写竞态四重防护 (Check-Before-Write)**：
  - 进程级文件排他互斥锁 + 原子临时文件替换（Write to .tmp & Atomic Rename）；
  - 针对 Windows 平台提供 `EPERM/EBUSY` 指数退避重试循环；
  - 覆写前校验本地哈希，若发现本地在几百毫秒内刚写下了新输入，立即内存增量拼接保留，杜绝覆盖丢失。
- ⚡ **Meta 旁车文件高性能变更监听**：
  - 在 `.stsync/` 目录下维护每个会话的 `chat.meta`；
  - 纯追加打字场景下**只读文件尾部字节偏移量**，将几 MB 历史记录的扫描 IO 开销压至零毫秒级。
- 🗂️ **历史分叉安全归档 (Fork-on-Conflict Bootstrap)**：
  - 解决部署前两端原本就存在历史分叉的难题；首次接入若检测到无共同 `mid` 的平行分叉历史，自动将本地旧记录安全归档，零风险拉取权威基准。

---

## 🏗️ 架构拓扑

```
┌────────────────────────────────────────────────────────┐
│             ST 实例 A (Windows / Mac PC)               │
│  ┌──────────────────┐       ┌───────────────────────┐  │
│  │ 前端 Extension UI │ <---> │ 服务端 Plugin (Node)  │  │
│  │ (配置/热刷新通知)  │       │ (文件监听/增量Merge)  │  │
│  └──────────────────┘       └──────────┬────────────┘  │
└────────────────────────────────────────┼───────────────┘
                                         │ WebSocket / HTTP
                                         ▼
                 ┌────────────────────────────────┐
                 │    Sync Hub 核心中继服务       │
                 │  - 身份验证与房间隔离 (Token)  │
                 │  - 消息实时分发 (Pub/Sub)      │
                 │  - 离线增量存储与状态快照       │
                 └────────────────────────────────┘
                                         ▲
                                         │ WebSocket / HTTP
┌────────────────────────────────────────┼───────────────┘
│  ┌──────────────────┐       ┌──────────┴────────────┐  │
│  │ 前端 Extension UI │ <---> │ 服务端 Plugin (Node)  │  │
│  └──────────────────┘       └───────────────────────┘  │
│             ST 实例 B (手机 Termux / 笔记本)            │
└────────────────────────────────────────────────────────┘
```

---

## 🚀 快速上手指南

### 第一步：部署中心中继服务 (Hub Server)

中心服务部署在你的**公网服务器**或**家庭 NAS**（如群晖、威联通、已配置 DDNS/公网的设备）上。

#### 选项 A：使用 Docker 一键部署（推荐）
在服务器上创建 `docker-compose.yml`：
```yaml
version: '3.8'

services:
  st-sync-hub:
    image: node:20-alpine
    container_name: st-auto-sync-hub
    restart: unless-stopped
    ports:
      - "8765:8765"
    volumes:
      - ./hub-data:/app/data
      - ./hub-server:/app
    working_dir: /app
    command: sh -c "npm install --omit=dev && node src/index.js"
```
执行启动：
```bash
docker compose up -d
```

#### 选项 B：使用 Node.js 直接运行
```bash
cd hub-server
npm install
npm start
# 默认监听 8765 端口。后台常驻可使用: pm2 start src/index.js --name st-sync-hub
```

> **提示**：若有云服务器安全组或防火墙，请确保放行 `8765` 端口（或通过 Nginx 反向代理绑定域名与 SSL 证书）。

---

### 第二步：安装 SillyTavern 插件端

在需要同步的所有设备（PC、手机 Termux 等）上安装插件：

#### 1. 将插件目录放入 SillyTavern
将仓库中的 `st-plugin` 目录复制到 SillyTavern 安装目录下的 `plugins/` 中，重命名为 `st-auto-sync`：

```bash
# 目录结构应如下：
SillyTavern/
└── plugins/
    └── st-auto-sync/
        ├── manifest.json
        ├── package.json
        ├── public/
        │   ├── index.js
        │   └── style.css
        └── server/
            ├── index.js
            ├── syncClient.js
            ├── chatMerger.js
            └── manifestHelper.js
```

#### 2. 在插件目录下安装运行依赖
进入 `SillyTavern/plugins/st-auto-sync/` 执行：
```bash
npm install
```

#### 3. 启动 SillyTavern
正常启动 SillyTavern（`Start.bat` 或 `bash start.sh`）。终端将输出：
```text
[ST-Auto-Sync] Initializing server plugin...
[ST-Auto-Sync] Target SillyTavern data directory: .../data/default-user
[ST-Auto-Sync] Plugin server routes registered successfully.
```

---

### 第三步：配置与启用同步

1. 打开 SillyTavern 网页，点击右上角 **扩展设置 (Extensions / 拼图图标)**。
2. 展开 **SillyTavern 多端自动同步** 面板：
   - **Hub 服务端地址**：填入你的服务器公网地址，例如 `http://1.2.3.4:8765` 或 `https://sync.yourdomain.com`。
   - **同步秘钥 (Token)**：输入一个你自己设定的专属密码（所有需要同步的端必须保持一致）。
   - **设备名称**：为当前设备命名（如 `我的PC`、`小米手机` 等）。
   - **同步模式**：
     - `⚡ 实时模式`：适合网络良好，两端同时开着互通；
     - `⏱️ 定时轮询`：适合手机省电模式，设定每 10 分钟同步一次。
   - **同步类别勾选**：勾选想要同步的项目（聊天记录、角色卡、世界书、预设等）。
3. 点击 **【💾 保存并应用配置】**。
4. 顶部栏将出现状态指示灯：
   - 🟢 **绿灯 (实时)**：已成功与服务器建立 WebSocket 长连接，处于即时同屏模式。
   - 🟡 **黄灯 (定时)**：处于定时省电同步模式。
   - 🔵 **蓝灯闪烁**：正在同步数据中。
   - 🔴 **红灯**：未配置或连接异常。

---

## 🧪 自动化测试验证

本项目包含完整的单元测试与端到端模拟测试：

```bash
# 运行聊天增量去重与合并测试
node tests/test_chat_merger.js

# 运行双端并发联调全链路模拟测试
node tests/test_e2e_sync.js
```

---

## ❓ 常见问题 (FAQ)

**Q: 手机 Termux 息屏后断开连接怎么办？**
> 插件具备指数退避自动重连机制。手机亮屏重新进入酒馆界面时，插件会自动恢复连接并向 Hub 请求离线期间落下的消息差额（Catch-up），几秒内自动补齐。

**Q: 两端不同分辨率，界面设置（主题、文字大小）会被覆盖吗？**
> 不会。默认设置中关闭了 `全局设置 (settings.json)` 的同步，只同步核心资产（聊天、卡片、世界书），各端的 UI 偏好彼此独立，安全无冲突。

**Q: 我只在局域网内使用可以吗？**
> 完全可以！把 Hub 部署在家里局域网的一台电脑或 NAS 上，Hub 地址填 `http://192.168.x.x:8765`，手机连家里的 WiFi 即可畅享局域网内同步。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
