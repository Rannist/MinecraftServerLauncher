# Minecraft 图形化开服器

适用于 Windows 的现代化深色 Minecraft Java 版服务端启动器。支持管理多个服务器，并可从 Vanilla、Paper、Purpur、Fabric 官网直接选择版本下载核心。

## 使用方法

1. 准备好 Minecraft 服务端 JAR 和与其版本匹配的 Java。
2. 打开 `Minecraft开服器` 文件夹，双击其中的 `Minecraft开服器.exe`，选择服务端目录和 JAR。
3. 设置最小、最大内存，点击“启动服务器”。
4. 首次启动时阅读并确认 Minecraft EULA。
5. 在下方控制台查看日志或发送命令，结束时点击“停止服务器”。

左侧“我的服务器”可新增、重命名、删除配置并切换服务器。“下载服务器核心”会从项目官方接口读取版本，并在 `Serverlist` 下创建独立服务器目录，完成后自动选中对应 JAR。启动时也会扫描 `Serverlist`：未登记且只有一个顶层 JAR 的服务器文件夹会自动导入，也可点击服务器列表旁的扫描按钮手动刷新。

## 发布更新

项目使用 GitHub Release 自动更新。修改代码后先更新 `package.json` 的版本号并推送源码，然后创建并推送同版本标签，例如：

```powershell
git tag v1.2.4
git push origin v1.2.4
```

`.github/workflows/release.yml` 会自动检查代码、构建 Windows 安装程序，并把安装包、blockmap 和 `latest.yml` 发布到 GitHub Release。标签版本必须与 `package.json` 完全一致。已安装的软件会定期检查公开 Release，新版本下载完成后提示重启安装；服务器运行期间不会执行更新。

## 开发命令

```powershell
npm install
npm start
npm run check
npm run folder
npm run installer
```

构建后的完整程序文件夹位于 `dist/win-unpacked/`，安装程序和更新元数据位于 `dist/`。
