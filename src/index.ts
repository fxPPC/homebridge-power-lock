import {
  API,
  APIEvent,
  CharacteristicValue, // <-- Added this import for the setTargetState method
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
  HAP,
} from 'homebridge';
import mqtt, { MqttClient } from 'mqtt';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface PowerLockConfig extends PlatformConfig {
  locks: LockConfig[];
}

interface LockConfig {
  name: string;
  mode: 'mqtt' | 'command' | 'dummy';
  autoLock?: boolean;
  autoLockDelay?: number; // in seconds
  lockDelay?: number; // in seconds
  unlockDelay?: number; // in seconds
  logging?: 'debug' | 'normal' | 'minimal';
  // MQTT settings
  mqttSettings?: {
    mqttBroker: string;
    mqttPort?: number;
    mqttUsername?: string;
    mqttPassword?: string;
    mqttTopicSubscribe: string;
    mqttOpenMessage: string;
    mqttCloseMessage: string;
    mqttTopicPublish: string;
    mqttPublishOpenMessage: string;
    mqttPublishCloseMessage: string;
  };
  // Command settings
  commandSettings?: {
    openCommand: string;
    closeCommand: string;
    monitorCommand: string;
    monitorInterval: number; // in seconds
  };
}

class PowerLockAccessory {
  private service: Service;
  private readonly accessory: PlatformAccessory;
  private readonly config: LockConfig;
  private readonly log: Logger;
  private readonly api: API;
  private readonly hap: HAP;

  private isLocked: boolean;
  private targetState: boolean;

  private mqttClient?: MqttClient;
  private autoLockTimeout?: NodeJS.Timeout;
  private monitorIntervalHandle?: NodeJS.Timeout;
  private lockDelayTimeout?: NodeJS.Timeout;
  private unlockDelayTimeout?: NodeJS.Timeout;

  constructor(
    log: Logger,
    config: LockConfig,
    accessory: PlatformAccessory,
    api: API
  ) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.hap = this.api.hap;
    this.accessory = accessory;

    // Retrieve stored state or default to secured
    this.isLocked = accessory.context.isLocked !== undefined
      ? accessory.context.isLocked
      : true;
    this.targetState = accessory.context.targetState !== undefined
      ? accessory.context.targetState
      : true;

    // Store instance in accessory.context for shutdown
    this.accessory.context.instance = this;

    // Create or retrieve the LockMechanism service
    this.service =
      this.accessory.getService(this.hap.Service.LockMechanism) ||
      this.accessory.addService(this.hap.Service.LockMechanism);

    this.service.setCharacteristic(this.hap.Characteristic.Name, config.name);

    // Initialize states from stored or default values
    this.service.updateCharacteristic(
      this.hap.Characteristic.LockCurrentState,
      this.isLocked
        ? this.hap.Characteristic.LockCurrentState.SECURED
        : this.hap.Characteristic.LockCurrentState.UNSECURED
    );
    this.service.updateCharacteristic(
      this.hap.Characteristic.LockTargetState,
      this.targetState
        ? this.hap.Characteristic.LockTargetState.SECURED
        : this.hap.Characteristic.LockTargetState.UNSECURED
    );

    // Listen for target state changes
    this.service
      .getCharacteristic(this.hap.Characteristic.LockTargetState)
      .onSet(this.setTargetState.bind(this));

    // Initialize features based on mode
    this.setupMode();

