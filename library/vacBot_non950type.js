const dictionary = require('./ecovacsConstants_non950type');
const vacBotCommand = require('./vacBotCommand_non950type');
const errorCodes = require('./errorCodes');
const tools = require('./tools');

class VacBot_non950type {
  constructor(user, hostname, resource, secret, vacuum, continent, server_address = null) {
    this.vacuum = vacuum;
    this.clean_status = null;
    this.deebot_position = {
      x: null,
      y: null,
      a: null,
      invalid: 0
    };
    this.charge_position = {
      x: null,
      y: null,
      a: null
    };
    this.lastAreaValues = null;
    this.fan_speed = null;
    this.charge_status = null;
    this.battery_status = null;
    this.water_level = null;
    this.dustbox_info = null;
    this.waterbox_info = null;
    this.sleep_status = null;
    this.components = {};
    this.ping_interval = null;
    this.error_event = null;
    this.netInfoIP = null;
    this.netInfoWifiSSID = null;
    this.cleanSum_totalSquareMeters = null;
    this.cleanSum_totalSeconds = null;
    this.cleanSum_totalNumber = null;

    this.ecovacs = null;
    this.useMqtt = (vacuum['company'] === 'eco-ng') ? true : false;
    this.deviceClass = vacuum['class'];

    if (!this.useMqtt) {
      tools.envLog("[VacBot] Using EcovacsXMPP");
      const EcovacsXMPP = require('./ecovacsXMPP.js');
      this.ecovacs = new EcovacsXMPP(this, user, hostname, resource, secret, continent, vacuum, server_address);
    } else {
      tools.envLog("[VacBot] Using EcovacsIOTMQ");
      const EcovacsMQTT = require('./ecovacsMQTT.js');
      this.ecovacs = new EcovacsMQTT(this, user, hostname, resource, secret, continent, vacuum, server_address);
    }

    this.ecovacs.on("ready", () => {
      tools.envLog("[VacBot] Ready event!");
    });
  }

  isSupportedDevice() {
    const devices = JSON.parse(JSON.stringify(tools.getSupportedDevices()));
    return devices.hasOwnProperty(this.deviceClass);
  }

  isKnownDevice() {
    const devices = JSON.parse(JSON.stringify(tools.getKnownDevices()));
    return devices.hasOwnProperty(this.deviceClass) || this.isSupportedDevice();
  }

  getDeviceProperty(property) {
    const devices = JSON.parse(JSON.stringify(tools.getAllKnownDevices()));
    if (devices.hasOwnProperty(this.deviceClass)) {
      const device = devices[this.deviceClass];
      if (device.hasOwnProperty(property)) {
        return device[property];
      }
    }
    return false;
  }

  hasMainBrush() {
    return this.getDeviceProperty('main_brush');
  }

  hasSpotAreas() {
    return this.getDeviceProperty('spot_area');
  }

  hasCustomAreas() {
    return this.getDeviceProperty('custom_area');
  }

  hasMoppingSystem() {
    return this.getDeviceProperty('mopping_system');
  }

  hasVoiceReports() {
    return this.getDeviceProperty('voice_report');
  }

  connect_and_wait_until_ready() {
    this.ecovacs.connect_and_wait_until_ready();
    this.ping_interval = setInterval(() => {
      this.ecovacs.send_ping(this._vacuum_address());
    }, 30000);
  }

  on(name, func) {
    this.ecovacs.on(name, func);
  }

  _handle_life_span(event) {
    let type = null;
    if (event.hasOwnProperty('type')) {
      // type attribute must be trimmed because of Deebot M88
      // { td: 'LifeSpan', type: 'DustCaseHeap ', ... }
      type = event['type'].trim();
      type = dictionary.COMPONENT_FROM_ECOVACS[type];
    }

    if (!type) {
      console.error("[VacBot] Unknown component type: ", event);
      return;
    }

    let lifespan = null;
    if ((event.hasOwnProperty('val')) && (event.hasOwnProperty('total'))) {
      lifespan = parseInt(event['val']) / parseInt(event['total']) * 100;
    } else if (event.hasOwnProperty('val')) {
      lifespan = parseInt(event['val']) / 100;
    } else if (event.hasOwnProperty('left') && (event.hasOwnProperty('total'))) {
      lifespan = parseInt(event['left']) / parseInt(event['total']) * 100; // This works e.g. for a Ozmo 930
    } else if (event.hasOwnProperty('left')) {
      lifespan = parseInt(event['left']) / 60; // This works e.g. for a D901
    }
    if (lifespan) {
      tools.envLog("[VacBot] lifespan %s: %s", type, lifespan);
      this.components[type] = lifespan;
    }
    tools.envLog("[VacBot] lifespan components: ", JSON.stringify(this.components));
  }

