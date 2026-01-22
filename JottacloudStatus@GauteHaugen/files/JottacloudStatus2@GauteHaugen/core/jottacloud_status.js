class JottacloudStatus {
    get appletLabelText() {
        if (this.cliInstalled === false) {
            return 'Jottacloud CLI not installed';
        }

        if (this.parseError) {
            return 'Error parsing status';
        }

        if (this.userState.authenticated === false) {
            return 'Not logged in';
        }

        if (this.syncState.enabled === false) {
            return 'Sync disabled';
        }

        if (this.syncState.automatic === false) {
            return 'Sync setup to manual trigger';
        }

        return 'Syncing and up to date';
    }

    get appletTooltipText() {
        return this.appletLabelText;
    }

    get appletIconName() {
        if (this.cliInstalled === false || this.parseError || this.userState.authenticated === false) {
            return 'error';
        }

        return this.syncState.automatic ? 'cloud-check' : 'cloud';
    }

    constructor(options) {
        this.cliInstalled = options['cliInstalled'];
        this.parseError = options['parseError'];
        this.userState = new JottacloudUserState(options['User'] ?? {});
        this.syncState = new JottacloudSyncState(options['Sync'] ?? {});
        this.backupState = new JottacloudBackupState(options['Backup'] ?? {});
        this.generalState = new JottacloudGeneralState(options['State'] ?? {});
    }
}

class JottacloudUserState {
    get userState() {
        if (this.authenticated === false) {
            return 'Not logged in';
        }

        return 'Logged in as ' + this.fullname;
    }

    constructor(options) {
        this.authenticated = options['Email'] ?? false;
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
        this.background = new JottacloudUserAvatarBackgroundState(options['Background'] ?? {});
    }
}

class JottacloudUserAvatarBackgroundState {
    constructor(options) {
        this.r = options['r'];
        this.g = options['g'];
        this.b = options['b'];
    }
}

class JottacloudUserAccountInfoState {
    constructor(options) {
        this.capacity = options['Capacity'];
        this.usage = options['Usage'];
        this.subscription = options['Subscription'];
        this.upgradeHint = options['UpgradeHint'];
        this.subscriptionNameLocalized = options['SubscriptionNameLocalized'];
        this.productNameLocalized = options['ProductNameLocalized'];
    }
}

class JottacloudUserDeviceState {
    get deviceState() {
        if (this.name === undefined) {
            return 'No device';
        }

        return this.name + ' (' + this.type + ')';
    }

    constructor(options) {
        this.name = options['Name'];
        this.type = options['Type'];
    }
}

class JottacloudSyncState {
    get syncState() {
        if (this.enabled === false) {
            return 'Sync is not configured';
        }

        if (this.automatic === false) {
            return 'Sync is configured to manual trigger\nLast updated: ' + new Date(this.lastUpdateMs).toLocaleString();
        }

        return 'Sync is configured to automatic trigger\nLast updated: ' + new Date(this.lastUpdateMs).toLocaleString();
    }

    constructor(options) {
        this.enabled = options['Enabled'] ?? false;
        this.automatic = options['Automatic'];
        this.rootPath = options['RootPath'];
        this.count = new JottacloudSyncCountState(options['Count'] ?? {});
        this.remoteCount = new JottacloudSyncRemoteCountState(options['RemoteCount'] ?? {});
        this.lastUpdateMs = options['LastUpdateMS'];
    }
}

class JottacloudSyncCountState {
    constructor(options) {
        this.enabled = options['Enabled'] ?? false;
    }
}

class JottacloudSyncRemoteCountState {
    constructor(options) {}
}

class JottacloudBackupState {
    get backupState() {
        if (this.enabled === false) {
            return 'Backup is not configured';
        }
    }

    constructor(options) {
        this.enabled = options['Enabled'] ?? false;
    }
}

class JottacloudGeneralState {
    constructor(options) {
        this.restoreWorking = options['RestoreWorking'];
        this.uploading = new JottacloudGeneralUploadingState(options['Uploading'] ?? {});
        this.downloading = new JottacloudGeneralDownloadingState(options['Downloading'] ?? {});
        this.lastTokenRefresh = options['LastTokenRefresh'];
    }
}

class JottacloudGeneralUploadingState {
    constructor(options) {}
}

class JottacloudGeneralDownloadingState {
    constructor(options) {}
}