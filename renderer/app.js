const $ = (selector) => document.querySelector(selector);
const fields = {
  jarPath: $('#jar-path'), serverDirectory: $('#server-directory'), minMemory: $('#min-memory'),
  maxMemory: $('#max-memory'), extraArgs: $('#extra-args')
};
const propertyFields = {
  motd: $('#property-motd'),
  'server-port': $('#property-server-port'),
  'max-players': $('#property-max-players'),
  gamemode: $('#property-gamemode'),
  difficulty: $('#property-difficulty'),
  'online-mode': $('#property-online-mode'),
  pvp: $('#property-pvp'),
  'white-list': $('#property-white-list'),
  'allow-flight': $('#property-allow-flight'),
  'view-distance': $('#property-view-distance'),
  'simulation-distance': $('#property-simulation-distance'),
  'spawn-protection': $('#property-spawn-protection'),
  'enable-command-block': $('#property-enable-command-block'),
  hardcore: $('#property-hardcore'),
  'level-name': $('#property-level-name')
};

let appConfig = { selectedServerId: '', servers: [] };
let running = false;
let startedAt = null;
let uptimeTimer = null;
let modalResolver = null;
let coreCatalog = [];
let selectedCoreId = null;
let downloading = false;
let defaultDownloadRoot = '';
let propertiesDirty = false;
let loadedPropertiesDirectory = '';
let profileMode = 'create';
let downloadedUpdateVersion = '';
let updatePromptActive = false;
let updateStatusHideTimer = null;
const COMMAND_COMPLETIONS = Object.freeze([
  'ban', 'ban-ip', 'banlist', 'clear', 'data', 'deop', 'difficulty', 'effect', 'enchant',
  'execute', 'experience', 'fill', 'forceload', 'function', 'gamemode', 'gamerule', 'give',
  'help', 'kick', 'kill', 'list', 'locate', 'loot', 'op', 'pardon', 'pardon-ip', 'paper',
  'particle', 'plugins', 'reload', 'save-all', 'save-off', 'save-on', 'say', 'schedule', 'seed',
  'setblock', 'setworldspawn', 'spark', 'spawnpoint', 'spreadplayers', 'stop', 'summon',
  'teleport', 'tellraw', 'time', 'timings', 'title', 'tp', 'version', 'weather', 'whitelist',
  'worldborder', 'xp'
]);
let commandCompletion = { query: '', matches: [], index: -1, lastValue: '' };
let completionRequest = 0;

document.querySelectorAll('[data-window]').forEach((button) => button.addEventListener('click', () => window.launcher.windowAction(button.dataset.window)));

function currentServer() {
  return appConfig.servers.find((server) => server.id === appConfig.selectedServerId) || appConfig.servers[0];
}

function getOptions() {
  const server = currentServer();
  return {
    jarPath: fields.jarPath.value.trim(), serverDirectory: fields.serverDirectory.value.trim(),
    coreType: server?.coreType || '', minMemory: Number(fields.minMemory.value),
    maxMemory: Number(fields.maxMemory.value), extraArgs: fields.extraArgs.value.trim()
  };
}

function inferCoreType(jarPath) {
  const filename = String(jarPath || '').split(/[\\/]/).pop().toLowerCase();
  return ['paper', 'purpur', 'fabric', 'vanilla'].find((core) => filename.includes(core)) || '';
}

async function saveCurrentServer() {
  const server = currentServer();
  if (!server) return false;
  Object.assign(server, getOptions());
  renderServerList();
  return window.launcher.saveConfig(appConfig);
}

function loadCurrentServer() {
  const server = currentServer();
  if (!server) return;
  for (const [key, field] of Object.entries(fields)) field.value = server[key] ?? '';
  $('#current-server-name').textContent = server.name;
  $('#start').innerHTML = `▶&nbsp; 启动 ${server.name}`;
  updateMemoryPreview();
}

