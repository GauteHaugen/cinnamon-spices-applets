const Applet = imports.ui.applet;
const Util = imports.misc.util;
const Settings = imports.ui.settings;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const ModalDialog = imports.ui.modalDialog;

const { JottacloudApi } = require('./core/jottacloud_api');
const { JottacloudSettings } = require('./core/jottacloud_settings');
const { JottacloudStatus } = require('./core/jottacloud_status');

// Custom dialog for folder selection
class FolderSelectionDialog extends ModalDialog.ModalDialog {
    constructor(onSelectCallback) {
        super();
        this.onSelectCallback = onSelectCallback;

        this.setButtons([
            {
                label: "Cancel",
                action: () => this.close(),
                key: Clutter.KEY_Escape
            },
            {
                label: "Select",
                action: () => this._onSelect(),
                default: true
            }
        ]);

        let content = new St.BoxLayout({ vertical: true, style_class: 'folder-dialog-content' });

        let label = new St.Label({
            text: "Select a folder to backup:",
            style: 'font-weight: bold; padding-bottom: 10px;'
        });
        content.add(label);

        this.folderEntry = new St.Entry({
            style: 'min-width: 400px; padding: 5px;',
            hint_text: "/path/to/folder"
        });
        content.add(this.folderEntry);

        let browseButton = new St.Button({
            label: "Browse...",
            style: 'margin-top: 10px;'
        });
        browseButton.connect('clicked', () => this._browseFolder());
        content.add(browseButton);

        this.contentLayout.add_child(content);
    }

    _browseFolder() {
        // Use file chooser dialog via zenity or similar
        Util.spawn_async(['zenity', '--file-selection', '--directory'],
            (folder) => {
                if (folder) {
                    this.folderEntry.set_text(folder.trim());
                }
            }
        );
    }

    _onSelect() {
        const folder = this.folderEntry.get_text();
        if (folder && this.onSelectCallback) {
            this.onSelectCallback(folder);
        }
        this.close();
    }
}

// Main applet class
class JottacloudApplet extends Applet.TextIconApplet {
    #popupMenuManager;
    #popupMenu;
    #updateTimer;
    #backupFolders = [];
    #transfers = [];

