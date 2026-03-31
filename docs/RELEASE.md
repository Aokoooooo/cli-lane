# GitHub Actions 发布流程

本项目使用 GitHub Actions 自动完成发布流程。

## 触发方式

推送一个以 `v` 开头的 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 会自动：
1. 构建所有平台的二进制文件（macOS/Linux，x64/arm64）
2. 创建 GitHub Release 并上传二进制文件
3. 发布到 npm

## 配置 Secrets

在 GitHub 仓库的 **Settings > Secrets and variables > Actions** 中添加：

### NPM_TOKEN
1. 登录 npm：`npm login`
2. 生成访问令牌：https://www.npmjs.com/settings/[username]/tokens
   - 选择 "Automation" 类型
   - 权限：Publish
3. 复制 token 并添加到 GitHub Secrets，名称为 `NPM_TOKEN`

## 手动测试发布流程

### 1. 本地构建测试
```bash
bun run build:all
ls release/
```

### 2. 发布到 npm（本地）
```bash
npm login
npm publish --access public
```

### 3. 使用 Actions 发布（推荐）
```bash
# 确保代码已提交
git add .
git commit -m "Release v0.1.0"
git push

# 创建 tag 触发 Actions
git tag v0.1.0
git push origin v0.1.0
```

然后在 GitHub 仓库的 Actions 标签页查看进度。

## 故障排除

### Actions 失败
查看 Actions 日志，常见问题：
- `NPM_TOKEN` 未设置或过期
- package.json 版本号已存在
- 缺少权限（确保 `GITHUB_TOKEN` 有写入权限）

### npm 发布失败
- 检查 npm 账号是否有发布权限
- 检查包名是否已被占用
- 检查版本号是否已存在

### 二进制文件下载失败
确保 GitHub Release 中的文件命名正确：
- `cli-lane-darwin-x64`
- `cli-lane-darwin-arm64`
- `cli-lane-linux-x64`
- `cli-lane-linux-arm64`