function renderServerList() {
  const list = $('#server-list');
  list.innerHTML = '';
  for (const server of appConfig.servers) {
    const button = document.createElement('button');
    button.className = `server-item${server.id === appConfig.selectedServerId ? ' active' : ''}`;
    button.disabled = running;
    const avatar = document.createElement('span');
    avatar.className = 'server-avatar';
    avatar.textContent = server.name.trim().charAt(0).toUpperCase() || 'S';
    const copy = document.createElement('span');
    copy.className = 'server-copy';
    const name = document.createElement('strong');
    name.textContent = server.name;
    const detail = document.createElement('small');
    detail.textContent = server.jarPath ? server.jarPath.split(/[\\/]/).pop() : '未选择核心';
    copy.append(name, detail);
    button.append(avatar, copy);
    button.addEventListener('click', async () => {
      if (running || server.id === appConfig.selectedServerId) return;
      await saveCurrentServer();
      appConfig.selectedServerId = server.id;
      loadCurrentServer();
      renderServerList();
      await window.launcher.saveConfig(appConfig);
      $('#console').innerHTML = '';
      appendConsole(`[Launcher] 已切换到服务器：${server.name}`, 'accent');
    });
    list.appendChild(button);
  }
  $('#delete-server').disabled = running || appConfig.servers.length <= 1;
}

function showModal(title, message, { confirmText = '确认', cancelText = '取消', danger = false, singleButton = false, icon = '!' } = {}) {
  $('#modal-title').textContent = title;
  $('#modal-message').textContent = message;
  $('#modal-confirm').textContent = confirmText;
  $('#modal-cancel').textContent = cancelText;
  $('#modal-cancel').style.display = singleButton ? 'none' : '';
  $('#modal-backdrop .modal-icon').textContent = icon;
  $('#modal-confirm').className = danger ? 'danger' : 'primary';
  $('#modal-backdrop').classList.remove('hidden');
  return new Promise((resolve) => { modalResolver = resolve; });
}

function closeModal(result) {
  $('#modal-backdrop').classList.add('hidden');
  if (modalResolver) modalResolver(result);
  modalResolver = null;
}

$('#modal-confirm').addEventListener('click', () => closeModal(true));
$('#modal-cancel').addEventListener('click', () => closeModal(false));

function showUpdateStatus(text, state = '') {
  const button = $('#update-status');
  clearTimeout(updateStatusHideTimer);
  button.textContent = text;
  button.className = `update-status${state ? ` ${state}` : ''}`;
  button.disabled = state !== 'ready' || running;
}

function hideUpdateStatus(delay = 0) {
  clearTimeout(updateStatusHideTimer);
  updateStatusHideTimer = setTimeout(() => $('#update-status').classList.add('hidden'), delay);
}

async function promptDownloadedUpdate() {
  if (!downloadedUpdateVersion || running || updatePromptActive) return;
  if (document.querySelector('.modal-backdrop:not(.hidden), .overlay:not(.hidden), .drawer-backdrop:not(.hidden)')) {
    setTimeout(promptDownloadedUpdate, 1000);
    return;
  }
  updatePromptActive = true;
  const install = await showModal(
    '新版本已下载',
    `Minecraft 开服器 v${downloadedUpdateVersion} 已准备完成。\n\n是否立即关闭程序并安装更新？服务器文件和开服器配置会保留。`,
    { confirmText: '立即重启更新', cancelText: '稍后', icon: '↻' }
  );
  updatePromptActive = false;
  if (!install) return;
  const result = await window.launcher.installUpdate();
  if (!result.ok) await showModal('暂时无法更新', result.error, { confirmText: '知道了', singleButton: true });
}

$('#update-status').addEventListener('click', promptDownloadedUpdate);

function updateMemoryPreview() {
  $('#memory-min-preview').textContent = fields.minMemory.value || '—';
  $('#memory-max-preview').textContent = fields.maxMemory.value || '—';
}

function closeSettings() { $('#settings-backdrop').classList.add('hidden'); }
$('#open-settings').addEventListener('click', () => { updateMemoryPreview(); $('#settings-backdrop').classList.remove('hidden'); });
$('#close-settings').addEventListener('click', closeSettings);
$('#settings-backdrop').addEventListener('click', (event) => { if (event.target === $('#settings-backdrop')) closeSettings(); });
$('#save-settings').addEventListener('click', async () => {
  const options = getOptions();
  if (!Number.isInteger(options.minMemory) || !Number.isInteger(options.maxMemory) || options.minMemory < 256 || options.maxMemory < options.minMemory) {
    await showModal('内存设置无效', '内存必须是大于 256 MB 的整数，且最大内存不能小于最小内存。', { cancelText: '关闭' });
    return;
  }
  await saveCurrentServer();
  closeSettings();
});
[fields.minMemory, fields.maxMemory].forEach((field) => field.addEventListener('input', updateMemoryPreview));

