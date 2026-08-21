const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let serverProcess = null;
let stopTimer = null;
let completionBridgeReady = false;
let completionRequestNumber = 0;
let downloadedUpdateVersion = '';
const pendingCompletions = new Map();

const configDirectory = () => app.isPackaged ? path.dirname(process.execPath) : __dirname;
const configPath = () => path.join(configDirectory(), 'launcher-config.json');
const defaultServerRoot = () => path.join(configDirectory(), 'Serverlist');
const USER_AGENT = 'MinecraftServerLauncher/1.1 (local desktop application)';
const CORE_CATALOG = Object.freeze({
  vanilla: { id: 'vanilla', name: 'Vanilla', description: 'Mojang 官方原版服务端', website: 'https://www.minecraft.net/zh-hans/download/server', color: '#6db45b' },
  paper: { id: 'paper', name: 'Paper', description: '高性能、插件兼容性优秀', website: 'https://papermc.io/software/paper', color: '#4e9ee8' },
  purpur: { id: 'purpur', name: 'Purpur', description: '基于 Paper，提供丰富配置', website: 'https://purpurmc.org/download/purpur', color: '#b77aff' },
  fabric: { id: 'fabric', name: 'Fabric', description: '轻量级模组服务端加载器', website: 'https://fabricmc.net/use/server/', color: '#d5b98c' }
});
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'fill.papermc.io', 'fill-data.papermc.io', 'api.purpurmc.org', 'meta.fabricmc.net',
  'piston-meta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com', 'libraries.minecraft.net', 'maven.fabricmc.net'
]);
const SERVER_PROPERTY_DEFAULTS = Object.freeze({
  motd: 'A Minecraft Server',
  'server-port': '25565',
  'max-players': '20',
  gamemode: 'survival',
  difficulty: 'easy',
  'online-mode': 'true',
  pvp: 'true',
  'white-list': 'false',
  'allow-flight': 'false',
  'view-distance': '10',
  'simulation-distance': '10',
  'spawn-protection': '16',
  'enable-command-block': 'false',
  hardcore: 'false',
  'level-name': 'world'
});

function defaultServer(id = 'server-1', name = '我的服务器') {
  return { id, name, isolationRoot: '', serverDirectory: '', jarPath: '', coreType: '', minMemory: 2048, maxMemory: 4096, extraArgs: '' };
}

function inferCoreType(jarPath, configured = '') {
  if (CORE_CATALOG[configured]) return configured;
  const filename = path.basename(String(jarPath || '')).toLowerCase();
  return ['paper', 'purpur', 'fabric', 'vanilla'].find((core) => filename.includes(core)) || '';
}

function cleanServer(server, index) {
  const minMemory = Number(server?.minMemory);
  const maxMemory = Number(server?.maxMemory);
  return {
    id: typeof server?.id === 'string' && server.id ? server.id.slice(0, 80) : `server-${index + 1}`,
    name: typeof server?.name === 'string' && server.name.trim() ? server.name.trim().slice(0, 40) : `服务器 ${index + 1}`,
    isolationRoot: typeof server?.isolationRoot === 'string' ? server.isolationRoot.slice(0, 1000) : '',
    serverDirectory: typeof server?.serverDirectory === 'string' ? server.serverDirectory.slice(0, 1000) : '',
    jarPath: typeof server?.jarPath === 'string' ? server.jarPath.slice(0, 1000) : '',
    coreType: inferCoreType(server?.jarPath, server?.coreType),
    minMemory: Number.isInteger(minMemory) && minMemory >= 256 && minMemory <= 131072 ? minMemory : 2048,
    maxMemory: Number.isInteger(maxMemory) && maxMemory >= Math.max(256, minMemory) && maxMemory <= 131072 ? maxMemory : 4096,
    extraArgs: typeof server?.extraArgs === 'string' ? server.extraArgs.slice(0, 2000) : ''
  };
}

