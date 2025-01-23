# homebridge-power-lock

[![npm version](https://badge.fury.io/js/homebridge-power-lock.svg)](https://badge.fury.io/js/homebridge-power-lock)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A modern, fully-featured Homebridge plugin for creating virtual lock accessories. Build from the ground up to follow modern coding practices, be Homebridge v2 ready, and provide many options. I created this plugin after discovering all the other virtual lock plugins were either hopelessly outdated or missing needed features.

---

## Table of Contents

- [Introduction](#introduction)
- [Features](#features)
  - [Multiple Modes](#multiple-modes)
  - [Advanced State Management](#advanced-state-management)
  - [Auto-Lock](#auto-lock)
  - [Delayed Locking/Unlocking](#delayed-lockingunlocking)
  - [Logging](#logging)
  - [Multiple Locks](#multiple-locks)
  - [Graceful Shutdown](#graceful-shutdown)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [Install via npm](#install-via-npm)
- [Configuration](#configuration)
  - [Modes Overview](#modes-overview)
  - [User-Defined Options](#user-defined-options)
  - [Example Configuration](#example-configuration)
- [Usage](#usage)
  - [Lock/Unlock Controls](#lockunlock-controls)
  - [Auto-Lock and Delays](#auto-lock-and-delays)
- [Security Considerations](#security-considerations)
- [Contributing](#contributing)
- [License](#license)
- [Support and Contact](#support-and-contact)

---

## Introduction

**homebridge-power-lock** is a **virtual lock** plugin for Homebridge, created by **Alice (fxPPC)**. It allows you to define locks that operate in different ways, ideal for integrating hardware, third-party systems, or even just a “dummy” lock for testing.

This plugin is under active development, with the goal of meeting Homebridge's **Scoped and Verified** standards to ensure reliability, security, and best practices. Despite its ongoing evolution, it’s already feature-rich and suitable for most use-cases.

---

## Features

### Multiple Modes

1. **MQTT Mode**  
   - Connects to an MQTT broker (supports authentication).  
   - Subscribes to a topic to receive commands (e.g., “open” or “close”).  
   - Publishes state changes to another topic so external systems can track lock status.

2. **Linux Command Line Mode**  
   - Executes user-defined shell commands for locking (`closeCommand`) and unlocking (`openCommand`).  
   - Monitors lock state using a user-defined `monitorCommand`, triggered at a specified interval.  
   - Ideal for interfacing with scripts, local hardware, or other OS services.

3. **Dummy Mode**  
   - Creates a virtual lock that doesn’t interact with external systems.  
   - Useful for testing automation or placeholders where a physical lock doesn’t exist.

### Advanced State Management

- Maintains lock state (`LockCurrentState` and `LockTargetState`) consistently in HomeKit.  
- **Persistent Storage**: Uses `accessory.context` to remember the lock’s current and target states across Homebridge restarts.

### Auto-Lock

- **Optional Feature**: Enable auto-lock with a user-defined delay (`autoLockDelay`).  
- The lock automatically transitions from unlocked to locked after the specified delay, providing additional security.

### Delayed Locking/Unlocking

- **User-Defined Delays**: `lockDelay` and `unlockDelay` let you introduce a custom wait time before performing lock/unlock actions in Command or MQTT modes.  
- Ideal for timed workflows or hardware that requires a short delay to prepare for locking/unlocking.

### Logging

- **Configurable Verbosity**: Choose from `debug`, `normal`, or `minimal` logging levels.  
- Facilitates monitoring and troubleshooting. Debug mode provides detailed output for investigating issues.

### Multiple Locks

- Configure **any number of locks** within the same Homebridge instance, each with its own settings and mode.  
- Compatible with **child bridge** setups for greater scalability or organizational preferences.

### Graceful Shutdown

- Cleans up MQTT connections, intervals, and timeouts when Homebridge stops, preventing resource leaks.  
- Ensures a stable environment, even after multiple restarts.

---

## Installation

### Prerequisites

- **Homebridge** >= 1.6.0  
- **Node.js** >= 14.17.0  
- An internet connection if using MQTT or external commands.

### Install via npm

Run the following command to install globally:

```bash
sudo npm install -g homebridge-power-lock
```

## Configuration

Below are the primary **user-defined options**, organised by the plugin’s three operating modes. Each mode has its own unique configuration settings, while some parameters are common across all modes.

---

### Modes Overview

- **MQTT Mode**  
  Integrate with an MQTT broker to publish lock states and subscribe to lock commands.

- **Linux Command Line Mode**  
  Execute custom shell commands to lock/unlock and periodically monitor lock status.

- **Dummy Mode**  
  Create a purely virtual lock without any external integration or commands.

---

### Common Options (All Modes)

| **Option**          | **Description**                                                                            | **Default**   |
|---------------------|--------------------------------------------------------------------------------------------|---------------|
| **name**            | The display name of the lock in HomeKit.                                                  | *(Required)*  |
| **mode**            | Which mode to run (`mqtt`, `command`, or `dummy`).                                        | *(Required)*  |
| **autoLock**        | Whether to enable auto-lock (`true` / `false`).                                           | `false`       |
| **autoLockDelay**   | Delay in seconds before the lock automatically locks itself (if `autoLock` is `true`).    | `30`          |
| **lockDelay**       | Delay (in seconds) before locking.                                                        | `0`           |
| **unlockDelay**     | Delay (in seconds) before unlocking.                                                      | `0`           |
| **logging**         | Log verbosity: `debug`, `normal`, `minimal`.                                              | `normal`      |

---

### MQTT Mode Settings

If you set `"mode": "mqtt"`, the lock’s behaviour is configured via the following **`mqttSettings`** object:

| **Option**                  | **Description**                                                                               | **Default**           |
|----------------------------|-----------------------------------------------------------------------------------------------|-----------------------|
| **mqttBroker**             | Address of the MQTT broker (e.g., `mqtt://localhost`).                                       | `mqtt://localhost`    |
| **mqttPort**               | Port of the MQTT broker.                                                                     | `1883`                |
| **mqttUsername**           | *(Optional)* Username for broker authentication.                                             | `""` (empty)          |
| **mqttPassword**           | *(Optional)* Password for broker authentication.                                             | `""` (empty)          |
| **mqttTopicSubscribe**     | Topic to subscribe to for lock commands.                                                     | `home/lock/command`   |
| **mqttOpenMessage**        | Message that indicates an **unlock** command.                                                | `open`                |
| **mqttCloseMessage**       | Message that indicates a **lock** command.                                                   | `close`               |
| **mqttTopicPublish**       | Topic to publish lock state changes to.                                                      | `home/lock/state`     |
| **mqttPublishOpenMessage** | Message published when lock transitions to **unlocked**.                                     | `opened`              |
| **mqttPublishCloseMessage**| Message published when lock transitions to **locked**.                                       | `closed`              |

**Notes:**
- MQTT username/password can be omitted if the broker doesn’t require authentication.
- If `mqttUsername` is provided, `mqttPassword` should also be provided (and vice versa).

---

### Linux Command Line Mode Settings

If you set `"mode": "command"`, the lock’s behaviour is defined through **`commandSettings`**:

| **Option**           | **Description**                                                                                  | **Default** |
|----------------------|------------------------------------------------------------------------------------------------|------------|
| **openCommand**      | Shell command to **unlock** the lock.                                                          | *(None)*   |
| **closeCommand**     | Shell command to **lock** the lock.                                                            | *(None)*   |
| **monitorCommand**   | Shell command that should output the lock state (`open`, `closed`, `unsecured`, `secured`).    | *(None)*   |
| **monitorInterval**  | Interval (in seconds) to run the monitor command and update the lock state if changed.         | `60`       |

**Notes:**
- Use `monitorCommand` to keep HomeKit’s lock state in sync with external hardware or system conditions.
- Outputs should be **lowercase**: `open`, `closed`, `unsecured`, or `secured`.

---

### Dummy Mode

If you set `"mode": "dummy"`, there are **no additional settings** needed. The lock is purely virtual and does not run any external commands or communicate over MQTT.

---

### Example Configuration

Below is a sample `config.json` snippet illustrating how you might configure multiple locks with different modes:

```json
{
  "platforms": [
    {
      "platform": "PowerLockPlatform",
      "locks": [
        {
          "name": "Front Door Lock",
          "mode": "mqtt",
          "autoLock": true,
          "autoLockDelay": 30,
          "lockDelay": 5,
          "unlockDelay": 5,
          "logging": "normal",
          "mqttSettings": {
            "mqttBroker": "mqtt://localhost",
            "mqttPort": 1883,
            "mqttUsername": "mqttuser",
            "mqttPassword": "mqttpass",
            "mqttTopicSubscribe": "home/lock/command",
            "mqttOpenMessage": "open",
            "mqttCloseMessage": "close",
            "mqttTopicPublish": "home/lock/state",
            "mqttPublishOpenMessage": "opened",
            "mqttPublishCloseMessage": "closed"
          }
        },
        {
          "name": "Garage Lock",
          "mode": "command",
          "autoLock": false,
          "lockDelay": 0,
          "unlockDelay": 0,
          "logging": "debug",
          "commandSettings": {
            "openCommand": "echo 'unlocking garage'",
            "closeCommand": "echo 'locking garage'",
            "monitorCommand": "echo 'closed'",
            "monitorInterval": 60
          }
        },
        {
          "name": "Test Dummy Lock",
          "mode": "dummy",
          "autoLock": false,
          "logging": "minimal"
        }
      ]
    }
  ]
}
```
### Configuration Validation

- The plugin automatically **validates** your configuration at startup.
- If any **required fields** are missing or set incorrectly (for instance, a negative `monitorInterval` or an invalid `lockDelay`), the plugin will log errors and **skip initialization** of that lock.
- Detailed error messages in the Homebridge logs guide you to correct configuration issues promptly.
- Ensure all required properties (e.g., `mqttSettings` for MQTT mode) and valid numeric ranges (e.g., non-negative `lockDelay` and `unlockDelay`) are set.