function closeProperties() { $('#properties-backdrop').classList.add('hidden'); }
$('#open-properties').addEventListener('click', async () => {
  const directory = fields.serverDirectory.value.trim();
  if (!directory) {
    await showModal('缺少服务器目录', '请先下载服务器核心，或在主界面选择服务器运行目录。', { cancelText: '关闭' });
    return;
  }
  const result = await window.launcher.readServerProperties(directory);
  if (!result.ok) {
    await showModal('无法读取服务器配置', result.error, { cancelText: '关闭' });
    return;
  }
  for (const [key, field] of Object.entries(propertyFields)) field.value = result.values[key];
  loadedPropertiesDirectory = directory;
  propertiesDirty = false;
  $('#properties-description').textContent = result.exists
    ? '已读取当前目录的 server.properties，保存后下次启动生效。'
    : '当前目录还没有 server.properties，保存时会自动创建。';
  $('#properties-backdrop').classList.remove('hidden');
});
$('#close-properties').addEventListener('click', closeProperties);
$('#properties-backdrop').addEventListener('click', (event) => { if (event.target === $('#properties-backdrop')) closeProperties(); });
Object.values(propertyFields).forEach((field) => {
  field.addEventListener('input', () => { propertiesDirty = true; });
  field.addEventListener('change', () => { propertiesDirty = true; });
});

async function saveServerProperties({ closeAfterSave = false, showConfirmation = false } = {}) {
  const directory = fields.serverDirectory.value.trim();
  const values = Object.fromEntries(Object.entries(propertyFields).map(([key, field]) => [key, field.value]));
  const result = await window.launcher.writeServerProperties(directory, values);
  if (!result.ok) {
    await showModal('服务器配置保存失败', result.error, { cancelText: '关闭' });
    return false;
  }
  const mismatched = Object.keys(values).filter((key) => String(result.values?.[key] ?? '') !== String(values[key]));
  if (mismatched.length) {
    await showModal('服务器配置校验失败', `以下配置写入后不一致：${mismatched.join('、')}`, { cancelText: '关闭' });
    return false;
  }
  propertiesDirty = false;
  loadedPropertiesDirectory = directory;
  if (closeAfterSave) closeProperties();
  appendConsole('[Launcher] server.properties 已保存，下次启动服务器时生效。', 'success');
  if (showConfirmation) await showModal('保存成功', `server.properties 已写入并校验完成。\n\n${result.path}`, { confirmText: '确定', singleButton: true, icon: '✓' });
  return true;
}

$('#save-properties').addEventListener('click', async () => {
  await saveServerProperties({ closeAfterSave: true, showConfirmation: true });
});

function closePlugins() { $('#plugins-backdrop').classList.add('hidden'); }

function formatPluginSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderPlugins(plugins) {
  const list = $('#plugin-list');
  list.innerHTML = '';
  $('#plugin-count').textContent = `${plugins.length} 个插件`;
  if (!plugins.length) {
    const empty = document.createElement('div');
    empty.className = 'plugin-empty';
    empty.textContent = '当前 plugins 文件夹内没有插件 JAR';
    list.appendChild(empty);
    return;
  }
  for (const plugin of plugins) {
    const item = document.createElement('div');
    item.className = 'plugin-item';
    const icon = document.createElement('span');
    icon.className = 'plugin-icon';
    icon.textContent = 'P';
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = plugin.name.replace(/\.jar$/i, '');
    name.title = plugin.name;
    const detail = document.createElement('small');
    detail.textContent = `${formatPluginSize(plugin.size)} · ${new Date(plugin.modifiedAt).toLocaleString('zh-CN')}`;
    copy.append(name, detail);
    item.append(icon, copy);
    list.appendChild(item);
  }
}

$('#open-plugins').addEventListener('click', async () => {
  const directory = fields.serverDirectory.value.trim();
  if (!directory) {
    await showModal('缺少服务器目录', '请先选择服务器运行目录。', { cancelText: '关闭' });
    return;
  }
  const result = await window.launcher.listServerPlugins(directory);
  if (!result.ok) {
    await showModal('无法读取插件列表', result.error, { cancelText: '关闭' });
    return;
  }
  $('#plugins-path').textContent = result.path;
  $('#plugins-path').title = result.path;
  renderPlugins(result.plugins);
  $('#plugins-backdrop').classList.remove('hidden');
});
$('#close-plugins').addEventListener('click', closePlugins);
$('#plugins-backdrop').addEventListener('click', (event) => { if (event.target === $('#plugins-backdrop')) closePlugins(); });
$('#open-plugins-folder').addEventListener('click', async () => {
  const result = await window.launcher.openPluginsDirectory(fields.serverDirectory.value.trim());
  if (!result.ok) await showModal('无法打开插件文件夹', result.error, { cancelText: '关闭' });
});

