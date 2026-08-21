# CLI 启动时版本检查通知

## Goal

CLI 启动时静默检查 GitHub Releases 是否有新版本，若有则向用户显示通知。
**仅检查、仅提示，不自动执行更新。**

## Background

- CLI: `pingcode-cli`，当前版本 `1.4.1`
- 发布方式: Git tag `v*` → GitHub Actions → `gh release create` + tarball
- 安装方式: git checkout → `install.sh` / `npm run install:cli`（未发布到 npm）
- 现有机制: 无任何版本检查逻辑

## Requirements

1. CLI 启动时（命令解析前）静默检查 GitHub Releases API 获取最新版本
2. 若远程版本 > 本地版本，向 stderr 输出一行提示
3. 若远程版本 <= 本地版本或检查失败，无任何输出，不影响 CLI 正常使用
4. 缓存检查结果，避免每次调用都请求网络（建议 24 小时 TTL）
5. 支持环境变量或配置禁用此功能
6. `--json` 模式下不输出文本通知
7. 检查过程不阻塞 CLI 主流程（fire-and-forget 或极短超时）

## Non-Goals

- 不自动下载或安装更新
- 不提供 `update` 子命令
- 不检查 npm registry

## Acceptance Criteria

- [ ] 启动时若 GitHub 有新版本，stderr 输出一行提示（如: `Update available: 1.4.1 → 1.5.0`）
- [ ] 无新版本时无任何额外输出
- [ ] 网络异常/超时静默失败，不影响 CLI 正常使用
- [ ] 检查结果缓存 24 小时
- [ ] `PINGCODE_NO_UPDATE_CHECK=1` 可禁用检查
- [ ] `--json` 模式下不输出文本通知
- [ ] 现有测试全部通过

## Design Notes

- GitHub Releases API: `https://api.github.com/repos/anine09/pingcode-cli-unofficial/releases/latest`
- 从 `tag_name` 提取版本号（格式 `v1.4.1`）
- 缓存文件位置: `~/.config/pingcode/update-check.json`（或 os.tmpdir() 下）
- 超时: 2 秒，超时后静默放弃
- 使用 Node 内置 `fetch`（Node 20+）无需额外依赖