    // Auto-lock
    if (this.config.autoLock) {
      this.setupAutoLock();
    }
  }

  private setupMode() {
    switch (this.config.mode) {
      case 'mqtt':
        this.setupMQTT();
        break;
      case 'command':
        this.setupCommandLine();
        break;
      case 'dummy':
      default:
        this.setupDummy();
        break;
    }
  }

  // ----- MQTT MODE -----
  private setupMQTT() {
    const mqttSettings = this.config.mqttSettings;
    if (!mqttSettings) {
      this.logError(`[${this.config.name}] MQTT settings are missing.`);
      return;
    }

    const options: mqtt.IClientOptions = {
      host: mqttSettings.mqttBroker,
      port: mqttSettings.mqttPort || 1883,
      reconnectPeriod: 5000,
    };

    // Optionally include username/password if provided
    if (mqttSettings.mqttUsername && mqttSettings.mqttUsername.trim() !== '') {
      options.username = mqttSettings.mqttUsername;
    }
    if (mqttSettings.mqttPassword && mqttSettings.mqttPassword.trim() !== '') {
      options.password = mqttSettings.mqttPassword;
    }

    this.mqttClient = mqtt.connect(options);

    this.mqttClient.on('connect', () => {
      this.logInfo(
        `[${this.config.name}] Connected to MQTT broker at ${mqttSettings.mqttBroker}:${
          mqttSettings.mqttPort || 1883
        }.`
      );
      this.mqttClient?.subscribe(mqttSettings.mqttTopicSubscribe, (err) => {
        if (err) {
          this.logError(
            `[${this.config.name}] Failed to subscribe to topic ${mqttSettings.mqttTopicSubscribe}: ${err.message}`
          );
        } else {
          this.logDebug(
            `[${this.config.name}] Subscribed to MQTT topic ${mqttSettings.mqttTopicSubscribe}.`
          );
        }
      });
    });

    this.mqttClient.on('message', (topic, message) => {
      if (topic === mqttSettings.mqttTopicSubscribe) {
        const msg = message.toString();
        if (msg === mqttSettings.mqttOpenMessage) {
          this.logDebug(`[${this.config.name}] Received MQTT open message.`);
          this.updateLockState(false, false);
        } else if (msg === mqttSettings.mqttCloseMessage) {
          this.logDebug(`[${this.config.name}] Received MQTT close message.`);
          this.updateLockState(true, false);
        }
      }
    });

    this.mqttClient.on('error', (err) => {
      if (err.message.includes('Not authorized')) {
        this.logError(
          `[${this.config.name}] MQTT authentication failed. Check username/password.`
        );
      } else {
        this.logError(`[${this.config.name}] MQTT error: ${err.message}`);
      }
    });

    this.mqttClient.on('reconnect', () => {
      this.logInfo(`[${this.config.name}] Reconnecting to MQTT broker...`);
    });
  }

  // ----- COMMAND MODE -----
  private setupCommandLine() {
    const commandSettings = this.config.commandSettings;
    if (!commandSettings) {
      this.logError(
        `[${this.config.name}] Command line settings are missing.`
      );
      return;
    }

    // Validate required
    if (
      !commandSettings.openCommand ||
      !commandSettings.closeCommand ||
      !commandSettings.monitorCommand ||
      !commandSettings.monitorInterval
    ) {
      this.logError(
        `[${this.config.name}] Missing command settings (openCommand, closeCommand, monitorCommand, monitorInterval).`
      );
      return;
    }

    // Setup monitor command at intervals
    this.monitorIntervalHandle = setInterval(async () => {
      await this.executeMonitorCommand();
    }, commandSettings.monitorInterval * 1000);

    this.logInfo(
      `[${this.config.name}] Command mode initialized with monitor interval of ${commandSettings.monitorInterval} seconds.`
    );
  }

  private async executeMonitorCommand(): Promise<void> {
    const monitorCommand = this.config.commandSettings?.monitorCommand;
    if (!monitorCommand) {
      this.logError(`[${this.config.name}] 'monitorCommand' is not defined.`);
      return;
    }

    try {
      const { stdout, stderr } = await execAsync(monitorCommand);
      if (stdout) {
        this.logDebug(
          `[${this.config.name}] monitorCommand output: ${stdout.trim()}`
        );
      }
      if (stderr) {
        this.logError(
          `[${this.config.name}] monitorCommand error output: ${stderr.trim()}`
        );
      }

      const output = stdout.trim().toLowerCase();
      let newState: boolean | null = null;

      if (output === 'open' || output === 'unsecured') {
        newState = false;
      } else if (output === 'closed' || output === 'secured') {
        newState = true;
      }

      if (newState !== null && newState !== this.isLocked) {
        this.logInfo(
          `[${this.config.name}] Monitor detected lock is now ${
            newState ? 'SECURED' : 'UNSECURED'
          }.`
        );
        this.updateLockState(newState, false);
      } else {
        this.logDebug(
          `[${this.config.name}] No state change detected from monitorCommand.`
        );
      }
    } catch (error: any) {
      this.logError(
        `[${this.config.name}] monitorCommand failed: ${error.message}`
      );
    }
  }

  // ----- DUMMY MODE -----
  private setupDummy() {
    this.logInfo(`[${this.config.name}] Running in dummy mode.`);
    // No external actions needed
  }

  // ----- STATE CHANGES -----
  private async setTargetState(value: CharacteristicValue) {
    const desiredState =
      value === this.api.hap.Characteristic.LockTargetState.SECURED;
    this.logInfo(
      `[${this.config.name}] Setting target state to ${
        desiredState ? 'SECURED' : 'UNSECURED'
      }.`
    );

    if (this.config.mode === 'command') {
      const cs = this.config.commandSettings;
      if (!cs) {
        this.logError(`[${this.config.name}] Command settings missing.`);
        return;
      }

      if (desiredState) {
        // Secure
        if (this.config.lockDelay && this.config.lockDelay > 0) {
          this.logDebug(
            `[${this.config.name}] Locking after ${this.config.lockDelay} sec.`
          );
          this.lockDelayTimeout = setTimeout(async () => {
            await this.executeCommand(cs.closeCommand, 'closeCommand');
            this.updateLockState(true, this.config.autoLock || false);
          }, this.config.lockDelay * 1000);
        } else {
          await this.executeCommand(cs.closeCommand, 'closeCommand');
          this.updateLockState(true, this.config.autoLock || false);
        }
      } else {
        // Unlock
        if (this.config.unlockDelay && this.config.unlockDelay > 0) {
          this.logDebug(
            `[${this.config.name}] Unlocking after ${this.config.unlockDelay} sec.`
          );
          this.unlockDelayTimeout = setTimeout(async () => {
            await this.executeCommand(cs.openCommand, 'openCommand');
            this.updateLockState(false, this.config.autoLock || false);
          }, this.config.unlockDelay * 1000);
        } else {
          await this.executeCommand(cs.openCommand, 'openCommand');
          this.updateLockState(false, this.config.autoLock || false);
        }
      }
    } else {
      // For MQTT or Dummy mode
      this.updateLockState(desiredState, this.config.autoLock || false);
    }
  }

  private async executeCommand(command: string, commandName: string): Promise<void> {
    if (!command) {
      this.logError(`[${this.config.name}] ${commandName} is not defined.`);
      return;
    }

    try {
      const { stdout, stderr } = await execAsync(command);
      if (stdout) {
        this.logDebug(
          `[${this.config.name}] ${commandName} output: ${stdout.trim()}`
        );
      }
      if (stderr) {
        this.logError(
          `[${this.config.name}] ${commandName} error output: ${stderr.trim()}`
        );
      }
    } catch (error: any) {
      this.logError(`[${this.config.name}] ${commandName} failed: ${error.message}`);
    }
  }

  private updateLockState(desiredState: boolean, triggerAutoLock: boolean) {
    if (desiredState === this.isLocked && this.targetState === desiredState) {
      this.logDebug(
        `[${this.config.name}] Lock already ${
          desiredState ? 'SECURED' : 'UNSECURED'
        }.`
      );
      return;
    }

    this.targetState = desiredState;
    this.service.updateCharacteristic(
      this.hap.Characteristic.LockTargetState,
      desiredState
        ? this.hap.Characteristic.LockTargetState.SECURED
        : this.hap.Characteristic.LockTargetState.UNSECURED
    );

    this.isLocked = desiredState;
    this.service.updateCharacteristic(
      this.hap.Characteristic.LockCurrentState,
      desiredState
        ? this.hap.Characteristic.LockCurrentState.SECURED
        : this.hap.Characteristic.LockCurrentState.UNSECURED
    );

    // Persist new state in accessory context
    this.accessory.context.isLocked = this.isLocked;
    this.accessory.context.targetState = this.targetState;

    this.logInfo(
      `[${this.config.name}] Lock is now ${
        desiredState ? 'SECURED' : 'UNSECURED'
      }.`
    );

    if (
      this.config.mode === 'mqtt' &&
      this.mqttClient &&
      this.config.mqttSettings?.mqttTopicPublish
    ) {
      const ms = this.config.mqttSettings;
      const message = desiredState
        ? ms.mqttPublishCloseMessage || 'closed'
        : ms.mqttPublishOpenMessage || 'opened';
      this.mqttClient.publish(ms.mqttTopicPublish, message, (err) => {
        if (err) {
          this.logError(
            `[${this.config.name}] Failed to publish MQTT message: ${err.message}`
          );
        } else {
          this.logDebug(
            `[${this.config.name}] Published MQTT message: ${message}`
          );
        }
      });
    }

    // Handle Auto-Lock
    if (triggerAutoLock && this.config.autoLock && !desiredState) {
      if (this.autoLockTimeout) {
        clearTimeout(this.autoLockTimeout);
      }
      this.autoLockTimeout = setTimeout(() => {
        this.updateLockState(true, false);
      }, (this.config.autoLockDelay || 30) * 1000);
      this.logDebug(
        `[${this.config.name}] Auto-lock in ${this.config.autoLockDelay || 30} seconds.`
      );
    }
  }

  private setupAutoLock() {
    this.logInfo(`[${this.config.name}] Auto-lock feature enabled.`);
  }

  // ----- LOGGING -----
  private logDebug(message: string) {
    if (this.config.logging === 'debug') {
      this.log.debug(message);
    }
  }

  private logInfo(message: string) {
    if (['debug', 'normal'].includes(this.config.logging || 'normal')) {
      this.log.info(message);
    }
  }

  private logError(message: string) {
    if (['debug', 'normal', 'minimal'].includes(this.config.logging || 'normal')) {
      this.log.error(message);
    }
  }

  // ----- SHUTDOWN -----
  public async shutdown() {
    this.logInfo(`[${this.config.name}] Shutting down...`);

    if (this.mqttClient) {
      this.mqttClient.end(true, () => {
        this.logInfo(`[${this.config.name}] MQTT connection closed.`);
      });
    }
    if (this.monitorIntervalHandle) {
      clearInterval(this.monitorIntervalHandle);
      this.logInfo(`[${this.config.name}] Monitor interval cleared.`);
    }
    if (this.autoLockTimeout) {
      clearTimeout(this.autoLockTimeout);
      this.logDebug(`[${this.config.name}] Auto-lock timeout cleared.`);
    }
    if (this.lockDelayTimeout) {
      clearTimeout(this.lockDelayTimeout);
      this.logDebug(`[${this.config.name}] Lock delay timeout cleared.`);
    }
    if (this.unlockDelayTimeout) {
      clearTimeout(this.unlockDelayTimeout);
      this.logDebug(`[${this.config.name}] Unlock delay timeout cleared.`);
    }
  }
}