const ANSI_COLORS = Object.freeze({
  30: 'ansi-black', 31: 'ansi-red', 32: 'ansi-green', 33: 'ansi-yellow',
  34: 'ansi-blue', 35: 'ansi-magenta', 36: 'ansi-cyan', 37: 'ansi-white',
  90: 'ansi-bright-black', 91: 'ansi-bright-red', 92: 'ansi-bright-green', 93: 'ansi-bright-yellow',
  94: 'ansi-bright-blue', 95: 'ansi-bright-magenta', 96: 'ansi-bright-cyan', 97: 'ansi-bright-white'
});

function appendAnsiConsoleText(line, text) {
  const pattern = /\x1b\[([0-9;]*)m/g;
  let index = 0;
  let match;
  let color = '';
  let bold = false;
  let hasColor = false;
  const appendSegment = (value) => {
    const cleaned = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (!cleaned) return;
    const span = document.createElement('span');
    span.textContent = cleaned;
    if (color) span.classList.add(color);
    if (bold) span.classList.add('ansi-bold');
    line.appendChild(span);
  };
  while ((match = pattern.exec(text))) {
    appendSegment(text.slice(index, match.index));
    const codes = (match[1] || '0').split(';').map(Number);
    for (const code of codes) {
      if (code === 0) { color = ''; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = '';
      else if (ANSI_COLORS[code]) { color = ANSI_COLORS[code]; hasColor = true; }
    }
    index = pattern.lastIndex;
  }
  appendSegment(text.slice(index));
  return hasColor;
}

function appendConsole(text, kind = 'normal') {
  const consoleElement = $('#console');
  const shouldFollow = consoleElement.scrollHeight - consoleElement.scrollTop - consoleElement.clientHeight < 36;
  const line = document.createElement('p');
  const hasAnsiColor = appendAnsiConsoleText(line, text);
  if (!hasAnsiColor) {
    if (kind === 'error' || /\b(?:ERROR|SEVERE|FATAL)\b/i.test(text)) line.className = 'error';
    else if (kind !== 'normal') line.className = kind;
  }
  consoleElement.appendChild(line);
  while (consoleElement.childElementCount > 3000) consoleElement.firstElementChild.remove();
  if (shouldFollow) consoleElement.scrollTop = consoleElement.scrollHeight;
}

function hideStartupProgress() {
  $('#startup-progress').classList.add('hidden');
  $('#startup-progress').classList.remove('determinate');
  $('#startup-progress-bar').style.width = '';
}

function updateStartupProgress(text) {
  const progress = $('#startup-progress');
  const download = text.match(/Downloading\s+([^\s]+\.jar)/i);
  if (download) {
    progress.classList.remove('hidden');
    $('#startup-progress-label').textContent = `正在下载服务端依赖：${download[1]}`;
    $('#startup-progress-percent').textContent = '下载中';
  }
  if (!progress.classList.contains('hidden')) {
    const percent = text.match(/(?:^|\s)(100|\d{1,2})(?:\.\d+)?%/);
    if (percent) {
      const value = Number(percent[1]);
      progress.classList.add('determinate');
      $('#startup-progress-bar').style.width = `${value}%`;
      $('#startup-progress-percent').textContent = `${value}%`;
    }
    if (/Applying patches|Starting minecraft server|Loading Minecraft|Preparing level|Done \(/i.test(text)) hideStartupProgress();
  }
}

function setRunning(value) {
  running = value;
  $('#start').disabled = value;
  $('#stop').disabled = !value;
  $('#send-command').disabled = !value;
  $('#command').disabled = !value;
  if (!value) hideCommandSuggestions();
  $('#add-server').disabled = value;
  $('#rename-server').disabled = value;
  $('#delete-server').disabled = value || appConfig.servers.length <= 1;
  $('#open-downloads').disabled = value;
  $('#open-settings').disabled = value;
  $('#open-properties').disabled = value;
  if (downloadedUpdateVersion) $('#update-status').disabled = value;
  Object.values(fields).forEach((field) => { field.disabled = value; });
  if (value) { closeSettings(); closeProperties(); }
  $('.status-pill').classList.toggle('running', value);
  $('#status-text').textContent = value ? '服务器运行中' : '服务器离线';
  renderServerList();
  if (value) {
    startedAt = Date.now();
    uptimeTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const hours = String(Math.floor(elapsed / 3600)).padStart(2, '0');
      const minutes = String(Math.floor(elapsed % 3600 / 60)).padStart(2, '0');
      const seconds = String(elapsed % 60).padStart(2, '0');
      $('#uptime').textContent = `运行时间  ${hours}:${minutes}:${seconds}`;
    }, 1000);
  } else {
    clearInterval(uptimeTimer);
    uptimeTimer = null;
    $('#uptime').textContent = '准备就绪';
    hideStartupProgress();
    promptDownloadedUpdate();
  }
}

function openProfileEditor(mode) {
  profileMode = mode;
  const renaming = mode === 'rename';
  $('#profile-icon').textContent = renaming ? '✎' : '＋';
  $('#profile-title').textContent = renaming ? '修改服务器名称' : '添加服务器';
  $('#profile-description').textContent = renaming ? '名称只用于开服器内识别，不会修改服务器目录或世界文件。' : '为新服务器配置取一个容易识别的名称';
  $('#profile-confirm').textContent = renaming ? '保存名称' : '创建服务器';
  $('#profile-name').value = renaming ? currentServer()?.name || '' : '';
  $('#profile-backdrop').classList.remove('hidden');
  setTimeout(() => { $('#profile-name').focus(); $('#profile-name').select(); }, 50);
}

$('#add-server').addEventListener('click', () => openProfileEditor('create'));
$('#rename-server').addEventListener('click', () => { if (!running && currentServer()) openProfileEditor('rename'); });
$('#delete-server').addEventListener('click', async () => {
  const server = currentServer();
  if (running || !server) return;
  if (appConfig.servers.length <= 1) {
    await showModal('无法删除服务器', '开服器至少需要保留一个服务器项。', { confirmText: '知道了', singleButton: true });
    return;
  }
  const confirmed = await showModal(
    '删除服务器',
    `确定从开服器列表删除“${server.name}”吗？\n\n服务器文件夹、世界、插件和核心都会保留。`,
    { confirmText: '从列表删除', danger: true, icon: '×' }
  );
  if (!confirmed) return;
  const index = appConfig.servers.findIndex((item) => item.id === server.id);
  appConfig.servers.splice(index, 1);
  const nextServer = appConfig.servers[Math.min(index, appConfig.servers.length - 1)];
  appConfig.selectedServerId = nextServer.id;
  propertiesDirty = false;
  loadedPropertiesDirectory = '';
  closeSettings();
  closeProperties();
  closePlugins();
  loadCurrentServer();
  renderServerList();
  await window.launcher.saveConfig(appConfig);
  $('#console').innerHTML = '';
  appendConsole(`[Launcher] 已从列表删除服务器：${server.name}`, 'success');
});
$('#profile-cancel').addEventListener('click', () => $('#profile-backdrop').classList.add('hidden'));
$('#profile-confirm').addEventListener('click', async () => {
  const name = $('#profile-name').value.trim();
  if (!name) return;
  await saveCurrentServer();
  if (profileMode === 'rename') {
    const server = currentServer();
    server.name = name.slice(0, 40);
    $('#profile-backdrop').classList.add('hidden');
    loadCurrentServer();
    renderServerList();
    await window.launcher.saveConfig(appConfig);
    appendConsole(`[Launcher] 当前服务器已重命名为：${server.name}`, 'success');
    return;
  }
  const id = `server-${crypto.randomUUID()}`;
  appConfig.servers.push({ id, name: name.slice(0, 40), isolationRoot: '', serverDirectory: '', jarPath: '', coreType: '', minMemory: 2048, maxMemory: 4096, extraArgs: '' });
  appConfig.selectedServerId = id;
  $('#profile-backdrop').classList.add('hidden');
  loadCurrentServer();
  renderServerList();
  await window.launcher.saveConfig(appConfig);
});
$('#profile-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#profile-confirm').click(); });

