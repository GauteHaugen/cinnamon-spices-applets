const Settings = imports.ui.settings;

const { JottacloudApi } = require('./core/jottacloud_api');

class JottacloudSettings extends Settings.AppletSettings {
    constructor(xlet, uuid, instanceId) {
        super(xlet, uuid, instanceId);
    }

    getValue(key) {
        return JottacloudApi.config(key);
    }

    setValue(key, value) {
        JottacloudApi.config(key, value);
    }
}
