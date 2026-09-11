/**
 * ST-Auto-Sync 根目录插件加载代理入口
 * 
 * 当用户直接在 SillyTavern/plugins/ 目录下 git clone 本仓库，
 * 或在酒馆网页端通过「Install from URL」安装本仓库时，
 * 该入口可确保 SillyTavern 插件加载器（ST 1.15+）直接识别并正常加载服务端模块。
 */

module.exports = require('./st-plugin/server/index.js');