$('#browse-jar').addEventListener('click', async () => {
  const selected = await window.launcher.selectJar();
  if (!selected) return;
  fields.jarPath.value = selected;
  fields.serverDirectory.value = selected.replace(/[\\/][^\\/]+$/, '');
  currentServer().coreType = inferCoreType(selected);
  await saveCurrentServer();
});
$('#browse-directory').addEventListener('click', async () => {
  const selected = await window.launcher.selectDirectory();
  if (!selected) return;
  fields.serverDirectory.value = selected;
  const server = currentServer();
  if (server) server.isolationRoot = selected;
  await saveCurrentServer();
});
$('#clear-console').addEventListener('click', () => { $('#console').innerHTML = ''; });

function renderCoreCards() {
  const list = $('#core-list');
  list.innerHTML = '';
  for (const core of coreCatalog) {
    const card = document.createElement('button');
    card.className = `core-card${core.id === selectedCoreId ? ' active' : ''}`;
    card.style.setProperty('--core-color', core.color);
    const symbol = document.createElement('span');
    symbol.className = 'core-symbol';
    symbol.textContent = core.name.charAt(0);
    const name = document.createElement('strong');
    name.textContent = core.name;
    const description = document.createElement('small');
    description.textContent = core.description;
    card.append(symbol, name, description);
    card.addEventListener('click', () => selectCore(core.id));
    list.appendChild(card);
  }
}

