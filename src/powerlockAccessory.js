'use strict';

const mqtt = require('mqtt');
const { exec } = require('child_process');

class PowerLockAccessory {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.log = platform.log;
    this.logIf = platform.logIf.bind(platform);
    this.api = platform.api;
    this.accessory = accessory;

    // HomeKit HAP
    this.Characteristic = this.api.hap.Characteristic;
    this.Service = this.api.hap.Service;

    // Prepare the LockMechanism service
    this.service =
      this.accessory.getService(this.Service.LockMechanism)
      || this.accessory.addService(this.Service.LockMechanism, config.lockName, config.lockName);

    // Defaults for state
    this.currentState = this.Characteristic.LockCurrentState.SECURED;
    this.targetState = this.Characteristic.LockTargetState.SECURED;

    // Cleanup anything leftover (e.g., from a previous run) and then apply config
    this.cleanup();
    this.configure(config);

    // Setup handlers
    this.service.getCharacteristic(this.Characteristic.LockCurrentState)
      .on('get', this.handleCurrentStateGet.bind(this));

    this.service.getCharacteristic(this.Characteristic.LockTargetState)
      .on('get', this.handleTargetStateGet.bind(this))
      .on('set', this.handleTargetStateSet.bind(this));

    // Update HomeKit with initial states
    this.updateHomeKitStates();
  }

  // Called when first creating or reconfiguring the accessory
  configure(config) {
    this.lockName = config.lockName || 'Power Lock';
    this.mode = config.mode || 'dummy';
    this.autoLock = !!config.autoLock;
    this.autoLockDelay = config.autoLockDelay || 10;
    this.lockDelay = config.lockDelay || 0;
    this.unlockDelay = config.unlockDelay || 0;

    // MQTT
    this.mqttBrokerUrl = config.mqttBrokerUrl || '';
    this.mqttUsername = config.mqttUsername || '';
    this.mqttPassword = config.mqttPassword || '';
    this.mqttTopic = config.mqttTopic || '';
    this.mqttMessageOpen = config.mqttMessageOpen || 'OPEN';
    this.mqttMessageClosed = config.mqttMessageClosed || 'CLOSED';
    this.mqttMessageSendOpen = config.mqttMessageSendOpen || 'UNLOCK';
    this.mqttMessageSendClosed = config.mqttMessageSendClosed || 'LOCK';

    // CMD
    this.cmdPollInterval = config.cmdPollInterval || 0;
    this.cmdPollCommand = config.cmdPollCommand || '';
    this.cmdLockCommand = config.cmdLockCommand || '';
    this.cmdUnlockCommand = config.cmdUnlockCommand || '';

    // Service name
    this.service.setCharacteristic(this.Characteristic.Name, this.lockName);

    // If user reconfigures after running, cleanup old intervals/sockets if any
    this.cleanup();

    // Setup relevant mode
    if (this.mode === 'mqtt') {
      this.setupMqtt();
    } else if (this.mode === 'cmd') {
      this.setupCommandPolling();
    }
  }

  // Cleanup function to gracefully stop timers, intervals, and MQTT clients
  cleanup() {
    // Clear poll interval if any
    if (this.pollIntervalObj) {
      clearInterval(this.pollIntervalObj);
      this.pollIntervalObj = null;
    }

    // Clear auto-lock timer
    if (this.autoLockTimeout) {
      clearTimeout(this.autoLockTimeout);
      this.autoLockTimeout = null;
    }

    // Clear lock/unlock delays
    if (this.lockDelayTimeout) {
      clearTimeout(this.lockDelayTimeout);
      this.lockDelayTimeout = null;
    }
    if (this.unlockDelayTimeout) {
      clearTimeout(this.unlockDelayTimeout);
      this.unlockDelayTimeout = null;
    }

    // End MQTT client if present
    if (this.mqttClient) {
      try {
        this.mqttClient.end(true);
      } catch (err) {
        // ignore
      }
      this.mqttClient = null;
    }
  }

  // ============= HomeKit Handlers =============

  handleCurrentStateGet(callback) {
    this.logIf('debug', `handleCurrentStateGet: returning ${this.currentState}`);
    callback(null, this.currentState);
  }

  handleTargetStateGet(callback) {
    this.logIf('debug', `handleTargetStateGet: returning ${this.targetState}`);
    callback(null, this.targetState);
  }

  handleTargetStateSet(value, callback) {
    this.logIf('debug', `handleTargetStateSet from ${this.targetState} to ${value}`);
    this.targetState = value;

    const { LockTargetState, LockCurrentState } = this.Characteristic;

    if (value === LockTargetState.SECURED) {
      // Lock requested
      if (this.lockDelay > 0) {
        this.clearLockUnlockDelays();
        this.lockDelayTimeout = setTimeout(() => {
          this.doLock();
        }, this.lockDelay * 1000);
      } else {
        this.doLock();
      }
    } else if (value === LockTargetState.UNSECURED) {
      // Unlock requested
      if (this.unlockDelay > 0) {
        this.clearLockUnlockDelays();
        this.unlockDelayTimeout = setTimeout(() => {
          this.doUnlock();
        }, this.unlockDelay * 1000);
      } else {
        this.doUnlock();
      }
    }

    callback(null);
  }

  clearLockUnlockDelays() {
    if (this.lockDelayTimeout) {
      clearTimeout(this.lockDelayTimeout);
      this.lockDelayTimeout = null;
    }
    if (this.unlockDelayTimeout) {
      clearTimeout(this.unlockDelayTimeout);
      this.unlockDelayTimeout = null;
    }
  }

  doLock() {
    this.logIf('debug', 'doLock triggered.');

    // If in MQTT mode, publish a lock message
    if (this.mode === 'mqtt' && this.mqttClient && this.mqttMessageSendClosed) {
      this.mqttClient.publish(this.mqttTopic, this.mqttMessageSendClosed, { qos: 1 }, (err) => {
        if (err) {
          this.logIf('normal', `MQTT lock publish error: ${err}`);
        }
      });
    }

    // If in cmd mode, run the lock command
    if (this.mode === 'cmd' && this.cmdLockCommand) {
      exec(this.cmdLockCommand, (error, stdout, stderr) => {
        if (error) {
          this.logIf('normal', `Error running lock command: ${error.message}`);
        }
      });
    }

    // Update states
    this.currentState = this.Characteristic.LockCurrentState.SECURED;
    this.targetState = this.Characteristic.LockTargetState.SECURED;
    this.updateHomeKitStates();
  }

  doUnlock() {
    this.logIf('debug', 'doUnlock triggered.');

    // If in MQTT mode, publish an unlock message
    if (this.mode === 'mqtt' && this.mqttClient && this.mqttMessageSendOpen) {
      this.mqttClient.publish(this.mqttTopic, this.mqttMessageSendOpen, { qos: 1 }, (err) => {
        if (err) {
          this.logIf('normal', `MQTT unlock publish error: ${err}`);
        }
      });
    }

    // If in cmd mode, run the unlock command
    if (this.mode === 'cmd' && this.cmdUnlockCommand) {
      exec(this.cmdUnlockCommand, (error, stdout, stderr) => {
        if (error) {
          this.logIf('normal', `Error running unlock command: ${error.message}`);
        }
      });
    }

    // Update states
    this.currentState = this.Characteristic.LockCurrentState.UNSECURED;
    this.targetState = this.Characteristic.LockTargetState.UNSECURED;
    this.updateHomeKitStates();

    // Auto-lock if enabled
    if (this.autoLock) {
      this.logIf('debug', `Starting auto-lock timer for ${this.autoLockDelay} seconds.`);
      if (this.autoLockTimeout) {
        clearTimeout(this.autoLockTimeout);
      }
      this.autoLockTimeout = setTimeout(() => {
        this.logIf('debug', 'Auto-lock timer triggered.');
        this.targetState = this.Characteristic.LockTargetState.SECURED;
        this.doLock();
      }, this.autoLockDelay * 1000);
    }
  }

  updateHomeKitStates() {
    this.logIf('debug', `updateHomeKitStates: current=${this.currentState}, target=${this.targetState}`);
    this.service.updateCharacteristic(this.Characteristic.LockCurrentState, this.currentState);
    this.service.updateCharacteristic(this.Characteristic.LockTargetState, this.targetState);
  }

  // ============= MQTT Setup =============

  setupMqtt() {
    // If missing crucial info, fall back to dummy
    if (!this.mqttBrokerUrl || !this.mqttTopic) {
      this.logIf('normal', 'MQTT mode enabled but broker URL or topic not specified. Switching to dummy mode.');
      this.mode = 'dummy';
      return;
    }

    const options = {};
    if (this.mqttUsername) {
      options.username = this.mqttUsername;
    }
    if (this.mqttPassword) {
      options.password = this.mqttPassword;
    }

    this.mqttClient = mqtt.connect(this.mqttBrokerUrl, options);
    this.logIf('normal', `Connecting to MQTT broker at ${this.mqttBrokerUrl} for topic "${this.mqttTopic}"...`);

    this.mqttClient.on('connect', () => {
      this.logIf('normal', 'MQTT connected.');
      this.mqttClient.subscribe(this.mqttTopic, { qos: 1 }, (err) => {
        if (err) {
          this.logIf('normal', `MQTT subscribe error: ${err}`);
        } else {
          this.logIf('debug', `Subscribed to topic: ${this.mqttTopic}`);
        }
      });
    });

    this.mqttClient.on('error', (err) => {
      this.logIf('normal', `MQTT error: ${err}`);
    });

    this.mqttClient.on('message', (topic, message) => {
      const msgStr = message.toString();
      this.logIf('debug', `MQTT message from ${topic}: ${msgStr}`);

      // If we see an "open" message
      if (msgStr === this.mqttMessageOpen) {
        this.currentState = this.Characteristic.LockCurrentState.UNSECURED;
        this.targetState = this.Characteristic.LockTargetState.UNSECURED;
        this.updateHomeKitStates();
      } else if (msgStr === this.mqttMessageClosed) {
        this.currentState = this.Characteristic.LockCurrentState.SECURED;
        this.targetState = this.Characteristic.LockTargetState.SECURED;
        this.updateHomeKitStates();
      }
    });

    this.mqttClient.on('close', () => {
      this.logIf('normal', 'MQTT connection closed. Will try to reconnect automatically.');
    });
  }

  // ============= Command Polling Setup =============

  setupCommandPolling() {
    // If polling is disabled or no poll command, fall back to dummy
    if (!this.cmdPollCommand || this.cmdPollInterval === 0) {
      this.logIf('normal', 'Linux command line mode enabled, but poll command or interval not specified. Switching to dummy mode.');
      this.mode = 'dummy';
      return;
    }

    this.logIf('normal', `Starting command polling: every ${this.cmdPollInterval} seconds (cmd: ${this.cmdPollCommand})`);

    this.pollIntervalObj = setInterval(() => {
      exec(this.cmdPollCommand, (error, stdout, stderr) => {
        if (error) {
          this.logIf('normal', `Error polling lock state: ${error.message}`);
          return;
        }

        const trimmed = stdout.trim().toUpperCase();
        this.logIf('debug', `Poll command result: ${trimmed}`);

        // Compare to recognized states
        // We allow "OPEN" or "CLOSED", or the custom user-defined strings
        if (trimmed === this.mqttMessageOpen.toUpperCase() || trimmed === 'OPEN') {
          this.currentState = this.Characteristic.LockCurrentState.UNSECURED;
          this.targetState = this.Characteristic.LockTargetState.UNSECURED;
        } else if (trimmed === this.mqttMessageClosed.toUpperCase() || trimmed === 'CLOSED') {
          this.currentState = this.Characteristic.LockCurrentState.SECURED;
          this.targetState = this.Characteristic.LockTargetState.SECURED;
        }

        this.updateHomeKitStates();
      });
    }, this.cmdPollInterval * 1000);
  }
}

module.exports = {
  PowerLockAccessory,
};