  _handle_net_info(event) {
    if (event.hasOwnProperty('wi')) {
      this.netInfoIP = event['wi'];
      tools.envLog("[VacBot] *** netInfoIP = %s", this.netInfoIP);
    }
    if (event.hasOwnProperty('s')) {
      this.netInfoWifiSSID = event['s'];
      tools.envLog("[VacBot] *** netInfoWifiSSID = %s", this.netInfoWifiSSID);
    }
  }

  _handle_clean_report(event) {
    if (event.attrs) {
      let type = event.attrs['type'];
      if (dictionary.CLEAN_MODE_FROM_ECOVACS[type]) {
        type = dictionary.CLEAN_MODE_FROM_ECOVACS[type];
      }
      let statustype = null;
      if (event.attrs['st']) {
        statustype = dictionary.CLEAN_ACTION_FROM_ECOVACS[event.attrs['st']];
      }
      else if (event.attrs['act']) {
        statustype = dictionary.CLEAN_ACTION_FROM_ECOVACS[event.attrs['act']];
      }
      if (statustype === 'stop' || statustype === 'pause') {
        type = statustype
      }
      this.clean_status = type;
      tools.envLog("[VacBot] *** clean_status = " + this.clean_status);

      if (event.attrs.hasOwnProperty('p')) {
        let pValues = event.attrs['p'];
        const pattern = /^-?[0-9]+\.?[0-9]*,-?[0-9]+\.?[0-9]*,-?[0-9]+\.?[0-9]*,-?[0-9]+\.?[0-9]*$/;
        if (pattern.test(pValues)) {
          const x1 = parseFloat(pValues.split(",")[0]).toFixed(1);
          const y1 = parseFloat(pValues.split(",")[1]).toFixed(1);
          const x2 = parseFloat(pValues.split(",")[2]).toFixed(1);
          const y2 = parseFloat(pValues.split(",")[3]).toFixed(1);
          this.lastAreaValues = x1 + ',' + y1 + ',' + x2 + ',' + y2;
          tools.envLog("[VacBot] *** lastAreaValues = " + pValues);
        } else {
          tools.envLog("[VacBot] *** lastAreaValues invalid pValues = " + pValues);
        }
      }

      if (event.attrs.hasOwnProperty('speed')) {
        let fan = event.attrs['speed'];
        if (dictionary.FAN_SPEED_FROM_ECOVACS[fan]) {
          fan = dictionary.FAN_SPEED_FROM_ECOVACS[fan];
          this.fan_speed = fan;
          tools.envLog("[VacBot] fan speed: ", fan);
        } else {
          tools.envLog("[VacBot] Unknown fan speed: ", fan);
        }
      } else {
        tools.envLog("[VacBot] couldn't parse clean report ", event);
      }
    }
  }

  _handle_battery_info(event) {
    let value = null;
    if (event.hasOwnProperty('ctl')) {
      value = event['ctl']['battery']['power'];
    } else {
      value = parseFloat(event.attrs['power']);
    }
    try {
      this.battery_status = value;
      tools.envLog("[VacBot] *** battery_status = %d\%", this.battery_status);
    } catch (e) {
      console.error("[VacBot] couldn't parse battery status ", event);
    }
  }

  _handle_water_level(event) {
    if ((event.attrs) && (event.attrs.hasOwnProperty('v'))) {
      this.water_level = event.attrs['v'];
      tools.envLog("[VacBot] *** water_level = %s", this.water_level);
    }
  }

