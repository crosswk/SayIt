# 贡献指南

感谢你对 SayIt 的关注！

## 关于 PR

**本项目暂不接受 Pull Request。**

整个项目都是使用 AI（Claude Opus 4.6）开发的，PR 现在大概率也是 AI 写的，这种场景很难 review。

## 欢迎提交 Issue

我非常欢迎以下类型的 Issue：

- 🐛 **Bug 报告** — 描述问题、复现步骤、期望行为
- 💡 **功能建议** — 你希望 SayIt 增加什么功能
- 📝 **使用反馈** — 哪里体验不好、哪里不够直观

提交 Issue 时请尽量包含：
- 操作系统版本
- SayIt 版本号（在「关于」页面查看）
- 使用的模式（服务器 / 云 API / 本地）
- 问题的具体描述和复现步骤

## 本地开发

如果你想在本地跑起来看看：

### 客户端

```bash
cd client
npm install
npm run tauri dev
```

前置要求：Node.js 18+、Rust 1.75+

### 服务端

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend && uvicorn app.main:app --port 8000
```

前置要求：Python 3.10+、NVIDIA GPU + CUDA

## 代码规范

- TypeScript strict 模式
- ESLint + Prettier 自动格式化
- UI 文本使用中文

## 提交规范

使用语义化提交信息：

- `feat:` 新功能
- `fix:` 修复 bug
- `refactor:` 重构
- `chore:` 构建/工具/依赖变更
- `docs:` 文档更新
- `perf:` 性能优化

