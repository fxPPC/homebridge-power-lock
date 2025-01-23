'use strict';

const { API } = require('homebridge');
const { PowerLockPlatform } = require('./platform');

/**
 * This method registers the platform with Homebridge
 */
module.exports = (homebridge) => {
  const { version, PluginName, PlatformName } = {
    version: require('../package.json').version,
    PluginName: 'homebridge-power-lock',
    PlatformName: 'PowerLockPlatform',
  };

  homebridge.registerPlatform(PluginName, PlatformName, PowerLockPlatform);
};