export default class PowerLockPlatform implements DynamicPlatformPlugin {
  public readonly Service = this.api.hap.Service;
  public readonly Characteristic = this.api.hap.Characteristic;

  private readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PowerLockConfig,
    public readonly api: API
  ) {
    this.log.debug('PowerLockPlatform Init');

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.log.debug('PowerLockPlatform didFinishLaunching');
      this.discoverDevices();
    });

    this.api.on(APIEvent.SHUTDOWN, () => {
      this.log.debug('PowerLockPlatform shutdown');
      this.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  private discoverDevices() {
    if (!this.config.locks || !Array.isArray(this.config.locks)) {
      this.log.error('No locks configured.');
      return;
    }

    for (const lockConfig of this.config.locks) {
      try {
        this.validateConfig(lockConfig);
      } catch (error: any) {
        this.log.error(error.message);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(lockConfig.name);
      const existingAccessory = this.accessories.find(
        (acc) => acc.UUID === uuid
      );

      if (existingAccessory) {
        this.log.info(
          `Restoring existing accessory from cache: ${existingAccessory.displayName}`
        );
        new PowerLockAccessory(
          this.log,
          lockConfig,
          existingAccessory,
          this.api
        );
        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.log.info(`Adding new accessory: ${lockConfig.name}`);
        const accessory = new this.api.platformAccessory(
          lockConfig.name,
          uuid
        );
        new PowerLockAccessory(this.log, lockConfig, accessory, this.api);
        this.api.registerPlatformAccessories(
          'homebridge-power-lock',
          'PowerLockPlatform',
          [accessory]
        );
      }
    }
  }

  private validateConfig(lockConfig: LockConfig) {
    switch (lockConfig.mode) {
      case 'mqtt': {
        if (!lockConfig.mqttSettings) {
          throw new Error(
            `Lock "${lockConfig.name}" is missing 'mqttSettings' in config.`
          );
        }
        const m = lockConfig.mqttSettings;
        if (!m.mqttBroker) {
          throw new Error(
            `Lock "${lockConfig.name}" is missing 'mqttBroker' in MQTT settings.`
          );
        }
        if (!m.mqttTopicSubscribe) {
          throw new Error(
            `Lock "${lockConfig.name}" is missing 'mqttTopicSubscribe' in MQTT settings.`
          );
        }
        if (!m.mqttTopicPublish) {
          throw new Error(
            `Lock "${lockConfig.name}" is missing 'mqttTopicPublish' in MQTT settings.`
          );
        }
        if (
          (m.mqttUsername && !m.mqttPassword) ||
          (!m.mqttUsername && m.mqttPassword)
        ) {
          throw new Error(
            `Lock "${lockConfig.name}" must provide both 'mqttUsername' and 'mqttPassword' together.`
          );
        }
        break;
      }
      case 'command': {
        if (!lockConfig.commandSettings) {
          throw new Error(
            `Lock "${lockConfig.name}" is missing 'commandSettings' in config.`
          );
        }
        const cs = lockConfig.commandSettings;
        if (
          !cs.openCommand ||
          !cs.closeCommand ||
          !cs.monitorCommand ||
          !cs.monitorInterval
        ) {
          throw new Error(
            `Lock "${lockConfig.name}" is missing required command fields.`
          );
        }
        if (cs.monitorInterval <= 0) {
          throw new Error(
            `Lock "${lockConfig.name}" has invalid 'monitorInterval'.`
          );
        }
        break;
      }
      case 'dummy':
        // No additional validation
        break;
      default:
        throw new Error(
          `Lock "${lockConfig.name}" has invalid mode "${lockConfig.mode}".`
        );
    }

    // Validate optional delays
    if (
      lockConfig.lockDelay !== undefined &&
      (typeof lockConfig.lockDelay !== 'number' || lockConfig.lockDelay < 0)
    ) {
      throw new Error(
        `Lock "${lockConfig.name}" has invalid 'lockDelay'. Must be >= 0.`
      );
    }
    if (
      lockConfig.unlockDelay !== undefined &&
      (typeof lockConfig.unlockDelay !== 'number' || lockConfig.unlockDelay < 0)
    ) {
      throw new Error(
        `Lock "${lockConfig.name}" has invalid 'unlockDelay'. Must be >= 0.`
      );
    }

    // Validate autoLock
    if (lockConfig.autoLock) {
      if (
        lockConfig.autoLockDelay !== undefined &&
        (typeof lockConfig.autoLockDelay !== 'number' ||
          lockConfig.autoLockDelay <= 0)
      ) {
        throw new Error(
          `Lock "${lockConfig.name}" has invalid 'autoLockDelay'. Must be > 0.`
        );
      }
    }

    // Validate logging
    const validLogging = ['debug', 'normal', 'minimal'];
    if (
      lockConfig.logging !== undefined &&
      !validLogging.includes(lockConfig.logging)
    ) {
      throw new Error(
        `Lock "${lockConfig.name}" has invalid 'logging'. Valid: ${validLogging.join(
          ', '
        )}.`
      );
    }
  }

  private shutdown() {
    this.log.debug('PowerLockPlatform shutdown initiated.');

    for (const accessory of this.accessories) {
      const instance = accessory.context.instance as PowerLockAccessory;
      if (instance) {
        instance.shutdown();
      }
    }
  }
}
