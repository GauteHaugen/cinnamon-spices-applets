const Util = imports.misc.util;
const { JottacloudStatus } = require('./core/jottacloud_status');

const JottacloudApi = {
    /// Adds a folder to continuous backup
    add() {

    },
    /// Archive/upload to jottacloud
    archive() {

    },
    /// Shell completion for jotta-cli
    completion() {

    },
    /// Set or get a configuration setting
    config(key, value) {
        let command = `jotta-cli config`;

        if (key) {
            command += ` ${key}`;

            if (value) {
                command += ` ${value}`;
            }
        }

        let [ok, stdoutBuf, stderrBuf, exitStatus] =
            GLib.spawn_command_line_sync(command);

        if (ok && exitStatus === 0) {
            global.logError(`JottacloudSettings: Completed config command`);
            return stdoutBuf.toString().trim();
        }

        global.logError(`JottacloudSettings: Failed to run config command`);

        throw new Error(`Failed to run config command`);
    },
    /// Download a file or folder
    download() {

    },
    /// Dump the local backupdatabase
    dump() {

    },
    /// Exclude files and folders from backup
    ignores() {

    },
    /// List ongoing transfers and information about completed transfers
    list() {

    },
    /// Print the location of the logfile
    logfile() {

    },
    /// Login. Necessary for jottad to run
    login() {

    },
    /// Logout. Resets credentials and stop backups
    logout() {

    },
    /// List the contents of a backed up folder
    ls() {

    },
    /// Observe ongoing uploads and/or downloads
    observe() {

    },
    /// Pause jottad or an individual backup
    pause() {

    },
    /// Stop backing up a current backup folder
    rem() {

    },
    /// Resume jottad or an individual backup if paused
    resume() {

    },
    /// Trigger a scan of one or more backupfolders
    scan() {

    },
    /// Generate a public url for a single file
    share() {

    },
    /// Shows you the state of the system right now
    status(onSuccessCallback, onErrorCallback) {
        global.log('JottacloudApi:: Starting status()');

        Util.spawnCommandLineAsyncIO('jotta-cli status --json', (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                global.logTrace('JottacloudApi:: Completed status() with error');

                onErrorCallback(new Error(stderr || "Unknown error"));

                return;
            }

            global.log('JottacloudApi:: Completed status() successfully');

            onSuccessCallback(JottacloudApi.parseStatusResponse(stdout));
        });
    },
    /// Manage the sync folder
    sync() {

    },
    /// Watch the logfile stream
    tail() {

    },
    /// Manage your remote trashcan
    trash() {

    },
    /// Show version information
    version() {

    },
    /// Open jottacloud website
    web() {
        Util.spawnCommandLine("jotta-cli web");
    },
    /// Manage webhooks
    webhook() {

    },
    parseStatusResponse(statusResponse) {
        let json;


        if (statusResponse === 'jotta-cli: command not found') {
            json = { cliInstalled: false };
        } else {
            try {
                json = JSON.parse(statusResponse);
            } catch (reason) {
                global.logError(reason);

                json = { parseError: true };
            }
        }

        global.log(json);

        return new JottacloudStatus(json);
    }
}
