// core/jottacloud_api.js

const Util = imports.misc.util;

const { JottacloudStatus } = require('./core/jottacloud_status');

var JottacloudApi = {

    // ---- Status ----

    status: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'status', '--json'],
            function(stdout) {
                try {
                    let json;
                    try {
                        json = JSON.parse(stdout);
                    } catch (e) {
                        if (!stdout || stdout.includes('command not found')) {
                            json = { cliInstalled: false };
                        } else {
                            json = { parseError: true };
                        }
                    }
                    if (onSuccess) onSuccess(new JottacloudStatus(json));
                } catch (e) {
                    global.logError('JottacloudApi::status error: ' + e);
                    if (onError) onError(e);
                }
            },
            function(error) {
                global.logError('JottacloudApi::status spawn error: ' + error);
                const cliMissing = error && error.toString().includes('command not found');
                const status = new JottacloudStatus(cliMissing ? { cliInstalled: false } : { parseError: true });
                if (onSuccess) onSuccess(status);
            }
        );
    },

    // ---- Sync control ----

    syncStart: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'sync', 'start'],
            function(stdout) { if (onSuccess) onSuccess(stdout); },
            function(e) { if (onError) onError(e); }
        );
    },

    syncStop: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'sync', 'stop'],
            function(stdout) { if (onSuccess) onSuccess(stdout); },
            function(e) { if (onError) onError(e); }
        );
    },

    syncTrigger: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'sync', 'trigger'],
            function(stdout) { if (onSuccess) onSuccess(stdout); },
            function(e) { if (onError) onError(e); }
        );
    },

    // ---- Daemon pause/resume ----

    pauseDaemon: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'pause'],
            function(stdout) { if (onSuccess) onSuccess(stdout); },
            function(e) { if (onError) onError(e); }
        );
    },

    resumeDaemon: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'resume'],
            function(stdout) { if (onSuccess) onSuccess(stdout); },
            function(e) { if (onError) onError(e); }
        );
    },

    // ---- Transfers ----

    listUploads: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'list', 'uploads'],
            function(stdout) {
                const text = (stdout || '').trim();
                if (!text || text === 'no uploads') {
                    if (onSuccess) onSuccess([]);
                    return;
                }
                const lines = text.split('\n').filter(function(l) { return l.trim(); });
                if (onSuccess) onSuccess(lines);
            },
            function(e) { if (onError) onError(e); }
        );
    },

    listDownloads: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'list', 'downloads'],
            function(stdout) {
                const text = (stdout || '').trim();
                if (!text || text === 'no downloads') {
                    if (onSuccess) onSuccess([]);
                    return;
                }
                const lines = text.split('\n').filter(function(l) { return l.trim(); });
                if (onSuccess) onSuccess(lines);
            },
            function(e) { if (onError) onError(e); }
        );
    },

    // ---- Sync activity log ----

    syncLog: function(n, onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'sync', 'log'],
            function(stdout) {
                try {
                    const entries = (stdout || '').split('\n')
                        .filter(function(l) { return l.trim() && l.includes('::'); })
                        .slice(0, n || 10)
                        .map(function(line) {
                            const idx = line.indexOf('::');
                            const timestamp = line.substring(0, idx).trim();
                            const action = line.substring(idx + 2).trim();
                            return { timestamp: timestamp, action: action };
                        });
                    if (onSuccess) onSuccess(entries);
                } catch (e) {
                    global.logError('JottacloudApi::syncLog parse error: ' + e);
                    if (onError) onError(e);
                }
            },
            function(e) { if (onError) onError(e); }
        );
    },

    // ---- Configuration ----

    getAllConfig: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'config'],
            function(stdout) {
                try {
                    const config = {};
                    (stdout || '').split('\n').forEach(function(line) {
                        const colonIdx = line.indexOf(':');
                        if (colonIdx === -1) return;
                        const key = line.substring(0, colonIdx).trim();
                        const value = line.substring(colonIdx + 1).trim();
                        if (key) config[key] = value;
                    });
                    if (onSuccess) onSuccess(config);
                } catch (e) {
                    global.logError('JottacloudApi::getAllConfig parse error: ' + e);
                    if (onError) onError(e);
                }
            },
            function(e) { if (onError) onError(e); }
        );
    },

    setConfigValue: function(key, value, onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'config', key, String(value)],
            function(stdout) { if (onSuccess) onSuccess(stdout); },
            function(e) {
                global.logError('JottacloudApi::setConfigValue error: ' + e);
                if (onError) onError(e);
            }
        );
    },

    // ---- Backup listing ----

    listBackupDevices: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'ls', 'Backup', '--json'],
            function(stdout) {
                try {
                    const json = JSON.parse(stdout);
                    if (onSuccess) onSuccess(json['Folders'] || []);
                } catch (e) {
                    global.logError('JottacloudApi::listBackupDevices parse error: ' + e);
                    if (onError) onError(e);
                }
            },
            function(e) { if (onError) onError(e); }
        );
    },

    // ---- Backup folder management ----

    add: function(folderPath, onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'add', folderPath],
            function(stdout) { if (onSuccess) onSuccess(stdout); },
            function(e) {
                global.logError('JottacloudApi::add error: ' + e);
                if (onError) onError(e);
            }
        );
    },

    rem: function(folderPath, onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'rem', folderPath],
            function(stdout) { if (onSuccess) onSuccess(stdout); },
            function(e) {
                global.logError('JottacloudApi::rem error: ' + e);
                if (onError) onError(e);
            }
        );
    },

    scan: function(path, onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'scan', path],
            function(stdout) { if (onSuccess) onSuccess(stdout); },
            function(e) {
                global.logError('JottacloudApi::scan error: ' + e);
                if (onError) onError(e);
            }
        );
    },

    // ---- Misc ----

    web: function() {
        Util.spawnCommandLine('jotta-cli web');
    },

    version: function(onSuccess, onError) {
        Util.spawn_async(
            ['jotta-cli', 'version'],
            function(stdout) {
                const match = (stdout || '').match(/(\d+\.\d+\.\d+)/);
                if (onSuccess) onSuccess(match ? match[1] : (stdout || '').trim());
            },
            function(e) { if (onError) onError(e); }
        );
    }
};

if (typeof module !== 'undefined') {
    module.exports = JottacloudApi;
}
