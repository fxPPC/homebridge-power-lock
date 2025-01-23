'use strict';

const { PowerLockAccessory } = require('./powerlockAccessory');

class PowerLockPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;

    if (!config) {
      this.log.warn('No configuration found for PowerLockPlatform.');
      return;
    }

    this.name = config.name || 'PowerLockPlatform';
    this.logging = config.logging || 'normal';
    this.locksConfig = config.locks || [];

    // Keep references to the accessory handlers we create
    this.accessories = [];

    // Listen for shutdown to gracefully clean up
    this.api.on('shutdown', () => {
      this.logIf('debug', 'Shutting down...');
      this.accessories.forEach((acc) => {
        // Each "acc" in this.accessories might be a PowerLockAccessory object or a cached Accessory
        // We only call .cleanup() if it's actually an instance of our handler
        if (acc && acc.cleanup) {
          acc.cleanup();
        }
      });
    });

    // When the API is ready, we can configure accessories
    this.api.on('didFinishLaunching', () => {
      this.logIf('debug', 'didFinishLaunching: Starting to configure accessories');
      this.configureAccessories();
    });
  }

  // Called by Homebridge to discover/update HomeKit accessories
  configureAccessories() {
    this.locksConfig.forEach((lockConfig) => {
      if (!lockConfig.lockName) {
        this.logIf('normal', 'Skipping lock with no lockName.');
        return;
      }

      const uuid = this.api.hap.uuid.generate(lockConfig.lockName);

      // See if we already have an accessory for this UUID
      let existingAccessory = this.accessories.find(a => a.UUID === uuid || a.accessory?.UUID === uuid);

      if (existingAccessory && existingAccessory instanceof PowerLockAccessory) {
        // Reconfigure existing one
        this.logIf('normal', `Updating existing accessory ${lockConfig.lockName}`);
        existingAccessory.configure(lockConfig);

      } else if (existingAccessory && existingAccessory.displayName) {
        // This might be a cached platformAccessory object from Homebridge
        this.logIf('normal', `Wrapping cached accessory in PowerLockAccessory: ${lockConfig.lockName}`);
        const powerLockAcc = new PowerLockAccessory(this, existingAccessory, lockConfig);
        // Replace in the array
        const index = this.accessories.indexOf(existingAccessory);
        this.accessories[index] = powerLockAcc;

      } else {
        // Create a brand new accessory
        this.logIf('normal', `Creating new accessory ${lockConfig.lockName}`);
        const newAccessory = new this.api.platformAccessory(lockConfig.lockName, uuid);
        const powerLockAcc = new PowerLockAccessory(this, newAccessory, lockConfig);

        this.api.registerPlatformAccessories('homebridge-power-lock', 'PowerLockPlatform', [newAccessory]);
        this.accessories.push(powerLockAcc);
      }
    });
  }

  // Called by Homebridge at startup for each cached accessory
  configureAccessory(accessory) {
    this.logIf('debug', `Loading accessory from cache: ${accessory.displayName}`);
    // Just store it; we’ll configure it properly in configureAccessories
    this.accessories.push(accessory);
  }

  // Helper logging method with levels: debug, normal, none
  logIf(level, message, ...args) {
    const levels = {
      none: 0,
      normal: 1,
      debug: 2,
    };
    const currentLevel = levels[this.logging] ?? 1; // default is normal
    const requiredLevel = levels[level] ?? 1;

    if (requiredLevel <= currentLevel) {
      this.log(message, ...args);
    }
  }
}

module.exports = {
  PowerLockPlatform,
};