function normalizeConfig(raw) {
  if (Array.isArray(raw?.servers) && raw.servers.length) {
    const servers = raw.servers.slice(0, 50).map(cleanServer);
    const selectedServerId = servers.some((server) => server.id === raw.selectedServerId) ? raw.selectedServerId : servers[0].id;
    return { selectedServerId, servers };
  }
  if (raw && typeof raw === 'object' && ('jarPath' in raw || 'serverDirectory' in raw)) {
    const server = cleanServer({ ...raw, id: 'server-1', name: '我的服务器' }, 0);
    return { selectedServerId: server.id, servers: [server] };
  }
  const server = defaultServer();
  return { selectedServerId: server.id, servers: [server] };
}

function repairMissingJarPaths(config) {
  let repaired = false;
  for (const server of config.servers) {
    if (server.jarPath && fs.existsSync(server.jarPath)) continue;
    if (!server.serverDirectory || !fs.existsSync(server.serverDirectory) || !fs.statSync(server.serverDirectory).isDirectory()) continue;
    const topLevelJars = fs.readdirSync(server.serverDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.jar')
      .map((entry) => path.join(server.serverDirectory, entry.name));
    if (topLevelJars.length !== 1) continue;
    server.jarPath = topLevelJars[0];
    server.coreType = inferCoreType(server.jarPath, server.coreType);
    repaired = true;
  }
  return repaired;
}

function assertOfficialUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) throw new Error('下载地址不是受信任的官方地址。');
  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(assertOfficialUrl(url), { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`官方接口返回 HTTP ${response.status}`);
  return response.json();
}

function flattenPaperVersions(groups) {
  return Object.values(groups || {}).flat().filter((version) => !/pre|rc|snapshot/i.test(version));
}

async function getCoreVersions(coreId) {
  if (coreId === 'paper') {
    const data = await fetchJson('https://fill.papermc.io/v3/projects/paper');
    return flattenPaperVersions(data.versions);
  }
  if (coreId === 'purpur') {
    const data = await fetchJson('https://api.purpurmc.org/v2/purpur');
    return [...data.versions].reverse();
  }
  if (coreId === 'fabric') {
    const data = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
    return data.filter((item) => item.stable).map((item) => item.version);
  }
  if (coreId === 'vanilla') {
    const data = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    return data.versions.filter((item) => item.type === 'release').map((item) => item.id);
  }
  throw new Error('不支持的服务器核心。');
}

async function resolveCoreDownload(coreId, version) {
  if (!CORE_CATALOG[coreId] || typeof version !== 'string' || !/^[0-9A-Za-z._+-]+$/.test(version)) throw new Error('核心或版本无效。');
  if (coreId === 'paper') {
    const builds = await fetchJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`);
    const build = builds.find((item) => item.channel === 'STABLE') || builds[0];
    const download = build?.downloads?.['server:default'];
    if (!download?.url) throw new Error('该版本暂无可下载的稳定构建。');
    return { url: assertOfficialUrl(download.url), filename: download.name || `paper-${version}.jar` };
  }
  if (coreId === 'purpur') {
    return { url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/latest/download`, filename: `purpur-${version}.jar` };
  }
  if (coreId === 'fabric') {
    const [loaders, installers] = await Promise.all([
      fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`),
      fetchJson('https://meta.fabricmc.net/v2/versions/installer')
    ]);
    const loader = loaders.find((item) => item.loader?.stable) || loaders[0];
    const installer = installers.find((item) => item.stable) || installers[0];
    if (!loader?.loader?.version || !installer?.version) throw new Error('Fabric 暂无兼容的 Loader 或 Installer。');
    const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader.loader.version)}/${encodeURIComponent(installer.version)}/server/jar`;
    return { url, filename: `fabric-server-${version}.jar` };
  }
  const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const versionEntry = manifest.versions.find((item) => item.id === version && item.type === 'release');
  if (!versionEntry) throw new Error('找不到该 Vanilla 版本。');
  const versionData = await fetchJson(versionEntry.url);
  if (!versionData.downloads?.server?.url) throw new Error('该版本没有官方服务端 JAR。');
  return { url: assertOfficialUrl(versionData.downloads.server.url), filename: `vanilla-${version}.jar` };
}

async function downloadFile(url, targetPath) {
  const response = await fetch(assertOfficialUrl(url), { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  assertOfficialUrl(response.url);
  const total = Number(response.headers.get('content-length')) || 0;
  const temporaryPath = `${targetPath}.download`;
  const output = fs.createWriteStream(temporaryPath);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
      received += chunk.length;
      mainWindow?.webContents.send('download-progress', { received, total, percent: total ? Math.round(received / total * 100) : null });
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    output.destroy();
    try { fs.unlinkSync(temporaryPath); } catch { /* ignore partial cleanup failure */ }
    throw error;
  }
}

function uniqueDownloadPath(directory, filename) {
  const extension = path.extname(filename);
  const base = path.basename(filename, extension);
  let candidate = path.join(directory, filename);
  let suffix = 2;
  while (fs.existsSync(candidate)) candidate = path.join(directory, `${base}-${suffix++}${extension}`);
  return candidate;
}

function safeDirectoryName(value, fallback) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 80);
  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned)) return fallback;
  return cleaned;
}

