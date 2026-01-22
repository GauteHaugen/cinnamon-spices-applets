const Applet = imports.ui.applet;
const Util = imports.misc.util;
const Settings = imports.ui.settings;
const { JottacloudApi } = require('./core/jottacloud_api');
const { JottacloudSettings } = require('./core/jottacloud_settings');
const { JottacloudStatus } = require('./core/jottacloud_status');

// The main applet class
class JottacloudApplet extends Applet.TextIconApplet {
    #popupMenuManager;
    #popupMenu;

    // Context Menu Items
    #contextMenuItems = {
        startSync: new Applet.MenuItem("Start Sync", "media-playback-start", () => this.runSyncCommand("start")),
        pauseSync: new Applet.MenuItem("Pause Sync", "media-playback-pause", () => this.runSyncCommand("pause")),
        stopSync: new Applet.MenuItem("Stop Sync", "process-stop", () => this.runSyncCommand("stop")),
        reloadStatus: new Applet.MenuItem("Reload Status", "view-refresh", () => this.checkJottaStatus()),
    };

    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        global.logError("JottacloudApplet:: Starting applet");

        this.set_applet_icon_symbolic_name("cloud");
        this.set_applet_tooltip("Loading Jottacloud status...");
        this.set_applet_label("Loading...");

        // State object
        this.jottacloudState = new JottacloudStatus({});

        // Settings
        this.settings = new JottacloudSettings(this, metadata.uuid, instanceId);
        this.jottacloudExecutable = "jotta-cli";

        // Initialize
        this.init();

        // Build right-click context menu
        this.buildContextMenu();

        // Prepare PopupMenuManager for dynamic menus
        const PopupMenu = imports.ui.popupMenu;
        this.#popupMenuManager = new PopupMenu.PopupMenuManager(this);
    }

    on_applet_clicked(event) {
        try {
            const PopupMenu = imports.ui.popupMenu;
            const Main = imports.ui.main;

            // If already open, close and destroy
            if (this.#popupMenu) {
                this.#popupMenu.close();
                return true;
            }

            // Create popup menu on click
            this.#popupMenu = new PopupMenu.PopupMenu(this.actor, imports.gi.St.Side.TOP);

            // Account Info
            this.#popupMenu.addMenuItem(new PopupMenu.PopupIndicatorMenuItem('User Information', {
                hover: false,
                activate: false,
                focusOnHover: false,
                sensitive: false,
                reactive: false,
            }));
            const userItem = new PopupMenu.PopupIndicatorMenuItem(this.jottacloudState.userState.userState, {
                hover: false,
                activate: false,
                focusOnHover: false,
            });
            this.#popupMenu.addMenuItem(userItem);

            this.#popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // SyncStatus indicator
            this.#popupMenu.addMenuItem(new PopupMenu.PopupIndicatorMenuItem('Sync Status', {
                hover: false,
                activate: false,
                focusOnHover: false,
                sensitive: false,
                reactive: false,
            }));
            const statusItem = new PopupMenu.PopupIndicatorMenuItem(this.jottacloudState.syncState.syncState, {
                hover: false,
                activate: false,
                focusOnHover: false,
            });
            this.#popupMenu.addMenuItem(statusItem);

            this.#popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // BackupStatus indicator
            this.#popupMenu.addMenuItem(new PopupMenu.PopupIndicatorMenuItem('Backup Status', {
                hover: false,
                activate: false,
                focusOnHover: false,
                sensitive: false,
                reactive: false,
            }));
            const backupStatusItem = new PopupMenu.PopupIndicatorMenuItem(this.jottacloudState.backupState.enabled ? 'Backup running' : 'No folders added to backup yet', {
                hover: false,
                activate: false,
                focusOnHover: false,
            });
            this.#popupMenu.addMenuItem(backupStatusItem);

            this.#popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Device Info
            this.#popupMenu.addMenuItem(new PopupMenu.PopupIndicatorMenuItem('Device Info', {
                hover: false,
                activate: false,
                focusOnHover: false,
                sensitive: false,
                reactive: false,
            }));
            const deviceInfoItem = new PopupMenu.PopupIndicatorMenuItem(this.jottacloudState.userState.device.deviceState, {
                hover: false,
                activate: false,
                focusOnHover: false,
            });
            this.#popupMenu.addMenuItem(deviceInfoItem);

            // Separator + open web action
            this.#popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.#popupMenu.addMenuItem(
                new Applet.MenuItem(
                    "Open Jottacloud",
                    "external-link-symbolic",
                    () => JottacloudApi.web()
                )
            );

            // Last status call
            this.#popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            global.log(`Jottacloud::OnAppletClicked:: Adding Last Updated: ${this.jottacloudStatusUpdated}`);
            const lastStatusItem = new PopupMenu.PopupIndicatorMenuItem('Last updated: ' + this.jottacloudStatusUpdated.toLocaleString(), {
                hover: false,
                activate: false,
                focusOnHover: false,
            });
            this.#popupMenu.addMenuItem(lastStatusItem);

            // Add to UI and manage
            Main.uiGroup.add_actor(this.#popupMenu.actor);
            this.#popupMenuManager.addMenu(this.#popupMenu);

            // Update on open, destroy on close
            this.#popupMenu.connect('open-state-changed', (menu, isOpen) => {
                if (isOpen) {
                    global.log(`Jottacloud::OnAppletClicked:: Adding Last Updated: ${this.jottacloudStatusUpdated}`);
                    userItem.label.set_text(this.jottacloudState.userState.userState);
                    statusItem.label.set_text(this.jottacloudState.syncState.syncState);
                    backupStatusItem.label.set_text(this.jottacloudState.backupState.backupState);
                    deviceInfoItem.label.set_text(this.jottacloudState.userState.device.name);
                    lastStatusItem.label.set_text('Last updated: ' + this.jottacloudStatusUpdated.toLocaleString());
                } else {
                    this.#popupMenuManager.removeMenu(menu);
                    Main.uiGroup.remove_actor(menu.actor);
                    this.#popupMenu = null;
                }
            });

            this.#popupMenu.open();
        } catch (reason) {
            global.logError(reason);
            global.logError(reason.stack);
        }
        return true;
    }

    // Initialize the applet
    init() {
        this.checkJottaStatus();

        setInterval(this.checkJottaStatus.bind(this), 10_000);
    }

    // Render logic
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
                global.log(`JottacloudStatusUpdated: ${this.jottacloudStatusUpdated}`);

                this.render();
            },
            (error) => {
                global.logError("JottacloudApplet:: CLI not found or failed.");
                this.jottacloudState.parseError = true;
                this.jottacloudStatusUpdated = new Date();
                this.render();
            }
        );
    }

    // Parse sync status
    parseStatus(output) {
        if (output.includes("Sync is not enabled")) {
            this.#contextMenuItems.startSync.setSensitive(false);
            this.#contextMenuItems.pauseSync.setSensitive(false);
            this.#contextMenuItems.stopSync.setSensitive(false);
            return "Sync is not enabled";
        }
        if (output.includes("Syncing")) return "Syncing";
        if (output.includes("Paused")) return "Paused";
        if (output.includes("Stopped")) return "Stopped";
        return "Unknown";
    }

    parseBackupStatus(output) {
        if (output.includes('No folders added to backup yet')) {
            return 'No folders added to backup yet';
        }

        return 'Backup running';
    }

    // Build right-click context menu
    buildContextMenu() {
        this._applet_context_menu.addMenuItem(this.#contextMenuItems.startSync);
        this._applet_context_menu.addMenuItem(this.#contextMenuItems.pauseSync);
        this._applet_context_menu.addMenuItem(this.#contextMenuItems.stopSync);
        this._applet_context_menu.addMenuItem(new imports.ui.popupMenu.PopupSeparatorMenuItem());
        this._applet_context_menu.addMenuItem(this.#contextMenuItems.reloadStatus);
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
            },
            (error) => {
                global.logError(`Sync action '${action}' failed: ${error.message}`);
            }
        );
    }
}

// Entry point
function main(metadata, orientation, panelHeight, instanceId) {
    return new JottacloudApplet(metadata, orientation, panelHeight, instanceId);
}