  _handle_deebot_position(event) {
    if ((event.attrs) && (event.attrs.hasOwnProperty('p')) && (event.attrs.hasOwnProperty('a'))) {
      this.deebot_position = {
        x: event.attrs['p'].split(",")[0],
        y: event.attrs['p'].split(",")[1],
        a: event.attrs['a']
      };
      tools.envLog("[VacBot] *** deebot_position = %s", JSON.stringify(this.deebot_position));
    }
  }

  _handle_charge_position(event) {
    if ((event.attrs) && (event.attrs.hasOwnProperty('p')) && (event.attrs.hasOwnProperty('a'))) {
      this.charge_position = {
        x: event.attrs['p'].split(",")[0],
        y: event.attrs['p'].split(",")[1],
        a: event.attrs['a']
      };
      tools.envLog("[VacBot] *** charge_position = %s", JSON.stringify(this.charge_position));
    }
  }

  _handle_dustbox_info(event) {
    if ((event.attrs) && (event.attrs.hasOwnProperty('st'))) {
      this.dustbox_info = event.attrs['st'];
      tools.envLog("[VacBot] *** dustbox_info = " + this.dustbox_info);
    }
  }

  _handle_waterbox_info(event) {
    if ((event.attrs) && (event.attrs.hasOwnProperty('on'))) {
      this.waterbox_info = event.attrs['on'];
      tools.envLog("[VacBot] *** waterbox_info = " + this.waterbox_info);
    }
  }

  _handle_sleep_status(event) {
    if ((event.attrs) && (event.attrs.hasOwnProperty('st'))) {
      this.sleep_status = event.attrs['st'];
      tools.envLog("[VacBot] *** sleep_status = " + this.sleep_status);
    }
  }

  _handle_charge_state(event) {
    if ((event.attrs) && (event.attrs['type'])) {
      let chargemode = event.attrs['type'];
      if (dictionary.CHARGE_MODE_FROM_ECOVACS[chargemode]) {
        this.charge_status = dictionary.CHARGE_MODE_FROM_ECOVACS[chargemode];
        tools.envLog("[VacBot] *** charge_status = " + this.charge_status)
      } else {
        console.error("[VacBot] Unknown charging status '%s'", chargemode);
      }
    } else {
      console.error("[VacBot] couldn't parse charge status ", event);
    }
  }

  _handle_cleanSum(event) {
    if ((event.attrs) && (event.attrs.hasOwnProperty('a')) && (event.attrs.hasOwnProperty('l')) && (event.attrs.hasOwnProperty('c'))) {
      this.cleanSum_totalSquareMeters = parseInt(event.attrs['a']);
      this.cleanSum_totalSeconds = parseInt(event.attrs['l']);
      this.cleanSum_totalNumber = parseInt(event.attrs['c']);
    }
  }

  _handle_error(event) {
    let errorCode = null;
    if (event.hasOwnProperty('code')) {
      errorCode = event['code'];
    }
    if ((!errorCode) && (event.hasOwnProperty('errno'))) {
      errorCode = event['errno'];
    }
    if ((!errorCode) && (event.hasOwnProperty('new'))) {
      errorCode = event['new'];
      if ((errorCode == '') && (event['old'] !== '')) {
        this.error_event = '';
        return;
      }
    }
    if ((!errorCode) && (event.hasOwnProperty('error'))) {
      errorCode = event['error'];
    }
    if ((!errorCode) && (event.hasOwnProperty('errs'))) {
      errorCode = event['errs'];
    }
    if (errorCode) {
      // NoError: Robot is operational
      if (errorCode == '100') {
        this.error_event = '';
        return;
      }
      if (errorCodes[errorCode]) {
        this.error_event = errorCodes[errorCode];
      } else {
        this.error_event = 'unknown errorCode: ' + errorCode;
      }
    }
  }

  _vacuum_address() {
    if (!this.useMqtt) {
      return this.vacuum['did'] + '@' + this.vacuum['class'] + '.ecorobot.net/atom';
    } else {
      return this.vacuum['did'];
    }
  }

  send_command(action) {
    tools.envLog("[VacBot] Sending command `%s`", action.name);
    if (!this.useMqtt) {
      this.ecovacs.send_command(action.to_xml(), this._vacuum_address());
    } else {
      // IOTMQ issues commands via RestAPI, and listens on MQTT for status updates
      // IOTMQ devices need the full action for additional parsing
      this.ecovacs.send_command(action, this._vacuum_address());
    }
  }