async function selectCore(coreId) {
  selectedCoreId = coreId;
  renderCoreCards();
  $('#open-official').disabled = false;
  $('#download-core').disabled = true;
  const select = $('#core-version');
  select.innerHTML = '<option>正在读取官方版本列表…</option>';
  select.disabled = true;
  const result = await window.launcher.getCoreVersions(coreId);
  select.innerHTML = '';
  if (!result.ok || !result.versions.length) {
    const option = document.createElement('option');
    option.textContent = result.error || '暂无可用版本';
    select.appendChild(option);
    await showModal('版本列表获取失败', result.error || '官方接口没有返回可用版本。', { cancelText: '关闭' });
    return;
  }
  for (const version of result.versions) {
    const option = document.createElement('option');
    option.value = version;
    option.textContent = version;
    select.appendChild(option);
  }
  select.disabled = false;
  $('#download-core').disabled = false;
}

$('#open-downloads').addEventListener('click', async () => {
  if (!coreCatalog.length) coreCatalog = await window.launcher.getCoreCatalog();
  renderCoreCards();
  updateDownloadLocation();
  $('#downloads-backdrop').classList.remove('hidden');
  if (!selectedCoreId && coreCatalog.length) selectCore(coreCatalog[0].id);
});
$('#close-downloads').addEventListener('click', () => { if (!downloading) $('#downloads-backdrop').classList.add('hidden'); });
$('#downloads-backdrop').addEventListener('click', (event) => { if (!downloading && event.target === $('#downloads-backdrop')) $('#downloads-backdrop').classList.add('hidden'); });
$('#open-official').addEventListener('click', () => { if (selectedCoreId) window.launcher.openCoreWebsite(selectedCoreId); });

function updateDownloadLocation() {
  const directory = currentServer()?.isolationRoot || defaultDownloadRoot;
  const pathLabel = $('#download-location-path');
  pathLabel.textContent = directory || '默认位置不可用';
  pathLabel.title = directory || '';
}

$('#change-download-location').addEventListener('click', async () => {
  const selected = await window.launcher.selectDirectory('isolation-root');
  if (!selected) return;
  const server = currentServer();
  server.isolationRoot = selected;
  await window.launcher.saveConfig(appConfig);
  updateDownloadLocation();
});

$('#download-core').addEventListener('click', async () => {
  const server = currentServer();
  const version = $('#core-version').value;
  const rootDirectory = server?.isolationRoot || defaultDownloadRoot;
  if (!rootDirectory) {
    await showModal('默认位置不可用', '无法使用开服器目录内的 Serverlist 文件夹，请点击“更改位置”选择其他目录。', { cancelText: '关闭' });
    return;
  }
  downloading = true;
  $('#download-core').disabled = true;
  $('#close-downloads').disabled = true;
  $('#change-download-location').disabled = true;
  $('#download-progress').classList.remove('hidden');
  $('#download-status').textContent = `正在下载 ${selectedCoreId} ${version}…`;
  $('#download-percent').textContent = '连接中';
  $('#progress-bar').style.width = '0%';
  const result = await window.launcher.downloadCore({ coreId: selectedCoreId, version, rootDirectory });
  downloading = false;
  $('#close-downloads').disabled = false;
  $('#change-download-location').disabled = false;
  $('#download-core').disabled = false;
  if (!result.ok) {
    $('#download-status').textContent = '下载失败';
    await showModal('核心下载失败', result.error, { cancelText: '关闭' });
    return;
  }
  await saveCurrentServer();
  const newServer = {
    id: `server-${crypto.randomUUID()}`,
    name: result.serverName.slice(0, 40),
    isolationRoot: result.isolationRoot,
    serverDirectory: result.serverDirectory,
    jarPath: result.path,
    coreType: result.coreType,
    minMemory: server?.minMemory || 2048,
    maxMemory: server?.maxMemory || 4096,
    extraArgs: server?.extraArgs || ''
  };
  appConfig.servers.push(newServer);
  appConfig.selectedServerId = newServer.id;
  loadCurrentServer();
  renderServerList();
  await window.launcher.saveConfig(appConfig);
  $('#download-status').textContent = `下载完成：${result.filename}`;
  $('#download-percent').textContent = '100%';
  $('#progress-bar').style.width = '100%';
  appendConsole(`[Launcher] 已创建版本隔离目录：${result.serverDirectory}`, 'success');
  appendConsole(`[Launcher] 已新增并选中服务器：${newServer.name}`, 'success');
  await showModal('下载完成', `${result.filename}\n\n已创建新服务器：${newServer.name}\n保存位置：${result.serverDirectory}`, { confirmText: '确定', singleButton: true, icon: '✓' });
  $('#downloads-backdrop').classList.add('hidden');
});

