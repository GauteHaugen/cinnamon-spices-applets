const Applet = imports.ui.applet;
const Util = imports.misc.util;
const Settings = imports.ui.settings;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const GLib = imports.gi.GLib;

const { JottacloudStatus } = require('./core/jottacloud_status');
const JottacloudApi = require('./core/jottacloud_api');

class JottacloudApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.metadata = metadata;
        this.orientation = orientation;
        this.instanceId = instanceId;

        this.set_applet_icon_symbolic_name('emblem-synchronizing-symbolic');
        this.set_applet_tooltip('Initializing Jottacloud...');
        this.set_applet_label('...');

        // State
        this.jottaStatus = new JottacloudStatus({});
        this.jottaStatusUpdated = null;
        this.transfers = { uploads: [], downloads: [] };
        this.syncActivity = [];
        this.cliConfig = {};
        this.backupDevices = [];
        this._statusTimer = null;
        this._transferTimer = null;
        this._menuLiveTimer = null;
        this._menuTimestampItem = null;

        // Settings defaults (overwritten by bind, prefixed with pref_ to avoid conflicts)
        this.pref_updateInterval = 10;
        this.pref_showLabel = true;
        this.pref_showIcon = true;
        this.pref_showNotifications = true;
        this.pref_notifyErrors = true;
        this.pref_showTransfers = true;
        this.pref_showRecentActivity = true;
        this.pref_recentActivityCount = 5;
        this.pref_enableDebug = false;

        try {
            this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
            this._bindSettings();
        } catch (e) {
            global.logError('JottacloudApplet: Settings init failed: ' + e);
        }

        // Popup menu (left-click)
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menuManager.addMenu(this.menu);

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._startMenuLiveTimer();
            } else {
                this._stopMenuLiveTimer();
            }
        });

        this._buildContextMenu();
        this._startup();
    }

    _bindSettings() {
        this.settings.bind('update-interval', 'pref_updateInterval', this._onIntervalChanged.bind(this));
        this.settings.bind('show-label', 'pref_showLabel', this._updatePanelDisplay.bind(this));
        this.settings.bind('show-icon', 'pref_showIcon', this._updatePanelDisplay.bind(this));
        this.settings.bind('show-notifications', 'pref_showNotifications', null);
        this.settings.bind('notify-errors', 'pref_notifyErrors', null);
        this.settings.bind('show-transfers', 'pref_showTransfers', null);
        this.settings.bind('show-recent-activity', 'pref_showRecentActivity', null);
        this.settings.bind('recent-activity-count', 'pref_recentActivityCount', null);
        this.settings.bind('enable-debug', 'pref_enableDebug', null);
    }

    _onIntervalChanged() {
        this._stopStatusTimer();
        this._startStatusTimer();
    }

    // ---- Lifecycle ----

    _startup() {
        this._fetchStatus();
        this._startStatusTimer();
        this._fetchTransfers();
        if (this.pref_showRecentActivity) this._fetchSyncLog();
        this._startTransferTimer();
        this._fetchConfig();
        this._fetchBackupDevices();
    }

    _startStatusTimer() {
        this._statusTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW,
            this.pref_updateInterval,
            () => {
                this._fetchStatus();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopStatusTimer() {
        if (this._statusTimer) {
            GLib.source_remove(this._statusTimer);
            this._statusTimer = null;
        }
    }

    _startTransferTimer() {
        this._transferTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW,
            30,
            () => {
                this._fetchTransfers();
                if (this.pref_showRecentActivity) this._fetchSyncLog();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTransferTimer() {
        if (this._transferTimer) {
            GLib.source_remove(this._transferTimer);
            this._transferTimer = null;
        }
    }

    _startMenuLiveTimer() {
        this._stopMenuLiveTimer();
        this._menuLiveTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            2000,
            () => {
                if (!this.menu || !this.menu.isOpen) {
                    this._menuLiveTimer = null;
                    return GLib.SOURCE_REMOVE;
                }
                this._updateMenuTimestamp();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopMenuLiveTimer() {
        if (this._menuLiveTimer) {
            GLib.source_remove(this._menuLiveTimer);
            this._menuLiveTimer = null;
        }
    }

    _updateMenuTimestamp() {
        if (this._menuTimestampItem && this.jottaStatusUpdated) {
            this._menuTimestampItem.label.set_text(
                'Updated: ' + this._formatRelativeTime(this.jottaStatusUpdated)
            );
        }
    }

    on_applet_removed_from_panel() {
        this._stopStatusTimer();
        this._stopTransferTimer();
        this._stopMenuLiveTimer();
        if (this.settings) this.settings.finalize();
    }

    // ---- Data fetching ----

    _fetchStatus() {
        JottacloudApi.status(
            (newStatus) => {
                const prevStatus = this.jottaStatus;
                this.jottaStatus = newStatus;
                this.jottaStatusUpdated = new Date();
                this._updatePanelDisplay();
                this._maybeNotify(prevStatus, newStatus);
            },
            (error) => {
                global.logError('JottacloudApplet: Status fetch failed: ' + error);
                this.jottaStatus = new JottacloudStatus({ parseError: true });
                this.jottaStatusUpdated = new Date();
                this._updatePanelDisplay();
            }
        );
    }

    _fetchTransfers() {
        JottacloudApi.listUploads(
            (uploads) => { this.transfers.uploads = uploads; this._updatePanelDisplay(); },
            (e) => global.logError('JottacloudApplet: listUploads failed: ' + e)
        );
        JottacloudApi.listDownloads(
            (downloads) => { this.transfers.downloads = downloads; this._updatePanelDisplay(); },
            (e) => global.logError('JottacloudApplet: listDownloads failed: ' + e)
        );
    }

    _fetchSyncLog() {
        JottacloudApi.syncLog(
            this.pref_recentActivityCount,
            (entries) => { this.syncActivity = entries; },
            (e) => global.logError('JottacloudApplet: syncLog failed: ' + e)
        );
    }

    _fetchConfig() {
        JottacloudApi.getAllConfig(
            (config) => { this.cliConfig = config; },
            (e) => global.logError('JottacloudApplet: getAllConfig failed: ' + e)
        );
    }

    _fetchBackupDevices() {
        JottacloudApi.listBackupDevices(
            (devices) => { this.backupDevices = devices; },
            (e) => global.logError('JottacloudApplet: listBackupDevices failed: ' + e)
        );
    }

    // ---- Notifications ----

    _maybeNotify(prev, next) {
        if (!this.pref_showNotifications) return;

        if (prev.userState.authenticated && !next.userState.authenticated) {
            this._notifyError('Jottacloud', 'Logged out — please log in again');
            return;
        }

        if (!prev.parseError && next.parseError && this.pref_notifyErrors) {
            this._notifyError('Jottacloud', 'Failed to get status from jotta-cli');
            return;
        }

        if (next.userState.accountInfo.isNearlyFull && !prev.userState.accountInfo.isNearlyFull) {
            this._notifyError('Jottacloud', 'Storage nearly full: ' + next.userState.accountInfo.usageText);
        }

        if (prev.isUploading && !next.isUploading && !next.isDownloading) {
            this._notify('Jottacloud', 'Sync complete — up to date');
        }
    }

    _notify(title, message) {
        if (!this.pref_showNotifications) return;
        Main.notify(title, message);
    }

    _notifyError(title, message) {
        if (!this.pref_notifyErrors) return;
        Main.notifyError(title, message);
    }

    // ---- Panel display ----

    _updatePanelDisplay() {
        this.set_applet_label(this.pref_showLabel ? this.jottaStatus.appletLabelText : '');

        if (this.pref_showIcon) {
            try {
                this.set_applet_icon_symbolic_name(this.jottaStatus.appletIconName);
            } catch (e) {
                this.set_applet_icon_symbolic_name('emblem-default-symbolic');
            }
        }

        this.set_applet_tooltip(this.jottaStatus.appletTooltipText);
    }

    // ---- Left-click popup ----

    on_applet_clicked(event) {
        if (!this.menu.isOpen) this._rebuildMenu();
        this.menu.toggle();
    }

    _rebuildMenu() {
        this.menu.removeAll();

        if (this.jottaStatus.cliInstalled === false) {
            this._addInfoItem('jotta-cli not installed');
            this._addInfoItem('Install from jottacloud.com/en/help/downloads');
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const webItem = new PopupMenu.PopupMenuItem('Open Jottacloud Website');
            webItem.connect('activate', () => JottacloudApi.web());
            this.menu.addMenuItem(webItem);
            return;
        }

        if (this.jottaStatus.parseError) {
            this._addInfoItem('Error reading jotta-cli status');
            const retryItem = new PopupMenu.PopupMenuItem('Retry');
            retryItem.connect('activate', () => this._fetchStatus());
            this.menu.addMenuItem(retryItem);
            return;
        }

        this._buildAccountSection();
        this._buildSyncSection();
        if (this.pref_showTransfers) this._buildTransfersSection();
        this._buildBackupSection();
        if (this.pref_showRecentActivity && this.syncActivity.length > 0) this._buildRecentActivitySection();
        this._buildQuickSettingsSection();
        this._buildActionsSection();
    }

    _addHeader(text) {
        const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        item.label.add_style_class_name('popup-subtitle-menu-item');
        this.menu.addMenuItem(item);
    }

    _addInfoItem(text) {
        const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        this.menu.addMenuItem(item);
        return item;
    }

    // ---- Menu sections ----

    _buildAccountSection() {
        this._addHeader('Account');

        const u = this.jottaStatus.userState;

        if (!u.authenticated) {
            this._addInfoItem('Not logged in');
            const loginItem = new PopupMenu.PopupMenuItem('Run: jotta-cli login');
            loginItem.connect('activate', () => {
                Util.spawnCommandLine('x-terminal-emulator -e jotta-cli login');
            });
            this.menu.addMenuItem(loginItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            return;
        }

        this._addInfoItem(u.fullname + '  ·  ' + u.email);
        this._addInfoItem('Storage: ' + u.accountInfo.usageText);
        if (u.accountInfo.subscriptionName) {
            this._addInfoItem(u.accountInfo.subscriptionName);
        }
        this._addInfoItem('Device: ' + (u.device.name || u.hostName || 'Unknown'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _buildSyncSection() {
        this._addHeader('Sync');

        const s = this.jottaStatus.syncState;

        if (!s.enabled) {
            this._addInfoItem('Sync not configured');
            this._addInfoItem('Use: jotta-cli sync setup --root /path');
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            return;
        }

        this._addInfoItem('Status: ' + s.statusSummary);
        this._addInfoItem('Folder: ' + (s.rootPath || 'Unknown'));
        this._addInfoItem('Files: ' + s.localFilesText);

        if (!s.isInSync) {
            this._addInfoItem('⚠  Out of sync: ' + s.syncDeltaText);
        }

        this._addInfoItem('Last sync: ' + s.lastSyncText);

        const syncPaused = this.cliConfig['syncpaused'] === 'true';
        if (syncPaused) {
            const resumeItem = new PopupMenu.PopupMenuItem('▶  Resume Sync');
            resumeItem.connect('activate', () => {
                JottacloudApi.setConfigValue('syncpaused', 'false', () => {
                    JottacloudApi.syncStart(() => {
                        this._fetchStatus();
                        this._fetchConfig();
                        this._notify('Jottacloud', 'Sync resumed');
                    });
                });
            });
            this.menu.addMenuItem(resumeItem);
        } else {
            const pauseItem = new PopupMenu.PopupMenuItem('⏸  Pause Sync');
            pauseItem.connect('activate', () => {
                JottacloudApi.syncStop(() => {
                    JottacloudApi.setConfigValue('syncpaused', 'true', () => {
                        this._fetchStatus();
                        this._fetchConfig();
                        this._notify('Jottacloud', 'Sync paused');
                    });
                });
            });
            this.menu.addMenuItem(pauseItem);
        }

        if (!s.automatic) {
            const triggerItem = new PopupMenu.PopupMenuItem('↻  Trigger Sync Now');
            triggerItem.connect('activate', () => {
                JottacloudApi.syncTrigger(() => {
                    this._notify('Jottacloud', 'Sync triggered');
                    GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => {
                        this._fetchStatus();
                        return GLib.SOURCE_REMOVE;
                    });
                });
            });
            this.menu.addMenuItem(triggerItem);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _buildTransfersSection() {
        const uploads = this.transfers.uploads;
        const downloads = this.transfers.downloads;
        const hasTransfers = uploads.length > 0 || downloads.length > 0;

        this._addHeader('Active Transfers');

        if (!hasTransfers) {
            this._addInfoItem('No active transfers');
        } else {
            if (uploads.length > 0) {
                this._addInfoItem('↑ Uploading (' + uploads.length + ')');
                uploads.slice(0, 5).forEach((t) => {
                    const label = t.length > 70 ? t.substring(0, 67) + '...' : t;
                    this._addInfoItem('   ' + label);
                });
                if (uploads.length > 5) this._addInfoItem('   … and ' + (uploads.length - 5) + ' more');
            }
            if (downloads.length > 0) {
                this._addInfoItem('↓ Downloading (' + downloads.length + ')');
                downloads.slice(0, 5).forEach((t) => {
                    const label = t.length > 70 ? t.substring(0, 67) + '...' : t;
                    this._addInfoItem('   ' + label);
                });
                if (downloads.length > 5) this._addInfoItem('   … and ' + (downloads.length - 5) + ' more');
            }
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _buildBackupSection() {
        this._addHeader('Backup');

        const b = this.jottaStatus.backupState;
        const currentDevice = this.jottaStatus.userState.device.name;
        const backupPaused = this.cliConfig['backuppaused'] === 'true';
        const scanInterval = this.cliConfig['scaninterval'] || '1h';

        // Controls for backup on this device
        if (b.enabled) {
            this._addInfoItem((backupPaused ? '⏸  Paused' : '● Active') + '  ·  scan every ' + scanInterval);

            if (backupPaused) {
                const resumeItem = new PopupMenu.PopupMenuItem('▶  Resume Backup');
                resumeItem.connect('activate', () => {
                    JottacloudApi.setConfigValue('backuppaused', 'false', () => {
                        this._fetchConfig();
                        this._notify('Jottacloud', 'Backup resumed');
                    });
                });
                this.menu.addMenuItem(resumeItem);
            } else {
                const pauseItem = new PopupMenu.PopupMenuItem('⏸  Pause Backup');
                pauseItem.connect('activate', () => {
                    JottacloudApi.setConfigValue('backuppaused', 'true', () => {
                        this._fetchConfig();
                        this._notify('Jottacloud', 'Backup paused');
                    });
                });
                this.menu.addMenuItem(pauseItem);
            }
        }

        // List all backup devices
        if (this.backupDevices.length > 0) {
            this.backupDevices.forEach((device) => {
                const isCurrentDevice = device['Name'] === currentDevice;
                const marker = isCurrentDevice ? '▸ ' : '  ';
                let label = marker + device['Name'];
                if (device['Size']) {
                    label += '  (' + this._formatBytes(device['Size']) + ')';
                }
                if (isCurrentDevice) {
                    label += '  ← this device';
                }
                this._addInfoItem(label);
            });
        } else {
            this._addInfoItem('No backup devices found');
        }

        const addItem = new PopupMenu.PopupMenuItem('+  Add folder to backup...');
        addItem.connect('activate', () => this._showAddFolderDialog());
        this.menu.addMenuItem(addItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _buildRecentActivitySection() {
        this._addHeader('Recent Activity');

        this.syncActivity.forEach((entry) => {
            const action = entry.action.length > 65
                ? entry.action.substring(0, 62) + '...'
                : entry.action;
            this._addInfoItem(action);
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _buildQuickSettingsSection() {
        const sub = new PopupMenu.PopupSubMenuMenuItem('⚙  Quick Settings');

        const uploadRate = this.cliConfig['uploadrate'] || 'unlimited';
        const downloadRate = this.cliConfig['downloadrate'] || 'unlimited';
        const maxUploads = this.cliConfig['maxuploads'] || '6';
        const maxDownloads = this.cliConfig['maxdownloads'] || '6';
        const scanInterval = this.cliConfig['scaninterval'] || '1h';
        const ignoreHidden = this.cliConfig['ignorehiddenfiles'] === 'true';

        const uploadItem = new PopupMenu.PopupMenuItem('Upload limit: ' + uploadRate);
        uploadItem.connect('activate', () => {
            this._editConfigValue('uploadrate', uploadRate, 'Upload rate limit (e.g. 5MB/s or unlimited)');
        });
        sub.menu.addMenuItem(uploadItem);

        const downloadItem = new PopupMenu.PopupMenuItem('Download limit: ' + downloadRate);
        downloadItem.connect('activate', () => {
            this._editConfigValue('downloadrate', downloadRate, 'Download rate limit (e.g. 10MB/s or unlimited)');
        });
        sub.menu.addMenuItem(downloadItem);

        const maxUpItem = new PopupMenu.PopupMenuItem('Max concurrent uploads: ' + maxUploads);
        maxUpItem.connect('activate', () => {
            this._editConfigValue('maxuploads', maxUploads, 'Max concurrent uploads (1–20)');
        });
        sub.menu.addMenuItem(maxUpItem);

        const maxDownItem = new PopupMenu.PopupMenuItem('Max concurrent downloads: ' + maxDownloads);
        maxDownItem.connect('activate', () => {
            this._editConfigValue('maxdownloads', maxDownloads, 'Max concurrent downloads (1–20)');
        });
        sub.menu.addMenuItem(maxDownItem);

        const scanItem = new PopupMenu.PopupMenuItem('Backup scan interval: ' + scanInterval);
        scanItem.connect('activate', () => {
            this._editConfigValue('scaninterval', scanInterval, 'Scan interval (e.g. 30m, 1h, 2h)');
        });
        sub.menu.addMenuItem(scanItem);

        const hiddenLabel = 'Ignore hidden files: ' + (ignoreHidden ? 'Yes' : 'No');
        const hiddenItem = new PopupMenu.PopupMenuItem(hiddenLabel);
        hiddenItem.connect('activate', () => {
            JottacloudApi.setConfigValue('ignorehiddenfiles', String(!ignoreHidden), () => {
                this._fetchConfig();
                this._notify('Jottacloud', 'Ignore hidden files: ' + (!ignoreHidden ? 'enabled' : 'disabled'));
            });
        });
        sub.menu.addMenuItem(hiddenItem);

        this.menu.addMenuItem(sub);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _editConfigValue(key, currentValue, prompt) {
        this.menu.close();
        Util.spawn_async(
            ['zenity', '--entry',
                '--title=Jottacloud — ' + key,
                '--text=' + prompt + ':',
                '--entry-text=' + currentValue],
            (result) => {
                if (result && result.trim() && result.trim() !== currentValue) {
                    JottacloudApi.setConfigValue(key, result.trim(), () => {
                        this._fetchConfig();
                        this._notify('Jottacloud', key + ' set to ' + result.trim());
                    });
                }
            }
        );
    }

    _buildActionsSection() {
        const webItem = new PopupMenu.PopupMenuItem('Open Jottacloud Web');
        webItem.connect('activate', () => JottacloudApi.web());
        this.menu.addMenuItem(webItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh Now');
        refreshItem.connect('activate', () => {
            this._fetchStatus();
            this._fetchTransfers();
            if (this.pref_showRecentActivity) this._fetchSyncLog();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                if (this.menu.isOpen) this._rebuildMenu();
                return GLib.SOURCE_REMOVE;
            });
        });
        this.menu.addMenuItem(refreshItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const timeText = this.jottaStatusUpdated
            ? this._formatRelativeTime(this.jottaStatusUpdated)
            : 'never';
        this._menuTimestampItem = this._addInfoItem('Updated: ' + timeText);
    }

    // ---- Dialogs ----

    _showAddFolderDialog() {
        this.menu.close();
        Util.spawn_async(
            ['zenity', '--file-selection', '--directory', '--title=Select folder to backup'],
            (result) => {
                if (!result || !result.trim()) return;
                const folder = result.trim();
                JottacloudApi.add(
                    folder,
                    () => {
                        this._fetchStatus();
                        this._notify('Jottacloud', 'Added to backup: ' + folder);
                    },
                    (e) => {
                        global.logError('JottacloudApplet: add folder failed: ' + e);
                        this._notifyError('Jottacloud', 'Failed to add folder to backup');
                    }
                );
            }
        );
    }

    // ---- Right-click context menu ----

    _buildContextMenu() {
        const pauseAllItem = new PopupMenu.PopupMenuItem('Pause Everything');
        pauseAllItem.connect('activate', () => {
            JottacloudApi.pauseDaemon(() => {
                this._fetchStatus();
                this._fetchConfig();
                this._notify('Jottacloud', 'Jottacloud paused');
            });
        });
        this._applet_context_menu.addMenuItem(pauseAllItem);

        const resumeAllItem = new PopupMenu.PopupMenuItem('Resume Everything');
        resumeAllItem.connect('activate', () => {
            JottacloudApi.resumeDaemon(() => {
                this._fetchStatus();
                this._fetchConfig();
                this._notify('Jottacloud', 'Jottacloud resumed');
            });
        });
        this._applet_context_menu.addMenuItem(resumeAllItem);

        this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const addFolderItem = new PopupMenu.PopupMenuItem('Add Backup Folder...');
        addFolderItem.connect('activate', () => this._showAddFolderDialog());
        this._applet_context_menu.addMenuItem(addFolderItem);

        this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh Status');
        refreshItem.connect('activate', () => {
            this._fetchStatus();
            this._fetchTransfers();
        });
        this._applet_context_menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.connect('activate', () => {
            Util.spawn(['cinnamon-settings', 'applets', this.metadata.uuid]);
        });
        this._applet_context_menu.addMenuItem(prefsItem);
    }

    // ---- Helpers ----

    _formatRelativeTime(date) {
        const diff = Math.floor((new Date() - date) / 1000);
        if (diff < 60) return diff + ' seconds ago';
        if (diff < 3600) return Math.floor(diff / 60) + ' minutes ago';
        return Math.floor(diff / 3600) + ' hours ago';
    }

    _formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1073741824).toFixed(2) + ' GB';
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new JottacloudApplet(metadata, orientation, panelHeight, instanceId);
}