    // Context Menu Items
    #contextMenuItems = {
        startSync: null,
        pauseSync: null,
        stopSync: null,
        reloadStatus: null,
        addFolder: null,
        preferences: null
    };

    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        global.log("JottacloudApplet:: Starting applet v" + metadata.version);

        this.metadata = metadata;
        this.orientation = orientation;
        this.instanceId = instanceId;

        // Initialize applet appearance
        this.set_applet_icon_symbolic_name("cloud");
        this.set_applet_tooltip("Initializing Jottacloud...");
        this.set_applet_label("...");

        // State and settings
        this.jottacloudState = new JottacloudStatus({});
        this.settings = new JottacloudSettings(this, metadata.uuid, instanceId);
        this.jottacloudExecutable = "jotta-cli";

        // Initialize status updater
        this.jottacloudStatusUpdated = new Date();
        this.updateInterval = 10000; // 10 seconds

        // Initialize components
        this.init();
        this.buildContextMenu();

        // Prepare PopupMenuManager
        this.#popupMenuManager = new PopupMenu.PopupMenuManager(this);
    }

    on_applet_clicked(event) {
        try {
            // Toggle popup menu
            if (this.#popupMenu) {
                this.#popupMenu.close();
                return true;
            }

            // Create new popup menu
            this.#popupMenu = new PopupMenu.PopupMenu(this.actor, St.Side.TOP);

            // Build menu structure
            this._buildPopupMenu();

            // Add to UI and manage
            Main.uiGroup.add_actor(this.#popupMenu.actor);
            this.#popupMenuManager.addMenu(this.#popupMenu);

            // Handle menu lifecycle
            this.#popupMenu.connect('open-state-changed', (menu, isOpen) => {
                if (isOpen) {
                    this._updatePopupMenuContent();
                } else {
                    this.#popupMenuManager.removeMenu(menu);
                    Main.uiGroup.remove_actor(menu.actor);
                    this.#popupMenu = null;
                }
            });

            this.#popupMenu.open();
        } catch (error) {
            global.logError("JottacloudApplet::on_applet_clicked error: " + error);
            global.logError(error.stack);
        }
        return true;
    }

    _buildPopupMenu() {
        // Account section
        this._addMenuSection("Account", "user-info-symbolic");
        this._accountMenuItem = this._addInfoItem(
            this.jottacloudState.userState.userState,
            this.jottacloudState.userState.email || "Not logged in"
        );

        // Storage usage bar if logged in
        if (this.jottacloudState.userState.authenticated) {
            this._addStorageBar();
        }

        this.#popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Sync Status section
        this._addMenuSection("Sync Status", "emblem-synchronizing-symbolic");
        this._syncStatusItem = this._addInfoItem(
            this.jottacloudState.syncState.syncState,
            this.jottacloudState.syncState.rootPath || "Not configured"
        );

        // Sync controls
        if (this.jottacloudState.syncState.enabled) {
            this._addSyncControls();
        }

        this.#popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Backup section
        this._addMenuSection("Backup", "folder-symbolic");
        this._backupStatusItem = this._addInfoItem(
            this.jottacloudState.backupState.enabled ? 'Active' : 'Inactive',
            this._getBackupSummary()
        );

        // Backup folders list
        if (this.#backupFolders.length > 0) {
            this._addBackupFoldersList();
        }

        // Add folder button
        let addFolderItem = new PopupMenu.PopupMenuItem("+ Add folder to backup");
        addFolderItem.connect('activate', () => this._showAddFolderDialog());
        this.#popupMenu.addMenuItem(addFolderItem);

        this.#popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Active transfers section (if any)
        if (this.#transfers.length > 0) {
            this._addTransfersSection();
            this.#popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // Actions section
        let webItem = new PopupMenu.PopupMenuItem("Open Jottacloud Web");
        webItem.connect('activate', () => JottacloudApi.web());
        this.#popupMenu.addMenuItem(webItem);

        let prefsItem = new PopupMenu.PopupMenuItem("Preferences");
        prefsItem.connect('activate', () => this._openPreferences());
        this.#popupMenu.addMenuItem(prefsItem);

        // Footer with last update
        this.#popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._lastUpdateItem = this._addInfoItem(
            "Last updated",
            this._getTimeSinceUpdate()
        );
    }

    _addMenuSection(title, iconName) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let box = new St.BoxLayout({ style_class: 'popup-menu-section' });

        if (iconName) {
            let icon = new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon'
            });
            box.add_child(icon);
        }

        let label = new St.Label({
            text: title,
            style: 'font-weight: bold;'
        });
        box.add_child(label);

        item.actor.add_child(box);
        this.#popupMenu.addMenuItem(item);
    }

    _addInfoItem(label, value) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let box = new St.BoxLayout({
            style_class: 'popup-menu-info-item',
            vertical: false
        });

        let labelWidget = new St.Label({
            text: label,
            style: 'min-width: 120px;'
        });
        box.add_child(labelWidget);

        let valueWidget = new St.Label({
            text: value,
            style: 'color: #999;'
        });
        box.add_child(valueWidget);

        item.actor.add_child(box);
        this.#popupMenu.addMenuItem(item);

        return { label: labelWidget, value: valueWidget };
    }

    _addStorageBar() {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let box = new St.BoxLayout({ vertical: true, style: 'padding: 5px;' });

        let accountInfo = this.jottacloudState.userState.accountInfo;
        if (accountInfo.capacity && accountInfo.usage) {
            let percentage = (accountInfo.usage / accountInfo.capacity) * 100;

            // Usage text
            let usageLabel = new St.Label({
                text: `${this._formatBytes(accountInfo.usage)} of ${this._formatBytes(accountInfo.capacity)} (${percentage.toFixed(1)}%)`,
                style: 'font-size: 0.9em; padding-bottom: 5px;'
            });
            box.add_child(usageLabel);

            // Progress bar
            let progressBar = new St.DrawingArea({
                style: 'height: 8px; background-color: #333; border-radius: 4px;',
                reactive: false
            });
            progressBar.set_width(200);

            // Fill based on percentage
            let fill = new St.Widget({
                style: `height: 8px; width: ${percentage * 2}px; background-color: #4CAF50; border-radius: 4px;`,
                reactive: false
            });
            progressBar.add_child(fill);

            box.add_child(progressBar);
        }

        item.actor.add_child(box);
        this.#popupMenu.addMenuItem(item);
    }

    _addSyncControls() {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let box = new St.BoxLayout({ style: 'padding: 5px;' });

        // Play/Pause button
        let playPauseBtn = new St.Button({
            style_class: 'button',
            child: new St.Icon({
                icon_name: this.jottacloudState.syncState.automatic ?
                    'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                icon_size: 16
            })
        });
        playPauseBtn.connect('clicked', () => {
            this.runSyncCommand(this.jottacloudState.syncState.automatic ? 'pause' : 'start');
        });
        box.add_child(playPauseBtn);

        // Stop button
        let stopBtn = new St.Button({
            style_class: 'button',
            child: new St.Icon({
                icon_name: 'media-playback-stop-symbolic',
                icon_size: 16
            })
        });
        stopBtn.connect('clicked', () => this.runSyncCommand('stop'));
        box.add_child(stopBtn);

        // Refresh button
        let refreshBtn = new St.Button({
            style_class: 'button',
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                icon_size: 16
            })
        });
        refreshBtn.connect('clicked', () => this.checkJottaStatus());
        box.add_child(refreshBtn);

        item.actor.add_child(box);
        this.#popupMenu.addMenuItem(item);
    }

    _addBackupFoldersList() {
        this.#backupFolders.forEach(folder => {
            let item = new PopupMenu.PopupMenuItem(folder.path);
            item.setOrnament(PopupMenu.Ornament.NONE);

            // Add remove button
            let removeBtn = new St.Button({
                style_class: 'button',
                child: new St.Icon({
                    icon_name: 'list-remove-symbolic',
                    icon_size: 12
                })
            });
            removeBtn.connect('clicked', () => {
                this._removeBackupFolder(folder.path);
                return Clutter.EVENT_STOP;
            });
            item.actor.add_child(removeBtn);

            this.#popupMenu.addMenuItem(item);
        });
    }

    _addTransfersSection() {
        this._addMenuSection("Active Transfers", "network-transmit-receive-symbolic");

        this.#transfers.slice(0, 5).forEach(transfer => {
            let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            let box = new St.BoxLayout({ vertical: true, style: 'padding: 5px;' });

            // File name
            let nameLabel = new St.Label({
                text: transfer.name,
                style: 'font-size: 0.9em;'
            });
            box.add_child(nameLabel);

            // Progress
            let progressLabel = new St.Label({
                text: `${transfer.progress}% - ${this._formatBytes(transfer.speed)}/s`,
                style: 'font-size: 0.8em; color: #999;'
            });
            box.add_child(progressLabel);

            item.actor.add_child(box);
            this.#popupMenu.addMenuItem(item);
        });

        if (this.#transfers.length > 5) {
            let moreItem = new PopupMenu.PopupMenuItem(`... and ${this.#transfers.length - 5} more`);
            moreItem.setSensitive(false);
            this.#popupMenu.addMenuItem(moreItem);
        }
    }

    _updatePopupMenuContent() {
        // Update dynamic content
        if (this._accountMenuItem) {
            this._accountMenuItem.label.set_text(this.jottacloudState.userState.userState);
            this._accountMenuItem.value.set_text(this.jottacloudState.userState.email || "Not logged in");
        }

        if (this._syncStatusItem) {
            this._syncStatusItem.label.set_text(this.jottacloudState.syncState.syncState);
            this._syncStatusItem.value.set_text(this.jottacloudState.syncState.rootPath || "Not configured");
        }

        if (this._backupStatusItem) {
            this._backupStatusItem.label.set_text(
                this.jottacloudState.backupState.enabled ? 'Active' : 'Inactive'
            );
            this._backupStatusItem.value.set_text(this._getBackupSummary());
        }

        if (this._lastUpdateItem) {
            this._lastUpdateItem.value.set_text(this._getTimeSinceUpdate());
        }
    }

    _showAddFolderDialog() {
        let dialog = new FolderSelectionDialog((folder) => {
            this._addBackupFolder(folder);
        });
        dialog.open();
    }

    _addBackupFolder(folderPath) {
        JottacloudApi.add(folderPath,
            () => {
                global.log(`Added backup folder: ${folderPath}`);
                this.checkJottaStatus();
                Main.notify("Jottacloud", `Added ${folderPath} to backup`);
            },
            (error) => {
                global.logError(`Failed to add backup folder: ${error}`);
                Main.notifyError("Jottacloud", `Failed to add folder: ${error.message}`);
            }
        );
    }

    _removeBackupFolder(folderPath) {
        JottacloudApi.rem(folderPath,
            () => {
                global.log(`Removed backup folder: ${folderPath}`);
                this.checkJottaStatus();
                Main.notify("Jottacloud", `Removed ${folderPath} from backup`);
            },
            (error) => {
                global.logError(`Failed to remove backup folder: ${error}`);
                Main.notifyError("Jottacloud", `Failed to remove folder: ${error.message}`);
            }
        );
    }

    _openPreferences() {
        Util.spawn(['cinnamon-settings', 'applets', this.metadata.uuid]);
    }

    _getBackupSummary() {
        if (this.#backupFolders.length === 0) {
            return "No folders configured";
        }
        return `${this.#backupFolders.length} folder${this.#backupFolders.length > 1 ? 's' : ''} backing up`;
    }

    _getTimeSinceUpdate() {
        const now = new Date();
        const diff = now - this.jottacloudStatusUpdated;
        const seconds = Math.floor(diff / 1000);

        if (seconds < 60) return `${seconds} seconds ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
        return `${Math.floor(seconds / 86400)} days ago`;
    }

    _formatBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }

    // Initialize the applet
    init() {
        this.checkJottaStatus();

        // Set up periodic status updates
        this.#updateTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this.updateInterval / 1000,
            () => {
                this.checkJottaStatus();
                return GLib.SOURCE_CONTINUE;
            }
        );

        // Get initial backup folders list
        this.loadBackupFolders();
    }

    // Load backup folders
    loadBackupFolders() {
        JottacloudApi.list((folders) => {
            this.#backupFolders = folders || [];
            global.log(`Loaded ${this.#backupFolders.length} backup folders`);
        });
    }

    // Load active transfers
    loadTransfers() {
        JottacloudApi.observe((transfers) => {
            this.#transfers = transfers || [];
        });
    }

    // Render applet appearance
    render() {
        this.set_applet_label(this.jottacloudState.appletLabelText);
        this.set_applet_tooltip(this.jottacloudState.appletTooltipText);
        this.set_applet_icon_symbolic_name(this.jottacloudState.appletIconName);
    }

    // Check Jottacloud status
    checkJottaStatus() {
        JottacloudApi.status(
            (newState) => {
                this.jottacloudState = newState;
                this.jottacloudStatusUpdated = new Date();

                // Load additional data
                this.loadBackupFolders();
                this.loadTransfers();

                this.render();

                // Update popup if open
                if (this.#popupMenu && this.#popupMenu.isOpen) {
                    this._updatePopupMenuContent();
                }
            },
            (error) => {
                global.logError("JottacloudApplet:: Status check failed: " + error);
                this.jottacloudState.parseError = true;
                this.jottacloudStatusUpdated = new Date();
                this.render();
            }
        );
    }

    // Build right-click context menu
    buildContextMenu() {
        // Create menu items
        this.#contextMenuItems.startSync = new PopupMenu.PopupMenuItem("Start Sync");
        this.#contextMenuItems.startSync.connect('activate', () => this.runSyncCommand("start"));

        this.#contextMenuItems.pauseSync = new PopupMenu.PopupMenuItem("Pause Sync");
        this.#contextMenuItems.pauseSync.connect('activate', () => this.runSyncCommand("pause"));

        this.#contextMenuItems.stopSync = new PopupMenu.PopupMenuItem("Stop Sync");
        this.#contextMenuItems.stopSync.connect('activate', () => this.runSyncCommand("stop"));

        this.#contextMenuItems.addFolder = new PopupMenu.PopupMenuItem("Add Backup Folder");
        this.#contextMenuItems.addFolder.connect('activate', () => this._showAddFolderDialog());

        this.#contextMenuItems.reloadStatus = new PopupMenu.PopupMenuItem("Reload Status");
        this.#contextMenuItems.reloadStatus.connect('activate', () => this.checkJottaStatus());

        this.#contextMenuItems.preferences = new PopupMenu.PopupMenuItem("Preferences");
        this.#contextMenuItems.preferences.connect('activate', () => this._openPreferences());

        // Add to context menu
        this._applet_context_menu.addMenuItem(this.#contextMenuItems.startSync);
        this._applet_context_menu.addMenuItem(this.#contextMenuItems.pauseSync);
        this._applet_context_menu.addMenuItem(this.#contextMenuItems.stopSync);
        this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._applet_context_menu.addMenuItem(this.#contextMenuItems.addFolder);
        this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._applet_context_menu.addMenuItem(this.#contextMenuItems.reloadStatus);
        this._applet_context_menu.addMenuItem(this.#contextMenuItems.preferences);
    }

    // Execute sync commands
    runSyncCommand(action) {
        const commands = {
            start: `${this.jottacloudExecutable} resume`,
            pause: `${this.jottacloudExecutable} pause`,
            stop: `${this.jottacloudExecutable} stop`,
        };

        if (!commands[action]) {
            global.logError(`Unknown sync action: ${action}`);
            return;
        }

        Util.spawn_async(
            commands[action].split(' '),
            () => {
                global.log(`Sync '${action}' completed.`);
                this.checkJottaStatus();
                Main.notify("Jottacloud", `Sync ${action} completed`);
            },
            (error) => {
                global.logError(`Sync action '${action}' failed: ${error.message}`);
                Main.notifyError("Jottacloud", `Sync ${action} failed`);
            }
        );
    }

    // Cleanup
    on_applet_removed_from_panel() {
        if (this.#updateTimer) {
            GLib.source_remove(this.#updateTimer);
            this.#updateTimer = null;
        }

        if (this.#popupMenu) {
            this.#popupMenu.destroy();
            this.#popupMenu = null;
        }
    }
}

// Entry point
function main(metadata, orientation, panelHeight, instanceId) {
    return new JottacloudApplet(metadata, orientation, panelHeight, instanceId);
}