window.launcher.onDownloadProgress(({ received, total, percent }) => {
  if (!downloading) return;
  const receivedMb = (received / 1024 / 1024).toFixed(1);
  const totalText = total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ' MB';
  $('#download-status').textContent = `已下载 ${receivedMb}${totalText}`;
  $('#download-percent').textContent = percent === null ? '下载中' : `${percent}%`;
  if (percent !== null) $('#progress-bar').style.width = `${percent}%`;
});

$('#start').addEventListener('click', async () => {
  const options = getOptions();
  if (!options.jarPath || !options.serverDirectory) { await showModal('启动设置不完整', '请选择服务端 JAR 和运行目录，或从“下载核心”中获取核心。', { cancelText: '关闭' }); return; }
  if (!Number.isInteger(options.minMemory) || !Number.isInteger(options.maxMemory) || options.minMemory < 256 || options.maxMemory < options.minMemory) { await showModal('内存设置无效', '内存必须是大于 256 MB 的整数，且最大内存不能小于最小内存。', { cancelText: '关闭' }); return; }
  if (propertiesDirty && loadedPropertiesDirectory === options.serverDirectory) {
    if (!await saveServerProperties()) return;
  }
  if (!await window.launcher.checkEula(options.serverDirectory)) {
    const accepted = await showModal('Minecraft EULA', '启动服务器前必须同意 Minecraft EULA。\n\n确认你已阅读并同意，然后在运行目录写入 eula=true？', { confirmText: '我同意' });
    if (!accepted || !await window.launcher.acceptEula(options.serverDirectory)) return;
  }
  await saveCurrentServer();
  $('#console').innerHTML = '';
  const result = await window.launcher.startServer(options);
  if (result.ok) { appendConsole(`[Launcher] 当前服务器：${currentServer().name}`, 'accent'); setRunning(true); }
  else await showModal('启动失败', result.error, { cancelText: '关闭' });
});

$('#stop').addEventListener('click', () => window.launcher.stopServer());
async function sendCommand() {
  const command = $('#command').value.trim();
  if (!command) return;
  if (await window.launcher.sendCommand(command)) {
    $('#command').value = '';
    hideCommandSuggestions();
  }
}
$('#send-command').addEventListener('click', sendCommand);

function hideCommandSuggestions() { $('#command-suggestions').classList.add('hidden'); }

