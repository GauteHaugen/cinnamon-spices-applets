const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const Util = imports.misc.util;
const { Gio, GLib, Gtk, St } = imports.gi;

const { ShaderLogState, STATE_IDLE, STATE_PROCESSING, STATE_STALLED } = require('./shader_log');

const LOG_NAME = 'shader_log.txt';
const TICK_SECONDS = 10;
const STARTUP_TAIL_BYTES = 200 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MONITOR_DEBOUNCE_MS = 500;
// A job silent for this long is treated as abandoned (Steam quit mid-job).
const ABANDON_SECONDS = 30 * 60;
const IDLE_OPACITY = 110;

class ShaderStatusApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.metadata = metadata;

        // Settings defaults (overwritten by bind, prefixed with pref_ to avoid conflicts)
        this.pref_steamRoot = '~/.steam/steam';
        this.pref_logPathOverride = '';
        this.pref_hideWhenIdle = false;
        this.pref_stallTimeout = 60;
        this.pref_notify = false;
        this.pref_enableDebug = false;

        // State
        this.log = null;
        this._names = new Map();
        this._libraryPaths = null;
        this._offset = 0;
        this._inode = null;
        this._partial = '';
        this._reading = false;
        this._readAgain = false;
        this._replaying = false;
        this._decoder = new TextDecoder('utf-8');
        this._monitor = null;
        this._monitorId = 0;
        this._debounceId = 0;
        this._tickId = 0;
        this._removed = false;

        try {
            this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
            this._bindSettings();
        } catch (e) {
            global.logError('SteamShaderStatus: Settings init failed: ' + e);
        }

        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menuManager.addMenu(this.menu);
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) this._rebuildMenu();
        });
        this._buildMenu();

        this._setIcon(false);
        this._start();
    }

    _bindSettings() {
        this.settings.bind('steam-root', 'pref_steamRoot', this._restart.bind(this));
        this.settings.bind('log-path-override', 'pref_logPathOverride', this._restart.bind(this));
        this.settings.bind('hide-when-idle', 'pref_hideWhenIdle', this._refreshUI.bind(this));
        this.settings.bind('stall-timeout', 'pref_stallTimeout', this._refreshUI.bind(this));
        this.settings.bind('notify', 'pref_notify', null);
        this.settings.bind('enable-debug', 'pref_enableDebug', null);
    }

    _debug(msg) {
        if (this.pref_enableDebug) global.log('SteamShaderStatus: ' + msg);
    }

    // ---- Paths ----

    _expand(path) {
        path = (path || '').trim();
        if (path === '~') return GLib.get_home_dir();
        if (path.startsWith('~/')) return GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);
        return path;
    }

    _steamRoot() {
        return this._expand(this.pref_steamRoot) || GLib.build_filenamev([GLib.get_home_dir(), '.steam', 'steam']);
    }

    _logPath() {
        const override = this._expand(this.pref_logPathOverride);
        return override || GLib.build_filenamev([this._steamRoot(), 'logs', LOG_NAME]);
    }

    // ---- Lifecycle ----

    _start() {
        this.log = new ShaderLogState();
        this.log.onEvent((type, data) => this._onLogEvent(type, data));
        this._offset = 0;
        this._inode = null;
        this._partial = '';
        this._replaying = true;

        this._startMonitor();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, TICK_SECONDS, () => {
            this._readNew();
            this._refreshUI();
            return GLib.SOURCE_CONTINUE;
        });

        this._refreshUI();
        this._readNew();
    }

    _stop() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        if (this._monitor) {
            if (this._monitorId) this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
            this._monitorId = 0;
        }
    }

    _restart() {
        this._stop();
        this._libraryPaths = null;
        this._names.clear();
        this._start();
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        this._removed = true;
        this._stop();
        if (this.settings) this.settings.finalize();
        this.menu.destroy();
    }

    // ---- Tailing ----

    // Watching the directory, not the file, survives Steam replacing the log on restart.
    _startMonitor() {
        const path = this._logPath();
        const dir = Gio.File.new_for_path(GLib.path_get_dirname(path));
        const name = GLib.path_get_basename(path);
        try {
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitorId = this._monitor.connect('changed', (monitor, file, otherFile) => {
                const hit = (file && file.get_basename() === name) ||
                    (otherFile && otherFile.get_basename() === name);
                if (hit) this._scheduleRead();
            });
        } catch (e) {
            // Directory may not exist yet; the tick timer keeps polling.
            this._debug('monitor failed: ' + e);
        }
    }

    // Steam writes bursts of lines; coalesce change events into one read.
    _scheduleRead() {
        if (this._debounceId) return;
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_LOW, MONITOR_DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this._readNew();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readNew() {
        if (this._reading) {
            this._readAgain = true;
            return;
        }
        this._reading = true;
        this._readAgain = false;

        const file = Gio.File.new_for_path(this._logPath());
        file.query_info_async('standard::size,unix::inode', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (f, res) => {
                let info;
                try {
                    info = f.query_info_finish(res);
                } catch (e) {
                    // No log yet (Steam never ran shader processing); stay idle.
                    this._finishRead(false);
                    return;
                }
                try {
                    this._onInfo(f, info);
                } catch (e) {
                    global.logError('SteamShaderStatus: ' + e);
                    this._finishRead(false);
                }
            });
    }

    _onInfo(file, info) {
        const size = info.get_size();
        const inode = info.get_attribute_uint64('unix::inode');

        if (this._inode !== null && (inode !== this._inode || size < this._offset)) {
            this._debug(`log replaced or truncated (inode ${this._inode} -> ${inode}, size ${size} < ${this._offset})`);
            this._offset = 0;
            this._partial = '';
        }
        let skipFirstLine = false;
        if (this._inode === null && size > STARTUP_TAIL_BYTES) {
            // First read: replay only the tail, starting at the next full line.
            this._offset = size - STARTUP_TAIL_BYTES;
            skipFirstLine = true;
        }
        this._inode = inode;

        if (size <= this._offset) {
            this._finishRead(false);
            return;
        }

        const count = Math.min(size - this._offset, MAX_READ_BYTES);
        file.read_async(GLib.PRIORITY_LOW, null, (f, res) => {
            let stream;
            try {
                stream = f.read_finish(res);
                stream.seek(this._offset, GLib.SeekType.SET, null);
            } catch (e) {
                this._debug('open failed: ' + e);
                this._finishRead(false);
                return;
            }
            stream.read_bytes_async(count, GLib.PRIORITY_LOW, null, (s, res2) => {
                try {
                    const bytes = s.read_bytes_finish(res2);
                    const data = bytes.get_data() || new Uint8Array(0);
                    this._offset += data.length;
                    let text = this._partial + this._decoder.decode(data);
                    if (skipFirstLine) {
                        const nl = text.indexOf('\n');
                        text = nl >= 0 ? text.slice(nl + 1) : '';
                    }
                    const lines = text.split('\n');
                    this._partial = lines.pop();
                    for (const line of lines) this.log.feedLine(line);
                    this._debug(`read ${data.length} bytes, ${lines.length} lines, offset ${this._offset}`);
                    this._finishRead(this._offset < size);
                } catch (e) {
                    global.logError('SteamShaderStatus: read failed: ' + e);
                    this._finishRead(false);
                } finally {
                    s.close_async(GLib.PRIORITY_LOW, null, null);
                }
            });
        });
    }

    _finishRead(moreData) {
        this._reading = false;
        if (this._removed) return;
        if (this._replaying && !moreData) {
            this._replaying = false;
            const now = this._now();
            if (this.log.dropAbandoned(now, ABANDON_SECONDS)) this._debug('dropped abandoned job from replay');
        }
        this._refreshUI();
        if (moreData || this._readAgain) this._readNew();
    }

    _now() {
        return Math.floor(GLib.get_real_time() / 1000000);
    }

    // ---- Game names ----

    _readText(path) {
        try {
            const [ok, contents] = GLib.file_get_contents(path);
            return ok ? new TextDecoder('utf-8').decode(contents) : null;
        } catch (e) {
            return null;
        }
    }

    _getLibraryPaths() {
        if (this._libraryPaths) return this._libraryPaths;
        const root = this._steamRoot();
        const paths = [root];
        const vdf = this._readText(GLib.build_filenamev([root, 'steamapps', 'libraryfolders.vdf']));
        if (vdf) {
            const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
            let m;
            while ((m = re.exec(vdf)) !== null) {
                const p = m[1].replace(/\\\\/g, '\\');
                if (!paths.includes(p)) paths.push(p);
            }
        }
        this._libraryPaths = paths;
        return paths;
    }

    _gameName(appid) {
        if (this._names.has(appid)) return this._names.get(appid);
        let name = null;
        for (const lib of this._getLibraryPaths()) {
            const acf = this._readText(GLib.build_filenamev([lib, 'steamapps', `appmanifest_${appid}.acf`]));
            const m = acf && /"name"\s+"((?:[^"\\]|\\.)*)"/.exec(acf);
            if (m) {
                name = m[1];
                break;
            }
        }
        // Uninstalled games can still have shader jobs.
        name = name || `App ${appid}`;
        this._names.set(appid, name);
        return name;
    }

    // ---- Events ----

    _onLogEvent(type, data) {
        if (this._replaying || !this.pref_notify) return;
        const name = this._gameName(data.appid);
        if (type === 'jobStarted')
            Main.notify('Steam shader processing', `Started: ${name}`);
        else if (type === 'jobCompleted')
            Main.notify('Steam shader processing', `Finished: ${name}`);
    }

    // ---- UI ----

    _setIcon(warning) {
        if (warning) {
            this.set_applet_icon_symbolic_name('dialog-warning-symbolic');
            return;
        }
        const theme = Gtk.IconTheme.get_default();
        if (theme.has_icon('steam-symbolic'))
            this.set_applet_icon_symbolic_name('steam-symbolic');
        else if (theme.has_icon('steam'))
            this.set_applet_icon_name('steam');
        else
            this.set_applet_icon_symbolic_name('system-run-symbolic');
    }

    _refreshUI() {
        if (this._removed || !this.log) return;
        try {
            const now = this._now();
            const state = this.log.getState(now, this.pref_stallTimeout);
            if (state === STATE_STALLED) this.log.dropAbandoned(now, ABANDON_SECONDS);
            this._renderPanel(this.log.getState(now, this.pref_stallTimeout), now);
            if (this.menu.isOpen) this._rebuildMenu();
        } catch (e) {
            global.logError('SteamShaderStatus: refresh failed: ' + e);
        }
    }

    _renderPanel(state, now) {
        const job = this.log.job;
        if (state !== this._lastState) {
            this._setIcon(state === STATE_STALLED);
            this._lastState = state;
        }

        if (state === STATE_IDLE) {
            this.set_applet_label('');
            this.hide_applet_label(true);
            this.actor.opacity = IDLE_OPACITY;
            this.actor.visible = !this.pref_hideWhenIdle;
            const last = this.log.completed[this.log.completed.length - 1];
            this.set_applet_tooltip(last
                ? `Steam shaders: idle\nLast finished: ${this._gameName(last.appid)} at ${this._formatTime(last.finishedAt)}`
                : 'Steam shaders: idle');
            return;
        }

        this.actor.visible = true;
        this.actor.opacity = 255;
        this.hide_applet_label(false);
        const name = this._gameName(job.appid);
        const pct = job.percent === null ? '…' : `${job.percent}%`;
        this.set_applet_label(`${name} ${pct}`);
        this.set_applet_tooltip(this._detailLines(state, now).join('\n'));
    }

    _detailLines(state, now) {
        const job = this.log.job;
        const lines = [];
        lines.push(`${this._gameName(job.appid)} (AppID ${job.appid})`);
        if (state === STATE_STALLED)
            lines.push(`Stalled: no progress for ${this._formatDuration(now - job.lastTickAt)}`);
        if (job.total !== null) {
            lines.push(`Pipelines: ${job.done.toLocaleString()} / ${job.total.toLocaleString()} (${job.percent}%)`);
            const rate = this.log.getRate();
            if (state === STATE_STALLED)
                lines.push('Rate: no ETA while stalled');
            else if (rate === null)
                lines.push('Rate: no ETA yet');
            else
                lines.push(`Rate: ${Math.round(rate).toLocaleString()} pipelines/s, ETA ${this._formatDuration(this.log.getEta())}`);
        } else {
            lines.push('Waiting for first progress update');
        }
        lines.push(`Started ${this._formatTime(job.startedAt)}, last update ${Math.max(0, now - job.lastTickAt)} s ago`);
        return lines;
    }

    // The menu manager closes the popup when the item holding key focus (the one under
    // the pointer) is destroyed. So clickable items are built once, and the refresh only
    // replaces the non-reactive info lines, which never take focus.
    _buildMenu() {
        this._infoSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._infoSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const open = new PopupMenu.PopupIconMenuItem('Open shader log', 'text-x-generic-symbolic', St.IconType.SYMBOLIC);
        open.connect('activate', () => Util.spawn(['xdg-open', this._logPath()]));
        this.menu.addMenuItem(open);
    }

    _rebuildMenu() {
        const section = this._infoSection;
        const focus = global.stage.key_focus;
        if (focus && section.actor.contains(focus)) this.menu.actor.grab_key_focus();
        section.removeAll();
        const now = this._now();
        const state = this.log.getState(now, this.pref_stallTimeout);

        const header = state === STATE_IDLE ? 'Steam shaders: idle'
            : state === STATE_STALLED ? 'Steam shaders: stalled' : 'Steam shaders: processing';
        section.addMenuItem(this._infoItem(header, true));

        if (state !== STATE_IDLE) {
            for (const line of this._detailLines(state, now))
                section.addMenuItem(this._infoItem(line));
        }

        if (this.log.completed.length > 0) {
            section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            section.addMenuItem(this._infoItem('Completed this session', true));
            for (const c of this.log.completed.slice().reverse())
                section.addMenuItem(this._infoItem(`${this._formatTime(c.finishedAt)}  ${this._gameName(c.appid)}`));
        }

        if (this.log.lastDriverPrune !== null) {
            section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            section.addMenuItem(this._infoItem(`Driver cache invalidated ${this._formatTime(this.log.lastDriverPrune)}`));
        }
    }

    _infoItem(text, bold) {
        const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        if (bold) item.label.set_style('font-weight: bold;');
        return item;
    }

    // ---- Formatting ----

    _formatTime(unix) {
        const dt = GLib.DateTime.new_from_unix_local(unix);
        const today = GLib.DateTime.new_now_local();
        const sameDay = dt.get_year() === today.get_year() && dt.get_day_of_year() === today.get_day_of_year();
        return dt.format(sameDay ? '%H:%M' : '%Y-%m-%d %H:%M');
    }

    _formatDuration(seconds) {
        seconds = Math.round(seconds);
        if (seconds < 60) return `${seconds} s`;
        const m = Math.floor(seconds / 60);
        if (m < 60) return `${m} min ${seconds % 60} s`;
        return `${Math.floor(m / 60)} h ${m % 60} min`;
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ShaderStatusApplet(metadata, orientation, panelHeight, instanceId);
}
