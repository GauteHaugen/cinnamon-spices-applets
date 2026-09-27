// core/jottacloud_settings.js
// Cinnamon applet module - uses old-style exports

const Settings = imports.ui.settings;

function JottacloudSettings(xlet, uuid, instanceId) {
    this._init(xlet, uuid, instanceId);
}

// Inherit from AppletSettings
JottacloudSettings.prototype = {
    __proto__: Settings.AppletSettings.prototype,

    _init: function(xlet, uuid, instanceId) {
        Settings.AppletSettings.prototype._init.call(this, xlet, uuid, instanceId);
    },

    getJottaConfig: function(key) {
        // Get value from jotta-cli config
        try {
            const JottacloudApi = require('./jottacloud_api');
            return JottacloudApi.config(key);
        } catch (error) {
            global.logError('JottacloudSettings::getJottaConfig error: ' + error);
            return null;
        }
    },

    setJottaConfig: function(key, value) {
        // Set value in jotta-cli config
        try {
            const JottacloudApi = require('./jottacloud_api');
            JottacloudApi.config(key, value);
        } catch (error) {
            global.logError('JottacloudSettings::setJottaConfig error: ' + error);
        }
    }
};

// Old-style module export for Cinnamon
if (typeof module !== 'undefined') {
    module.exports = {
        JottacloudSettings: JottacloudSettings
    };
}