function normalizeSuggestion(suggestion) {
  return String(suggestion || '').replace(/^\//, '');
}

function localCommandSuggestions(value) {
  const command = value.replace(/^\//, '');
  if (!command || /\s/.test(command)) return [];
  return COMMAND_COMPLETIONS.filter((item) => item.startsWith(command.toLowerCase()));
}

function applyCommandSuggestion(suggestion) {
  const input = $('#command');
  const leadingSlash = input.value.startsWith('/') ? '/' : '';
  const commandLine = input.value.replace(/^\//, '');
  const lastSpace = commandLine.lastIndexOf(' ');
  const beginning = lastSpace < 0 ? '' : commandLine.slice(0, lastSpace + 1);
  input.value = `${leadingSlash}${beginning}${normalizeSuggestion(suggestion)}`;
  input.setSelectionRange(input.value.length, input.value.length);
  commandCompletion.lastValue = input.value;
}

function renderCommandSuggestions(matches, activeIndex = -1) {
  const suggestions = $('#command-suggestions');
  suggestions.innerHTML = '';
  if (!matches.length) { hideCommandSuggestions(); return; }
  matches.forEach((command, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = index === activeIndex ? 'active' : '';
    button.textContent = command;
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      applyCommandSuggestion(command);
      hideCommandSuggestions();
      $('#command').focus();
    });
    suggestions.appendChild(button);
  });
  suggestions.classList.remove('hidden');
  suggestions.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

async function requestCommandSuggestions(value) {
  const request = ++completionRequest;
  const query = value.replace(/^\//, '');
  let matches = localCommandSuggestions(value);
  if (running && query) {
    const result = await window.launcher.completeServerCommand(query);
    if (request !== completionRequest) return null;
    if (result.ok) matches = [...new Set(result.suggestions.map(normalizeSuggestion).filter((item) => item && item.toLowerCase() !== 'mslcomplete'))];
  }
  if (request !== completionRequest) return null;
  commandCompletion = { query, matches, index: -1, lastValue: '' };
  renderCommandSuggestions(matches);
  return matches;
}

$('#command').addEventListener('input', (event) => {
  requestCommandSuggestions(event.currentTarget.value);
});
$('#command').addEventListener('focus', (event) => {
  requestCommandSuggestions(event.currentTarget.value);
});
$('#command').addEventListener('blur', hideCommandSuggestions);
$('#command').addEventListener('keydown', async (event) => {
  if (event.key === 'Enter') {
    commandCompletion = { query: '', matches: [], index: -1, lastValue: '' };
    hideCommandSuggestions();
    sendCommand();
    return;
  }
  if (event.key === 'Escape') { hideCommandSuggestions(); return; }
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const input = event.currentTarget;
  if (input.value !== commandCompletion.lastValue) {
    const matches = await requestCommandSuggestions(input.value);
    if (!matches) return;
    if (!matches.length) return;
    commandCompletion.index = event.shiftKey ? matches.length - 1 : 0;
  } else {
    const step = event.shiftKey ? -1 : 1;
    commandCompletion.index = (commandCompletion.index + step + commandCompletion.matches.length) % commandCompletion.matches.length;
  }
  applyCommandSuggestion(commandCompletion.matches[commandCompletion.index]);
  renderCommandSuggestions(commandCompletion.matches, commandCompletion.index);
});

window.launcher.onServerOutput(({ text, kind }) => { appendConsole(text, kind); updateStartupProgress(text); });
window.launcher.onServerState(() => setRunning(false));
window.launcher.onUpdateStatus((status) => {
  if (status.state === 'checking') showUpdateStatus('正在检查更新…');
  else if (status.state === 'available') {
    showUpdateStatus(`发现 v${status.version}，准备下载…`);
    appendConsole(`[Launcher] 发现新版本 v${status.version}，正在后台下载。`, 'accent');
  } else if (status.state === 'progress') {
    showUpdateStatus(`正在下载更新 ${Math.round(status.percent || 0)}%`);
  } else if (status.state === 'downloaded') {
    downloadedUpdateVersion = status.version;
    showUpdateStatus(`v${status.version} 已下载，点击更新`, 'ready');
    appendConsole(`[Launcher] 新版本 v${status.version} 已下载完成。`, 'accent');
    promptDownloadedUpdate();
  } else if (status.state === 'not-available') {
    showUpdateStatus('当前已是最新版');
    hideUpdateStatus(2500);
  } else if (status.state === 'error') {
    showUpdateStatus('更新检查失败', 'error');
    hideUpdateStatus(6000);
  }
});
window.launcher.onStopTimeout(async () => {
  if (await showModal('停止超时', '服务器在 20 秒内没有退出，是否强制结束进程？', { confirmText: '强制结束', danger: true })) window.launcher.killServer();
  else $('#stop').disabled = false;
});
window.launcher.onCloseRequested(async () => {
  if (!running) return window.launcher.forceCloseWindow();
  if (await showModal('服务器仍在运行', '是否安全停止服务器后退出？', { confirmText: '停止并退出' })) {
    await window.launcher.stopServer();
    const waitForExit = setInterval(() => { if (!running) { clearInterval(waitForExit); window.launcher.forceCloseWindow(); } }, 250);
  }
});

(async () => {
  appConfig = await window.launcher.loadConfig();
  const defaultRoot = await window.launcher.getDefaultServerRoot();
  if (defaultRoot.ok) defaultDownloadRoot = defaultRoot.path;
  loadCurrentServer();
  renderServerList();
  const java = await window.launcher.detectJava();
  $('#java-status').textContent = java.version;
  $('#java-status').style.color = java.available ? 'var(--success)' : 'var(--danger)';
})();
