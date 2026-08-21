# Minecraft 图形化开服器

适用于 Windows 的现代化深色 Minecraft Java 版服务端启动器。支持管理多个服务器，并可从 Vanilla、Paper、Purpur、Fabric 官网直接选择版本下载核心。

## 使用方法

1. 准备好 Minecraft 服务端 JAR 和与其版本匹配的 Java。
2. 打开 `Minecraft开服器` 文件夹，双击其中的 `Minecraft开服器.exe`，选择服务端目录和 JAR。
3. 设置最小、最大内存，点击“启动服务器”。
4. 首次启动时阅读并确认 Minecraft EULA。
5. 在下方控制台查看日志或发送命令，结束时点击“停止服务器”。

左侧“我的服务器”可新增并切换服务器。右上角“下载核心”会从项目官方接口读取版本并下载到当前服务器目录，完成后自动选中对应 JAR。

## 开发命令

```powershell
npm install
npm start
npm run check
npm run folder
```

构建后的完整程序文件夹位于 `dist/win-unpacked/`，使用时必须保留文件夹内全部文件。