  send_ping() {
    try {
      if (!this.useMqtt) {
        this.ecovacs.send_ping(this._vacuum_address());
      } else if (this.useMqtt) {
        if (!this.ecovacs.send_ping()) {
          throw new Error("Ping did not reach VacBot");
        }
      }
    } catch (e) {
      throw new Error("Ping did not reach VacBot");
    }
  }

  run(action) {
    tools.envLog("[VacBot] action: %s", action);

    switch (action.toLowerCase()) {
      case "clean":
        if (arguments.length <= 1) {
          this.send_command(new vacBotCommand.Clean());
        } else if (arguments.length === 2) {
          this.send_command(new vacBotCommand.Clean(arguments[1]));
        } else {
          this.send_command(new vacBotCommand.Clean(arguments[1], arguments[2]));
        }
        break;
      case "edge":
        this.send_command(new vacBotCommand.Edge());
        break;
      case "spot":
        this.send_command(new vacBotCommand.Spot());
        break;
      case "spotarea":
        if (arguments.length < 3) {
          return;
        }
        this.send_command(new vacBotCommand.SpotArea(arguments[1], arguments[2]));
        break;
      case "customarea":
        if (arguments.length < 4) {
          return;
        }
        this.send_command(new vacBotCommand.CustomArea(arguments[1], arguments[2], arguments[3]));
        break;
      case "stop":
        this.send_command(new vacBotCommand.Stop());
        break;
      case "pause":
        this.send_command(new vacBotCommand.Pause());
        break;
      case "resume":
        this.send_command(new vacBotCommand.Resume());
        break;
      case "charge":
        this.send_command(new vacBotCommand.Charge());
        break;
      case "playsound":
        if (arguments.length <= 1) {
          this.send_command(new vacBotCommand.PlaySound());
        } else if (arguments.length === 2) {
          this.send_command(new vacBotCommand.PlaySound(arguments[1]));
        }
        break;
      case "getdeviceinfo":
      case "deviceinfo":
        this.send_command(new vacBotCommand.GetDeviceInfo());
        break;
      case "getcleanstate":
      case "cleanstate":
        this.send_command(new vacBotCommand.GetCleanState());
        break;
      case "getcleanspeed":
      case "cleanspeed":
        this.send_command(new vacBotCommand.GetCleanSpeed());
        break;
      case "getchargestate":
      case "chargestate":
        this.send_command(new vacBotCommand.GetChargeState());
        break;
      case "getbatterystate":
      case "batterystate":
        this.send_command(new vacBotCommand.GetBatteryState());
        break;
      case "getlifespan":
      case "lifespan":
        if (arguments.length < 2) {
          return;
        }
        let component = arguments[1];
        this.send_command(new vacBotCommand.GetLifeSpan(component));
        break;
      case "getwaterlevel":
        this.send_command(new vacBotCommand.GetWaterLevel());
        break;
      case "setwaterlevel":
        if (arguments.length < 2) {
          return;
        }
        this.send_command(new vacBotCommand.SetWaterLevel(arguments[1]));
        break;
      case "getwaterboxinfo":
        this.send_command(new vacBotCommand.GetWaterBoxInfo());
        break;
      case "getfirmwareversion":
        this.send_command(new vacBotCommand.GetFirmwareVersion());
        break;
      case "getnetinfo":
        this.send_command(new vacBotCommand.GetNetInfo());
        break;
      case "getpos":
      case "getposition":
        this.send_command(new vacBotCommand.GetPos());
        break;
      case "getchargepos":
      case "getchargeposition":
      case "getchargerpos":
      case "getchargerposition":
        this.send_command(new vacBotCommand.GetChargerPos());
        break;
      case "getsleepstatus":
        this.send_command(new vacBotCommand.GetSleepStatus());
        break;
      case "getcleansum":
        this.send_command(new vacBotCommand.GetCleanSum());
        break;
    }
  }

  disconnect() {
    this.ecovacs.disconnect();
  }
}

module.exports = VacBot_non950type;
