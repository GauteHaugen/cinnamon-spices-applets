// core/jottacloud_status.js

function _formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function _formatRelativeTime(date) {
    const diff = Math.floor((new Date() - date) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
}

class JottacloudStatus {
    constructor(options) {
        this.cliInstalled = options['cliInstalled'];
        this.parseError = options['parseError'];
        this.userState = new JottacloudUserState(options['User'] ?? {});
        this.syncState = new JottacloudSyncState(options['Sync'] ?? {});
        this.backupState = new JottacloudBackupState(options['Backup'] ?? {});
        this.generalState = new JottacloudGeneralState(options['State'] ?? {});
    }

    get isReady() {
        return this.cliInstalled !== false && !this.parseError && !!this.userState.authenticated;
    }

    get isUploading() {
        return this.generalState.isUploading;
    }

    get isDownloading() {
        return this.generalState.isDownloading;
    }

    get appletLabelText() {
        if (this.cliInstalled === false) return 'CLI not installed';
        if (this.parseError) return 'Error';
        if (!this.userState.authenticated) return 'Not logged in';
        if (!this.syncState.enabled) return 'Sync disabled';
        if (this.isUploading && this.isDownloading) return 'Up/downloading...';
        if (this.isUploading) return 'Uploading...';
        if (this.isDownloading) return 'Downloading...';
        if (!this.syncState.automatic) return 'Manual sync';
        return 'Up to date';
    }

    get appletTooltipText() {
        if (this.cliInstalled === false) return 'jotta-cli not installed';
        if (this.parseError) return 'Jottacloud: error reading status';
        if (!this.userState.authenticated) return 'Jottacloud: not logged in';

        const lines = [];
        lines.push(this.userState.fullname + ' · ' + this.userState.accountInfo.usageText);
        if (this.syncState.enabled) {
            lines.push('Sync: ' + this.syncState.statusSummary);
        }
        if (this.backupState.enabled) {
            lines.push('Backup: active on ' + (this.backupState.deviceName || 'this device'));
        }
        return lines.join('\n');
    }

    get appletIconName() {
        if (this.cliInstalled === false || this.parseError) return 'dialog-error-symbolic';
        if (!this.userState.authenticated) return 'network-offline-symbolic';
        if (this.isUploading || this.isDownloading) return 'emblem-synchronizing-symbolic';
        if (!this.syncState.enabled || !this.syncState.automatic) return 'media-playback-pause-symbolic';
        return 'emblem-default-symbolic';
    }
}

class JottacloudUserState {
    constructor(options) {
        this.authenticated = options['Email'] ? options['Email'] : false;
        this.email = options['Email'];
        this.fullname = options['Fullname'];
        this.avatar = new JottacloudUserAvatarState(options['Avatar'] ?? {});
        this.brand = options['Brand'];
        this.hostName = options['Hostname'];
        this.accountInfo = new JottacloudUserAccountInfoState(options['AccountInfo'] ?? {});
        this.device = new JottacloudUserDeviceState(options['device'] ?? {});
    }
}

class JottacloudUserAvatarState {
    constructor(options) {
        this.initials = options['Initials'];
        this.background = options['Background'] ?? {};
    }
}

class JottacloudUserAccountInfoState {
    constructor(options) {
        this.capacity = options['Capacity'] ?? -1;
        this.usage = options['Usage'] ?? 0;
        this.subscription = options['Subscription'];
        this.upgradeHint = options['UpgradeHint'];
        this.subscriptionName = options['SubscriptionNameLocalized'];
        this.productName = options['ProductNameLocalized'];
    }

    get usageText() {
        if (!this.usage) return 'Unknown';
        const usedStr = _formatBytes(this.usage);
        if (this.capacity <= 0) return usedStr + ' / Unlimited';
        const totalStr = _formatBytes(this.capacity);
        const pct = Math.round((this.usage / this.capacity) * 100);
        return usedStr + ' / ' + totalStr + ' (' + pct + '%)';
    }

    get usagePercent() {
        if (!this.usage || !this.capacity || this.capacity <= 0) return -1;
        return Math.round((this.usage / this.capacity) * 100);
    }

    get isNearlyFull() {
        const pct = this.usagePercent;
        return pct >= 0 && pct >= 90;
    }
}

class JottacloudUserDeviceState {
    constructor(options) {
        this.name = options['Name'];
        this.type = options['Type'];
    }
}

class JottacloudSyncState {
    constructor(options) {
        this.enabled = options['Enabled'] ?? false;
        this.automatic = options['Automatic'];
        this.rootPath = options['RootPath'];
        this.count = options['Count'] ? new JottacloudSyncCount(options['Count']) : null;
        this.remoteCount = options['RemoteCount'] ? new JottacloudSyncCount(options['RemoteCount']) : null;
        this.folderCount = options['FolderCount'];
        this.lastUpdateMs = options['LastUpdateMS'];
    }

    get statusSummary() {
        if (!this.enabled) return 'Not configured';
        if (!this.automatic) return 'Manual mode';
        if (this.lastUpdateMs) return 'Up to date · ' + _formatRelativeTime(new Date(this.lastUpdateMs));
        return 'Automatic';
    }

    get lastSyncText() {
        if (!this.lastUpdateMs) return 'Never';
        return new Date(this.lastUpdateMs).toLocaleString();
    }

    get localFilesText() {
        if (!this.count || !this.count.files) return 'Unknown';
        return this.count.files + ' files (' + _formatBytes(this.count.bytes) + ')';
    }

    get isInSync() {
        if (!this.count || !this.remoteCount) return true;
        return this.count.files === this.remoteCount.files && this.count.bytes === this.remoteCount.bytes;
    }

    get syncDeltaText() {
        if (!this.count || !this.remoteCount) return '';
        return this.count.files + ' local / ' + this.remoteCount.files + ' remote';
    }
}

class JottacloudSyncCount {
    constructor(options) {
        this.files = options['Files'] ?? 0;
        this.bytes = options['Bytes'] ?? 0;
    }
}

class JottacloudBackupState {
    constructor(options) {
        // JSON: { "State": { "Enabled": { "deviceName": "..." } } }
        const state = options['State'] ?? {};
        const enabled = state['Enabled'];
        this.enabled = enabled != null && typeof enabled === 'object';
        this.deviceName = enabled ? enabled['deviceName'] : null;
    }
}

class JottacloudGeneralState {
    constructor(options) {
        this.restoreWorking = options['RestoreWorking'];
        this.uploading = options['Uploading'] ?? {};
        this.downloading = options['Downloading'] ?? {};
        this.lastTokenRefresh = options['LastTokenRefresh'];
    }

    get isUploading() {
        return this.uploading && Object.keys(this.uploading).length > 0;
    }

    get isDownloading() {
        return this.downloading && Object.keys(this.downloading).length > 0;
    }
}

if (typeof module !== 'undefined') {
    module.exports = { JottacloudStatus };
}
