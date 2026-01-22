const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const { JottacloudStatus } = require('./jottacloud_status');

const JottacloudApi = {
    /// Adds a folder to continuous backup
    add(folderPath, onSuccessCallback, onErrorCallback) {
        const command = `jotta-cli add "${folderPath}"`;

        Util.spawn_async(
            ['bash', '-c', command],
            (stdout) => {
                global.log(`JottacloudApi::add success: ${stdout}`);
                if (onSuccessCallback) onSuccessCallback(stdout);
            },
            (error) => {
                global.logError(`JottacloudApi::add error: ${error}`);
                if (onErrorCallback) onErrorCallback(error);
            }
        );
    },

    /// Archive/upload to jottacloud
    archive(source, destination, onSuccessCallback, onErrorCallback) {
        const command = `jotta-cli archive "${source}" "${destination}"`;

        Util.spawn_async(
            ['bash', '-c', command],
            (stdout) => {
                if (onSuccessCallback) onSuccessCallback(stdout);
            },
            (error) => {
                if (onErrorCallback) onErrorCallback(error);
            }
        );
    },

    /// Set or get a configuration setting
    config(key, value) {
        let command = `jotta-cli config`;

        if (key) {
            command += ` ${key}`;
            if (value !== undefined) {
                command += ` "${value}"`;
            }
        }

        try {
            let [ok, stdoutBuf, stderrBuf, exitStatus] =
                GLib.spawn_command_line_sync(command);

            if (ok && exitStatus === 0) {
                return stdoutBuf.toString().trim();
            }

            global.logError(`JottacloudApi::config failed: ${stderrBuf}`);
            throw new Error(`Failed to run config command: ${stderrBuf}`);
        } catch (error) {
            global.logError(`JottacloudApi::config error: ${error}`);
            throw error;
        }
    },

    /// Download a file or folder
    download(remotePath, localPath, onSuccessCallback, onErrorCallback) {
        const command = `jotta-cli download "${remotePath}" "${localPath}"`;

        Util.spawn_async(
            ['bash', '-c', command],
            (stdout) => {
                if (onSuccessCallback) onSuccessCallback(stdout);
            },
            (error) => {
                if (onErrorCallback) onErrorCallback(error);
            }
        );
    },

    /// List ongoing transfers and information about completed transfers
    list(onSuccessCallback, onErrorCallback) {
        Util.spawnCommandLineAsyncIO('jotta-cli list --json', (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                if (onErrorCallback) {
                    onErrorCallback(new Error(stderr || "Failed to list folders"));
                }
                return;
            }

            try {
                const data = JSON.parse(stdout);
                const folders = this.parseListResponse(data);
                if (onSuccessCallback) onSuccessCallback(folders);
            } catch (error) {
                global.logError(`JottacloudApi::list parse error: ${error}`);
                if (onErrorCallback) onErrorCallback(error);
            }
        });
    },

    /// Parse list response to extract backup folders
    parseListResponse(data) {
        const folders = [];

        if (data && data.folders) {
            data.folders.forEach(folder => {
                folders.push({
                    path: folder.path || folder.Path,
                    status: folder.status || folder.Status,
                    size: folder.size || folder.Size,
                    files: folder.files || folder.Files,
                    lastModified: folder.lastModified || folder.LastModified
                });
            });
        }

        return folders;
    },

    /// Get active transfers
    observe(onSuccessCallback, onErrorCallback) {
        Util.spawnCommandLineAsyncIO('jotta-cli observe --json --limit 10', (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                // Observe might return non-zero if no transfers, which is ok
                if (onSuccessCallback) onSuccessCallback([]);
                return;
            }

            try {
                const data = JSON.parse(stdout);
                const transfers = this.parseObserveResponse(data);
                if (onSuccessCallback) onSuccessCallback(transfers);
            } catch (error) {
                // If parsing fails, just return empty array
                if (onSuccessCallback) onSuccessCallback([]);
            }
        });
    },

    /// Parse observe response to extract transfers
    parseObserveResponse(data) {
        const transfers = [];

        if (data && data.transfers) {
            data.transfers.forEach(transfer => {
                transfers.push({
                    name: transfer.name || transfer.Name,
                    type: transfer.type || transfer.Type, // 'upload' or 'download'
                    progress: transfer.progress || transfer.Progress || 0,
                    speed: transfer.speed || transfer.Speed || 0,
                    size: transfer.size || transfer.Size || 0,
                    eta: transfer.eta || transfer.ETA,
                    status: transfer.status || transfer.Status
                });
            });
        }

        return transfers;
    },

    /// Login to Jottacloud
    login(username, password, onSuccessCallback, onErrorCallback) {
        // Use stdin to pass password securely
        const command = `echo "${password}" | jotta-cli login "${username}"`;

        Util.spawn_async(
            ['bash', '-c', command],
            (stdout) => {
                global.log("JottacloudApi::login success");
                if (onSuccessCallback) onSuccessCallback(stdout);
            },
            (error) => {
                global.logError(`JottacloudApi::login error: ${error}`);
                if (onErrorCallback) onErrorCallback(error);
            }
        );
    },

    /// Logout from Jottacloud
    logout(onSuccessCallback, onErrorCallback) {
        Util.spawn_async(
            ['jotta-cli', 'logout'],
            (stdout) => {
                if (onSuccessCallback) onSuccessCallback(stdout);
            },
            (error) => {
                if (onErrorCallback) onErrorCallback(error);
            }
        );
    },

    /// List the contents of a backed up folder
    ls(path, onSuccessCallback, onErrorCallback) {
        const command = path ? `jotta-cli ls "${path}"` : 'jotta-cli ls';

        Util.spawnCommandLineAsyncIO(command, (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                if (onErrorCallback) {
                    onErrorCallback(new Error(stderr || "Failed to list directory"));
                }
                return;
            }

            if (onSuccessCallback) onSuccessCallback(stdout);
        });
    },

    /// Pause jottad or an individual backup
    pause(path) {
        const command = path ? `jotta-cli pause "${path}"` : 'jotta-cli pause';
        Util.spawnCommandLine(command);
    },

    /// Stop backing up a current backup folder
    rem(folderPath, onSuccessCallback, onErrorCallback) {
        const command = `jotta-cli rem "${folderPath}"`;

        Util.spawn_async(
            ['bash', '-c', command],
            (stdout) => {
                global.log(`JottacloudApi::rem success: ${stdout}`);
                if (onSuccessCallback) onSuccessCallback(stdout);
            },
            (error) => {
                global.logError(`JottacloudApi::rem error: ${error}`);
                if (onErrorCallback) onErrorCallback(error);
            }
        );
    },

    /// Resume jottad or an individual backup if paused
    resume(path) {
        const command = path ? `jotta-cli resume "${path}"` : 'jotta-cli resume';
        Util.spawnCommandLine(command);
    },

    /// Trigger a scan of one or more backup folders
    scan(paths, onSuccessCallback, onErrorCallback) {
        let command = 'jotta-cli scan';
        if (paths && paths.length > 0) {
            command += ' ' + paths.map(p => `"${p}"`).join(' ');
        }

        Util.spawn_async(
            ['bash', '-c', command],
            (stdout) => {
                if (onSuccessCallback) onSuccessCallback(stdout);
            },
            (error) => {
                if (onErrorCallback) onErrorCallback(error);
            }
        );
    },

    /// Generate a public url for a single file
    share(filePath, onSuccessCallback, onErrorCallback) {
        const command = `jotta-cli share "${filePath}"`;

        Util.spawnCommandLineAsyncIO(command, (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                if (onErrorCallback) {
                    onErrorCallback(new Error(stderr || "Failed to share file"));
                }
                return;
            }

            // Extract URL from output
            const urlMatch = stdout.match(/https?:\/\/[^\s]+/);
            const shareUrl = urlMatch ? urlMatch[0] : stdout.trim();

            if (onSuccessCallback) onSuccessCallback(shareUrl);
        });
    },

    /// Shows you the state of the system right now
    status(onSuccessCallback, onErrorCallback) {
        global.log('JottacloudApi::status starting');

        Util.spawnCommandLineAsyncIO('jotta-cli status --json', (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                global.logError('JottacloudApi::status failed with exit code: ' + exitCode);

                // Check if CLI is not installed
                if (stderr && stderr.includes('command not found')) {
                    const status = new JottacloudStatus({ cliInstalled: false });
                    if (onSuccessCallback) onSuccessCallback(status);
                } else if (onErrorCallback) {
                    onErrorCallback(new Error(stderr || "Status check failed"));
                }
                return;
            }

            global.log('JottacloudApi::status completed successfully');
            const status = this.parseStatusResponse(stdout);
            if (onSuccessCallback) onSuccessCallback(status);
        });
    },

    /// Parse status response
    parseStatusResponse(statusResponse) {
        let json;

        if (!statusResponse || statusResponse.includes('command not found')) {
            json = { cliInstalled: false };
        } else {
            try {
                json = JSON.parse(statusResponse);
            } catch (error) {
                global.logError('JottacloudApi::parseStatusResponse error: ' + error);
                json = { parseError: true };
            }
        }

        return new JottacloudStatus(json);
    },

    /// Manage the sync folder
    sync(action, path, onSuccessCallback, onErrorCallback) {
        let command = 'jotta-cli sync';

        if (action) {
            command += ` ${action}`;
            if (path) {
                command += ` "${path}"`;
            }
        }

        Util.spawnCommandLineAsyncIO(command, (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                if (onErrorCallback) {
                    onErrorCallback(new Error(stderr || "Sync command failed"));
                }
                return;
            }

            if (onSuccessCallback) onSuccessCallback(stdout);
        });
    },

    /// Watch the logfile stream
    tail(lines, onDataCallback) {
        const command = lines ? `jotta-cli tail -n ${lines}` : 'jotta-cli tail';

        // This would need a different approach for continuous streaming
        // For now, just get the last N lines
        Util.spawnCommandLineAsyncIO(command, (stdout, stderr, exitCode) => {
            if (exitCode === 0 && onDataCallback) {
                onDataCallback(stdout);
            }
        });
    },

    /// Manage your remote trashcan
    trash(action, path, onSuccessCallback, onErrorCallback) {
        let command = 'jotta-cli trash';

        if (action) {
            command += ` ${action}`;
            if (path) {
                command += ` "${path}"`;
            }
        }

        Util.spawnCommandLineAsyncIO(command, (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                if (onErrorCallback) {
                    onErrorCallback(new Error(stderr || "Trash command failed"));
                }
                return;
            }

            if (onSuccessCallback) onSuccessCallback(stdout);
        });
    },

    /// Show version information
    version(onSuccessCallback, onErrorCallback) {
        Util.spawnCommandLineAsyncIO('jotta-cli version', (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                if (onErrorCallback) {
                    onErrorCallback(new Error(stderr || "Version check failed"));
                }
                return;
            }

            // Parse version from output
            const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);
            const version = versionMatch ? versionMatch[1] : stdout.trim();

            if (onSuccessCallback) onSuccessCallback(version);
        });
    },

    /// Open jottacloud website
    web() {
        Util.spawnCommandLine("jotta-cli web");
    },

    /// Get account information
    account(onSuccessCallback, onErrorCallback) {
        Util.spawnCommandLineAsyncIO('jotta-cli account', (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                if (onErrorCallback) {
                    onErrorCallback(new Error(stderr || "Account info failed"));
                }
                return;
            }

            if (onSuccessCallback) onSuccessCallback(stdout);
        });
    },

    /// Get device information
    devices(onSuccessCallback, onErrorCallback) {
        Util.spawnCommandLineAsyncIO('jotta-cli devices', (stdout, stderr, exitCode) => {
            if (exitCode !== 0) {
                if (onErrorCallback) {
                    onErrorCallback(new Error(stderr || "Devices info failed"));
                }
                return;
            }

            if (onSuccessCallback) onSuccessCallback(stdout);
        });
    },

    /// Check if CLI is installed
    isInstalled(onResultCallback) {
        Util.spawnCommandLineAsyncIO('which jotta-cli', (stdout, stderr, exitCode) => {
            const installed = exitCode === 0 && stdout.trim().length > 0;
            if (onResultCallback) onResultCallback(installed);
        });
    }
};

// Export for use in other modules
module.exports = { JottacloudApi };