function isolatedServerDirectory(rootDirectory, coreId, version) {
  const root = path.resolve(rootDirectory);
  const coreFolder = safeDirectoryName(`${CORE_CATALOG[coreId].name}-${version}`, '服务器核心');
  const baseTarget = path.resolve(root, coreFolder);
  const relative = path.relative(root, baseTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('无法创建安全的版本隔离目录。');
  let target = baseTarget;
  let suffix = 2;
  while (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    target = path.resolve(root, `${coreFolder}-${suffix++}`);
  }
  return target;
}

function serverPropertiesPath(directory) {
  if (typeof directory !== 'string' || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error('请先选择有效的服务器运行目录。');
  return path.join(path.resolve(directory), 'server.properties');
}

function serverPluginsPath(directory) {
  if (typeof directory !== 'string' || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error('请先选择有效的服务器运行目录。');
  return path.join(path.resolve(directory), 'plugins');
}

function parseServerProperties(content) {
  const values = { ...SERVER_PROPERTY_DEFAULTS };
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (Object.hasOwn(SERVER_PROPERTY_DEFAULTS, key)) values[key] = line.slice(separator + 1).trim();
  }
  return values;
}

function cleanServerProperties(input) {
  const booleanValue = (key) => input?.[key] === true || input?.[key] === 'true' ? 'true' : 'false';
  const integerValue = (key, min, max) => {
    const value = Number(input?.[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min} 到 ${max} 之间的整数。`);
    return String(value);
  };
  const enumValue = (key, allowed) => allowed.includes(input?.[key]) ? input[key] : SERVER_PROPERTY_DEFAULTS[key];
  const textValue = (key, maxLength) => String(input?.[key] ?? SERVER_PROPERTY_DEFAULTS[key]).replace(/[\r\n]/g, ' ').trim().slice(0, maxLength) || SERVER_PROPERTY_DEFAULTS[key];
  return {
    motd: textValue('motd', 200),
    'server-port': integerValue('server-port', 1, 65535),
    'max-players': integerValue('max-players', 1, 10000),
    gamemode: enumValue('gamemode', ['survival', 'creative', 'adventure', 'spectator']),
    difficulty: enumValue('difficulty', ['peaceful', 'easy', 'normal', 'hard']),
    'online-mode': booleanValue('online-mode'),
    pvp: booleanValue('pvp'),
    'white-list': booleanValue('white-list'),
    'allow-flight': booleanValue('allow-flight'),
    'view-distance': integerValue('view-distance', 2, 32),
    'simulation-distance': integerValue('simulation-distance', 2, 32),
    'spawn-protection': integerValue('spawn-protection', 0, 10000),
    'enable-command-block': booleanValue('enable-command-block'),
    hardcore: booleanValue('hardcore'),
    'level-name': textValue('level-name', 100).replace(/[\\/:*?"<>|]/g, '-')
  };
}

function mergeServerProperties(content, values) {
  const seen = new Set();
  const lines = content ? content.split(/\r?\n/) : ['#Minecraft server properties', '#Edited with Minecraft Server Launcher'];
  const merged = lines.map((line) => {
    const separator = line.indexOf('=');
    if (separator < 0) return line;
    const key = line.slice(0, separator).trim();
    if (!Object.hasOwn(values, key)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) merged.push(`${key}=${value}`);
  return `${merged.join('\r\n').replace(/(?:\r?\n)*$/, '')}\r\n`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 790,
    minWidth: 860,
    minHeight: 580,
    frame: false,
    resizable: true,
    maximizable: true,
    thickFrame: true,
    transparent: false,
    backgroundColor: '#090d15',
    show: false,
    title: 'Minecraft Server Launcher',
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  }, 1500).unref();
  mainWindow.on('close', (event) => {
    if (!serverProcess) return;
    event.preventDefault();
    mainWindow.webContents.send('close-requested');
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendUpdateStatus(state, details = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', { state, ...details });
}

function formatUpdateError(error) {
  const message = String(error?.message || '未知更新错误');
  if (/Cannot find latest\.yml|latest\.yml[\s\S]*404/i.test(message)) {
    return 'GitHub 最新 Release 缺少自动更新文件 latest.yml。';
  }
  if (/404|Not Found/i.test(message)) return 'GitHub Release 或更新文件不存在。';
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|net::ERR_INTERNET_DISCONNECTED/i.test(message)) return '当前无法连接 GitHub，请检查网络。';
  return message.split(/\r?\n/, 1)[0].slice(0, 240);
}

function setupAutoUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
  autoUpdater.on('update-not-available', (info) => sendUpdateStatus('not-available', { version: info.version }));
  autoUpdater.on('download-progress', (progress) => sendUpdateStatus('progress', {
    percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
    transferred: progress.transferred,
    total: progress.total
  }));
  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateVersion = info.version;
    sendUpdateStatus('downloaded', { version: info.version });
  });
  autoUpdater.on('error', (error) => sendUpdateStatus('error', { message: formatUpdateError(error) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 4000);
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

function emitConsole(text, kind = 'normal') {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server-output', { text, kind });
}

function isTerminalDecorationLine(line) {
  const visible = line
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return visible === '' || visible === '>';
}

function bindOutput(stream, kind) {
  const lines = readline.createInterface({ input: stream });
  lines.on('line', (line) => {
    if (line.includes('@@MSL-BRIDGE-READY@@')) {
      completionBridgeReady = true;
      return;
    }
    const marker = line.indexOf('@@MSL-COMPLETE@@');
    if (marker >= 0) {
      const payload = line.slice(marker + '@@MSL-COMPLETE@@'.length);
      const separator = payload.indexOf('@@');
      if (separator >= 0) {
        const requestId = payload.slice(0, separator);
        const pending = pendingCompletions.get(requestId);
        if (pending) {
          const suggestions = payload.slice(separator + 2).split(',').filter(Boolean).map((item) => Buffer.from(item, 'base64url').toString('utf8'));
          clearTimeout(pending.timer);
          pendingCompletions.delete(requestId);
          pending.resolve({ ok: true, suggestions });
        }
      }
      return;
    }
    if (isTerminalDecorationLine(line)) return;
    emitConsole(line, kind);
  });
}

function completionBridgeSource() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'completion', 'LauncherCompletionBridge.jar')
    : path.join(__dirname, 'outputs', 'jars', 'LauncherCompletionBridge.jar');
}

function installCompletionBridge(options) {
  const coreType = inferCoreType(options.jarPath, options.coreType);
  if (!['paper', 'purpur'].includes(coreType)) return false;
  const source = completionBridgeSource();
  if (!fs.existsSync(source)) throw new Error('实时命令补全组件缺失，请重新生成开服器程序。');
  const pluginsDirectory = path.join(path.resolve(options.serverDirectory), 'plugins');
  const target = path.join(pluginsDirectory, 'LauncherCompletionBridge.jar');
  fs.mkdirSync(pluginsDirectory, { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function clearPendingCompletions() {
  for (const pending of pendingCompletions.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, suggestions: [] });
  }
  pendingCompletions.clear();
  completionBridgeReady = false;
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') return '启动参数无效。';
  if (typeof options.jarPath !== 'string' || !fs.existsSync(options.jarPath) || path.extname(options.jarPath).toLowerCase() !== '.jar') return '请选择有效的服务端 JAR。';
  if (typeof options.serverDirectory !== 'string' || !fs.existsSync(options.serverDirectory) || !fs.statSync(options.serverDirectory).isDirectory()) return '请选择有效的运行目录。';
  if (!Number.isInteger(options.minMemory) || !Number.isInteger(options.maxMemory) || options.minMemory < 256 || options.maxMemory < options.minMemory || options.maxMemory > 131072) return '内存设置无效。';
  if (typeof options.extraArgs !== 'string' || options.extraArgs.length > 2000) return '额外参数无效。';
  if (options.coreType && !CORE_CATALOG[options.coreType]) return '服务器核心类型无效。';
  return null;
}

function splitArguments(input) {
  return (input.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((item) => item.replace(/^"|"$/g, ''));
}

ipcMain.handle('window-action', (_, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'toggle-maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  if (action === 'close') mainWindow.close();
});

ipcMain.handle('force-close-window', () => {
  if (!mainWindow) return;
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  mainWindow.destroy();
});

ipcMain.handle('select-jar', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择 Minecraft 服务端 JAR', properties: ['openFile'], filters: [{ name: 'Java 归档文件', extensions: ['jar'] }] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-directory', async (_, purpose) => {
  const title = purpose === 'isolation-root' ? '选择版本隔离保存位置' : '选择 Minecraft 服务端运行目录';
  const result = await dialog.showOpenDialog(mainWindow, { title, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('load-config', () => {
  try {
    const config = normalizeConfig(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
    if (repairMissingJarPaths(config)) fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
    return config;
  }
  catch { return normalizeConfig(null); }
});

ipcMain.handle('save-config', (_, config) => {
  if (!config || typeof config !== 'object' || !Array.isArray(config.servers) || !config.servers.length) return false;
  const cleanConfig = normalizeConfig(config);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cleanConfig, null, 2), 'utf8');
  return true;
});

ipcMain.handle('get-core-catalog', () => Object.values(CORE_CATALOG));

ipcMain.handle('get-default-server-root', () => {
  try {
    const directory = defaultServerRoot();
    fs.mkdirSync(directory, { recursive: true });
    return { ok: true, path: directory };
  } catch (error) {
    return { ok: false, error: `无法创建默认 Serverlist 文件夹：${error.message}` };
  }
});

ipcMain.handle('scan-default-server-root', (_, knownDirectories = []) => {
  try {
    const rootDirectory = defaultServerRoot();
    fs.mkdirSync(rootDirectory, { recursive: true });
    const known = new Set((Array.isArray(knownDirectories) ? knownDirectories : [])
      .filter((directory) => typeof directory === 'string' && directory)
      .map((directory) => path.resolve(directory).toLowerCase()));
    const servers = [];
    const ambiguous = [];
    const directories = fs.readdirSync(rootDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, 200);
    for (const entry of directories) {
      const serverDirectory = path.join(rootDirectory, entry.name);
      if (known.has(path.resolve(serverDirectory).toLowerCase())) continue;
      let jars;
      try {
        jars = fs.readdirSync(serverDirectory, { withFileTypes: true })
          .filter((file) => file.isFile() && file.name.toLowerCase().endsWith('.jar') && !file.name.toLowerCase().endsWith('.part.jar'))
          .map((file) => file.name);
      } catch { continue; }
      if (jars.length === 1) {
        const jarPath = path.join(serverDirectory, jars[0]);
        servers.push({ name: entry.name, serverDirectory, jarPath, coreType: inferCoreType(jarPath) });
      } else if (jars.length > 1) {
        ambiguous.push({ name: entry.name, serverDirectory, jarCount: jars.length });
      }
    }
    return { ok: true, rootDirectory, servers, ambiguous };
  } catch (error) {
    return { ok: false, error: `扫描 Serverlist 失败：${error.message}` };
  }
});

ipcMain.handle('get-core-versions', async (_, coreId) => {
  try { return { ok: true, versions: await getCoreVersions(coreId) }; }
  catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle('open-core-website', (_, coreId) => {
  const core = CORE_CATALOG[coreId];
  if (!core) return false;
  shell.openExternal(core.website);
  return true;
});

ipcMain.handle('download-core', async (_, request) => {
  try {
    const { coreId, version, rootDirectory } = request || {};
    if (!CORE_CATALOG[coreId]) throw new Error('请选择服务器核心。');
    if (typeof rootDirectory !== 'string' || !fs.existsSync(rootDirectory) || !fs.statSync(rootDirectory).isDirectory()) throw new Error('请选择有效的版本隔离保存位置。');
    const download = await resolveCoreDownload(coreId, version);
    const serverDirectory = isolatedServerDirectory(rootDirectory, coreId, version);
    fs.mkdirSync(serverDirectory, { recursive: true });
    const safeFilename = path.basename(download.filename).replace(/[^0-9A-Za-z._+-]/g, '-');
    const targetPath = uniqueDownloadPath(serverDirectory, safeFilename);
    await downloadFile(download.url, targetPath);
    return { ok: true, path: targetPath, filename: path.basename(targetPath), serverDirectory, serverName: path.basename(serverDirectory), isolationRoot: path.resolve(rootDirectory), coreType: coreId };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('detect-java', () => new Promise((resolve) => {
  execFile('java', ['-version'], { windowsHide: true }, (error, _stdout, stderr) => {
    if (error) return resolve({ available: false, version: '未检测到 Java' });
    const firstLine = stderr.split(/\r?\n/)[0].replace(/^java version /, 'Java ').replaceAll('"', '');
    resolve({ available: true, version: firstLine || 'Java 可用' });
  });
}));

ipcMain.handle('check-eula', (_, directory) => {
  if (typeof directory !== 'string' || !fs.existsSync(directory)) return false;
  try { return fs.readFileSync(path.join(directory, 'eula.txt'), 'utf8').split(/\r?\n/).some((line) => line.trim().toLowerCase() === 'eula=true'); }
  catch { return false; }
});

ipcMain.handle('accept-eula', (_, directory) => {
  if (typeof directory !== 'string' || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return false;
  fs.writeFileSync(path.join(directory, 'eula.txt'), '# Accepted through Minecraft Server Launcher\r\neula=true\r\n', 'utf8');
  return true;
});

ipcMain.handle('read-server-properties', (_, directory) => {
  try {
    const filePath = serverPropertiesPath(directory);
    const exists = fs.existsSync(filePath);
    const content = exists ? fs.readFileSync(filePath, 'utf8') : '';
    return { ok: true, exists, path: filePath, values: parseServerProperties(content) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('write-server-properties', (_, directory, values) => {
  try {
    if (serverProcess) throw new Error('请先停止服务器，再修改 server.properties。');
    const filePath = serverPropertiesPath(directory);
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    fs.writeFileSync(filePath, mergeServerProperties(content, cleanServerProperties(values)), 'utf8');
    return { ok: true, path: filePath, values: parseServerProperties(fs.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('list-server-plugins', (_, directory) => {
  try {
    const pluginsDirectory = serverPluginsPath(directory);
    if (!fs.existsSync(pluginsDirectory)) return { ok: true, path: pluginsDirectory, plugins: [] };
    const plugins = fs.readdirSync(pluginsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
      .map((entry) => {
        const filePath = path.join(pluginsDirectory, entry.name);
        const stats = fs.statSync(filePath);
        return { name: entry.name, size: stats.size, modifiedAt: stats.mtime.toISOString() };
      })
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { sensitivity: 'base' }));
    return { ok: true, path: pluginsDirectory, plugins };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('open-plugins-directory', async (_, directory) => {
  try {
    const pluginsDirectory = serverPluginsPath(directory);
    fs.mkdirSync(pluginsDirectory, { recursive: true });
    const error = await shell.openPath(pluginsDirectory);
    return error ? { ok: false, error } : { ok: true, path: pluginsDirectory };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('start-server', (_, options) => {
  if (serverProcess) return { ok: false, error: '服务器已经在运行。' };
  const error = validateOptions(options);
  if (error) return { ok: false, error };
  const args = [`-Xms${options.minMemory}M`, `-Xmx${options.maxMemory}M`, ...splitArguments(options.extraArgs), '-jar', path.resolve(options.jarPath), 'nogui'];
  try {
    const bridgeInstalled = installCompletionBridge(options);
    completionBridgeReady = false;
    serverProcess = spawn('java', args, { cwd: path.resolve(options.serverDirectory), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    bindOutput(serverProcess.stdout, 'normal');
    bindOutput(serverProcess.stderr, 'error');
    serverProcess.on('error', (processError) => {
      emitConsole(`[Launcher] 启动失败：${processError.message}`, 'error');
      clearPendingCompletions();
      serverProcess = null;
      mainWindow?.webContents.send('server-state', { running: false, exitCode: null });
    });
    serverProcess.on('exit', (code) => {
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
      clearPendingCompletions();
      serverProcess = null;
      emitConsole(`[Launcher] 服务器已退出，代码 ${code ?? '未知'}`, code === 0 ? 'success' : 'error');
      mainWindow?.webContents.send('server-state', { running: false, exitCode: code });
    });
    emitConsole(`[Launcher] 正在启动 ${path.basename(options.jarPath)}`, 'accent');
    if (bridgeInstalled) emitConsole('[Launcher] 已为当前 Paper/Purpur 服务器启用实时 Tab 补全。', 'success');
    return { ok: true };
  } catch (startError) {
    serverProcess = null;
    return { ok: false, error: startError.message };
  }
});

ipcMain.handle('send-command', (_, command) => {
  if (!serverProcess || typeof command !== 'string' || command.length > 1000) return false;
  serverProcess.stdin.write(`${command.trim().replace(/^\//, '')}\n`);
  return true;
});

ipcMain.handle('complete-server-command', (_, command) => {
  if (!serverProcess || !completionBridgeReady || typeof command !== 'string' || command.length > 1000) return { ok: false, suggestions: [] };
  const normalized = command.replace(/^\//, '');
  const requestId = `${Date.now().toString(36)}-${(++completionRequestNumber).toString(36)}`;
  const encoded = Buffer.from(normalized, 'utf8').toString('base64url');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCompletions.delete(requestId);
      resolve({ ok: false, suggestions: [] });
    }, 1200);
    pendingCompletions.set(requestId, { resolve, timer });
    serverProcess.stdin.write(`mslcomplete ${requestId} ${encoded}\n`);
  });
});

ipcMain.handle('stop-server', () => {
  if (!serverProcess) return false;
  emitConsole('[Launcher] 正在安全停止服务器…', 'accent');
  serverProcess.stdin.write('stop\n');
  stopTimer = setTimeout(() => {
    if (serverProcess) mainWindow?.webContents.send('stop-timeout');
  }, 20000);
  return true;
});

ipcMain.handle('kill-server', () => {
  if (!serverProcess) return false;
  serverProcess.kill();
  return true;
});

ipcMain.handle('install-update', () => {
  if (!downloadedUpdateVersion) return { ok: false, error: '更新尚未下载完成。' };
  if (serverProcess) return { ok: false, error: '请先停止服务器，再安装更新。' };
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) return { ok: false, error: '开发模式不支持自动更新检查。' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatUpdateError(error) };
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

app.whenReady().then(() => { createWindow(); setupAutoUpdates(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
