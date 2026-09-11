# 🔄 ST-Auto-Sync (SillyTavern 多端自动同步插件)

> 🎮 **“电脑聊完，出门手机接着聊；双端同时在线，像聊天软件一样实时互通！”**
> 专为 [SillyTavern (酒馆)](https://github.com/SillyTavern/SillyTavern) 打造的多设备自动同步神器。支持 **电脑端 (Windows/Mac)** 与 **手机端 (Termux/移动浏览器)** 之间的无缝数据互通。

---

## ✨ 你能用它做什么？

* 📱 **电脑/手机无缝接力**：在家用电脑大屏聊，出门在手机 Termux 上接着聊，进度完全一致。
* 🚀 **开箱即聊，零二次配置**：换新设备或手机重装酒馆后，**API 密钥 (Key)、反代地址、模型选型、生成参数、提示词预设与人设全部自动对齐**，装好就能直接开聊，省去繁琐重配！
* ⚡ **实时同屏联动**：两台设备同时开着同一个角色，电脑发一句，手机屏幕上**实时同步弹显**，就像用即时通讯软件一样自然！
* 🛡️ **断网无忧，智能合并**：即使手机在地铁/断网时聊了几句，重新联网后会自动无缝补全，**绝对不会互相粗暴覆盖或丢失记录**。
* 🎨 **全量资产同步**：不仅同步**聊天记录**，你的**角色卡**、**世界书 (Lorebook)**、**预设模板**全部自动同步。
* 💡 **个性外观互不干扰**：各端的窗口大小、界面主题、字号缩放各自独立保留，绝不会因为手机屏幕小而把电脑的界面排版搞乱。

---

## 🚀 三步极速上手指南

整个同步系统分为两部分：
1. **中继服务 (Hub)**：部署在你的公网服务器或家庭 NAS 上（电脑不用关机也可以直接挂在电脑后台）；
2. **酒馆插件 (Plugin)**：装在电脑和手机的 SillyTavern 里。

---

### 第一步：启动中继服务 (二选一)

中继服务极其轻量（内存占用不到 50MB），无论是在云服务器还是家庭 NAS（群晖、威联通、家庭存储等）都能轻松运行。

#### 方式 A：Docker 一键启动（最推荐）

在服务器上克隆本仓库，然后构建并启动（`hub-server/` 里已带好 `Dockerfile` 与 `docker-compose.yml`）：
```bash
git clone https://github.com/zgy-beep/st-auto-sync.git
cd st-auto-sync/hub-server
docker compose up -d --build
```
数据默认落在 `hub-server/data/`，`docker compose down` 不会删除数据。

也可以自建一份 `docker-compose.yml`，**关键是构建本仓库的 `hub-server` 目录**：

```yaml
services:
  st-sync-hub:
    build: ./hub-server
    container_name: st-sync-hub
    restart: unless-stopped
    ports:
      - "8765:8765"
    environment:
      - PORT=8765
      - DATA_DIR=/app/data
    volumes:
      - ./data:/app/data
```

> ⚠️ 请不要用 `image: node:20-alpine` + 内联 `node -e` 脚本的方式启动：那样只会跑起一个空的 HTTP/WS 壳，`/api/manifest`、`/api/files/*`、`/api/oplog`、`/api/devices` 等真实路由都不存在，插件连上也同步不了。

#### 方式 B：用 Node.js 直接运行
```bash
cd hub-server
npm install
npm start
# 服务将在 8765 端口启动
```
> 💡 **提示**：如果是在云服务器上运行，请在云后台的安全组/防火墙中放行 `8765` 端口。

> 🔒 **公网部署建议**：插件会根据中继地址的协议自动选用 `ws://` 或 `wss://`（地址填 `https://` 就走 `wss://`），所以公网环境建议前面挂一层反向代理上 HTTPS，避免 Token 和聊天数据明文裸奔。以 Caddy 为例：
> ```caddyfile
> hub.example.com {
>     reverse_proxy 127.0.0.1:8765
> }
> ```
> Caddy 会自动签发证书并透传 WebSocket 升级，无需额外配置；此时插件里的中继地址填 `https://hub.example.com`。

---

### 第二步：安装酒馆插件

> ⚠️ **要装两个地方**：SillyTavern 的「服务端插件」机制只负责注册 `/api/plugins/<id>/...` 接口，**不会**把插件里的 `public/` 前端资源注入到页面。所以前端面板必须同时作为「第三方扩展」放一份，否则拼图面板里看不到这个插件。

**方式一（推荐）：一条命令装好两半**

```bash
git clone https://github.com/zgy-beep/st-auto-sync.git
cd st-auto-sync
bash install.sh /path/to/SillyTavern      # 不填路径则用当前目录
```
脚本会：装服务端 → `plugins/st-auto-sync/` + `npm install`；装前端 → `public/scripts/extensions/third-party/st-auto-sync/`。重复执行即为更新，不会动酒馆数据。

**方式二：在酒馆界面里从 URL 安装前端**

拼接图图标 → 扩展面板 → **Install extension**，填：
```text
https://github.com/zgy-beep/st-auto-sync
```
仓库根目录带 `manifest.json`，SillyTavern 可以直接识别并加载（`js` 指向 `st-plugin/public/index.js`）。
但**服务端那一半界面里装不了**（ST 的安装功能只管第三方扩展），仍要执行 `bash install.sh` 或手动复制。

**方式三：完全手动**

在需要同步的每台设备（电脑、笔记本、手机 Termux）上：

**① 服务端部分（提供 API 接口）**

1. 进入你的 SillyTavern 安装目录下的 `plugins/` 文件夹；
2. 把本仓库的 `st-plugin/` 复制进去并重命名为 `st-auto-sync`；
3. 进入该目录装一次依赖：
   ```bash
   cd plugins/st-auto-sync
   npm install
   ```

**② 前端部分（提供设置面板）**

4. 把 `st-plugin/` 里的 `manifest.json` 和 `public/` 复制到第三方扩展目录：
   ```bash
   cd <SillyTavern 根目录>
   mkdir -p public/scripts/extensions/third-party/st-auto-sync
   cp -r plugins/st-auto-sync/manifest.json plugins/st-auto-sync/public \
         public/scripts/extensions/third-party/st-auto-sync/
   ```

装完后目录结构应该是这样：

```text
SillyTavern/
├── plugins/
│   └── st-auto-sync/            ← 服务端：server/ + public/ + manifest.json（已 npm install）
└── public/scripts/extensions/third-party/
    └── st-auto-sync/            ← 前端：manifest.json + public/index.js + public/style.css
```

5. 像平时一样（重新）启动 SillyTavern。启动日志里应出现：
   ```text
   Initializing plugin from .../plugins/st-auto-sync/server/index.js
   [ST-Auto-Sync] Initializing server plugin...
   [ST-Auto-Sync] Plugin server routes registered successfully.
   ```
   如果看到 `Failed to load plugin module; plugin info not found`，说明服务端模块缺少 `info` 导出（SillyTavern 1.15+ 的硬性要求），本仓库已包含该导出，请确认拉的是最新代码。


---

### 第三步：在酒馆界面中开启同步

1. 打开 SillyTavern 网页，点击右上角 **扩展面板（拼图图标 🧩）**；
2. 展开 **SillyTavern 多端自动同步** 设置页：
   * **中继服务地址**：填入你的服务器公网地址，例如 `http://你的服务器IP:8765`（如果在家里局域网可用 `http://192.168.x.x:8765`）；
   * **同步秘钥 (Token)**：自己随意设置一个密码（**所有设备填写相同的密码即可互通**）；
   * **设备名称**：给当前设备起个名字（例如“我的台式机”、“小米手机”）；
   * **选择同步模式**：
     * ⚡ **实时模式**：手机和电脑同时开着互通，打字即刻同步；
     * ⏱️ **定时模式**：手机后台省电省流量，每隔 10 分钟自动同步一次；
   * **同步内容勾选**：默认已勾选聊天记录、角色卡、世界书、预设（建议不要勾选全局设置，避免手机和电脑不同的屏幕主题打架）。
3. 点击 **【💾 保存并应用配置】**。

此时，酒馆顶部栏会出现一个状态指示灯：
* 🟢 **绿灯**：实时连接成功，双端已打通！
* 🟡 **黄灯**：定时同步模式运行中。
* 🔵 **蓝灯闪烁**：正在同步文件。

---

## 💡 使用小技巧

1. **同屏实时聊天的爽快感**：
   * 电脑开着酒馆，手机也开着酒馆；在电脑发一句，手机屏幕上几毫秒内就会弹出提示并显示出新消息！
2. **手机 Termux 息屏唤醒**：
   * 手机锁屏或切换应用后再打开酒馆，插件会自动感应并重新连上服务器，把刚才在电脑上聊的最新几句话自动补齐。
3. **两端同时聊了不同话题怎么办？**
   * 插件内置了因果保护机制：如果手机和电脑在断网期间分别跟同一个角色聊了完全不同的两套故事，联网后系统会**自动将另一端的分支无损另存为新聊天文件**（例如 `角色名 (冲突分支-来自手机).jsonl`），两套精彩剧情都会完好保留，你随时可以在聊天记录列表中切换！

---

## ❓ 常见问题 (FAQ)

**Q：在新手机/新设备刚装好酒馆，还需要重新配 API、反代和预设吗？**
> **A**：**完全不需要！** 插件默认开启【开箱即聊环境同步】。只要在新设备上安装插件并填上相同的服务地址和 Token，电脑上的 **API 密钥 (secrets.json)、反代接口、所选模型、生成参数、提示词预设与人设全部自动对齐**。安装好后直接点开角色就能开始聊天！同时它会自动保留两台设备各自独立的 UI 主题与字号，手机和电脑排版各用各的，互不冲突。

**Q：没有公网服务器，只有家里局域网/NAS 可以用吗？**
> **A**：完全可以！只要把 Hub 部署在家里常开的电脑或 NAS 上，手机和电脑连接同一个家里 WiFi，服务地址填 `http://局域网IP:8765` 即可畅享极速内网同步。

**Q：多个角色、几百张角色卡同步会卡顿吗？**
> **A**：不会！插件采用差异哈希比对技术，只有新下载或编辑过的卡片才会传输，没有改动的卡片 0 流量 0 耗时跳过。

**Q：我的数据安全吗？别人能看到我的聊天吗？**
> **A**：数据完全存放在你自己的服务器/NAS 磁盘上，不经过任何第三方服务器。不同用户的 Token 会在底层进行严格的数据物理隔离，只要保管好你自己的专属 Token，其他人绝对无法访问你的数据。

---

## 📄 开源许可

本项目基于 [MIT License](LICENSE) 开源，欢迎提交 Issue 和 PR 交流改进！
