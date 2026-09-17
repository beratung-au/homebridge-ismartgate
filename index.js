const request = require("request"),
      mdns = require('./lib/discovery'),
      deviceInfo = require('./lib/device-info');

var	  API,
	  Accessory,
	  Characteristic,
	  Service;

var cookieJar = request.jar();

module.exports = function(homebridge) {
	API = homebridge;
    Accessory = homebridge.hap.Accessory;
    Characteristic = homebridge.hap.Characteristic;
    Service = homebridge.hap.Service;

    homebridge.registerAccessory("homebridge-ismartgate", "iSmartGate", iSmartGate);
};

function iSmartGate(log, config) {
    this.log = log;
    this.name = config["name"] || "iSmartGate Temperature";
    this.username = config["username"];
    this.password = config["password"];
    this.response = null;

    this.CurrentTemperature = null;
    this.BatteryLevel = null;
    this._informationValues = {
        model: 'iSmartGate',
        serial: 'Unknown',
        firmware: require('./package.json').version
    };
    this._informationTargets = {model: new Set(), serial: new Set(), firmware: new Set()};
    this._infoRequest = null;
    this._nextInfoAt = 0;
    this._infoHost = null;
}

iSmartGate.prototype = {

    identify: function(callback) {
        this.log.info("identify");
        callback();
    },

	getServices: function() {

		// Temperature Sensor service
		this.TemperatureSensor = new Service.TemperatureSensor(this.name);

		// Battery service
        this.BatteryService = new Service.BatteryService(this.name);

		// Accessory Information service
        this.AccessoryInformation = new Service.AccessoryInformation();
        this.AccessoryInformation
            .setCharacteristic(Characteristic.Name, this.name)
            .setCharacteristic(Characteristic.Manufacturer, "iSmartGate")
            .setCharacteristic(Characteristic.Model, this._informationValues.model)
            .setCharacteristic(Characteristic.FirmwareRevision, this._informationValues.firmware)
            .setCharacteristic(Characteristic.SerialNumber, this._informationValues.serial);

        // HOOBS copies information characteristics at startup. Retain each copy
        // when its read handler runs, so later updates also refresh its cached
        // value. HAP may return that value without calling the handler again.
        const owner = this;
        [['Model', 'model'], ['FirmwareRevision', 'firmware'], ['SerialNumber', 'serial']].forEach(function(pair) {
            const characteristic = owner.AccessoryInformation.getCharacteristic(Characteristic[pair[0]]);
            owner._informationTargets[pair[1]].add(characteristic);
            characteristic.on('get', function(callback) {
                owner._informationTargets[pair[1]].add(this);
                callback(null, owner._informationValues[pair[1]]);
            });
        });
		
		// Start searching for the iSmartGate using mDNS
		var browser = mdns.createBrowser("_hap._tcp");
		browser.on('ready', function() { browser.discover(); });
		browser.on('update', function(data) {
			if(data['txt']) {
				data['txt'].forEach(txt => {
					txt = txt.split("=");
					if(txt[0] == "md" && txt[1] == "iSmartGate" && data.addresses[0] != this.hostname) {
						// Set the new hostname obtained from mDNS
						this.hostname = data.addresses[0];
						this.log.info("Found an iSmartGate at", this.hostname);
					
						// Login to the iSmartGate for the first time and refresh
						setTimeout(function() {
							this._login();
						}.bind(this), 2500);
					}
				});
			}
		}.bind(this));
		
		// Set a timer to refresh the data every 10 minutes
		setInterval(function() {
			this._refresh();
		}.bind(this), 600000);

		// Set a timer to refresh the login token every 3 hours
		setInterval(function() {
			this._login();
		}.bind(this), 10800000);
	
		// Return the Accessory
        return [
			this.AccessoryInformation,
            this.TemperatureSensor,
            this.BatteryService
        ];

    },

	_login: function() {
		request.post({
			url: "http://" + this.hostname + "/index.php",
			form: {
				"login": this.username,
				"pass": this.password,
				"send-login": "Sign in"
			},
			jar: cookieJar
		}, function(err, response, body) {
			if (!err && response.statusCode == 200) {
				this.log.info("Logged into iSmartGate succesfully");

				// Save the login headers
				this.response = response;
				
				// Refresh the data
				this._refresh();
				this._refreshDeviceInformation();
			}
			else {this.log.error("Could not login.", err, response, body);}
		}.bind(this));
	},

    _refreshDeviceInformation: function() {
        const host = this.hostname;
        if (!host || !this.username || !this.password || !this.AccessoryInformation) return;
        if (this._infoRequest && this._infoRequest.host === host) return;
        if (this._infoHost === host && Date.now() < this._nextInfoAt) return;
        const pending = {host};
        this._infoRequest = pending;
        this._infoHost = host;
        // Retry failures on the next normal sensor refresh, never on an Apple Home read.
        this._nextInfoAt = Date.now() + 600000;
        pending.promise = Promise.resolve().then(function() {
            return deviceInfo.fetchInfo(host, this.username, this.password);
        }.bind(this)).then(function(info) {
            if (this.hostname !== host || this._infoRequest !== pending) return;
            if (info.model) this._informationValues.model = info.model;
            if (info.firmware) this._informationValues.firmware = info.firmware;
            if (info.udi) this._informationValues.serial = 'UDI-' + info.udi;
            Object.keys(this._informationTargets).forEach(function(key) {
                this._informationTargets[key].forEach(function(characteristic) {
                    characteristic.updateValue(this._informationValues[key]);
                }.bind(this));
            }.bind(this));
            this._nextInfoAt = Date.now() + 10800000;
            this.log.debug('Device information refreshed.');
        }.bind(this)).catch(function() {
            if (this.hostname === host && this._infoRequest === pending) {
                this.log.debug('Device information unavailable; keeping existing information.');
            }
        }.bind(this)).finally(function() {
            if (this._infoRequest === pending) this._infoRequest = null;
        }.bind(this));
        return pending.promise;
    },

    _refresh: function() {
       this.log.debug("Start refreshing temperature & battery");

        request.get({
            url: "http://" + this.hostname + "/isg/temperature.php?door=1",
            header: this.response.headers,
            jar: cookieJar
        }, function(err, response, body) {
            if (!err && response.statusCode == 200) {
                try {body = JSON.parse(body);}
                catch(err) {
					if(body == "Restricted Access") {this.log.error("Restricted Access", body);}
					else if(body == "Login Token Expired") {this.log.error("Login Token Expired", body);}
					else {this.log.error("Could not connect.", "Check http://" + this.hostname + " to make sure the device is still reachable & no captcha is showing.");}
				}

                this.log.debug("Obtained status.", body);

                // Find the CurrentTemperature
                this.CurrentTemperature = body[0] / 1000;

                // Find the BatteryLevel
                switch (body[1]) {
                    case "full":    this.BatteryLevel = 100;    break;
                    case "80":      this.BatteryLevel = 80;     break;
                    case "60":      this.BatteryLevel = 60;     break;
                    case "40":      this.BatteryLevel = 40;     break;
                    case "20":      this.BatteryLevel = 20;     break;
                    case "low":     this.BatteryLevel = 10;     break;

                    default:
                        this.log.warn("Unexpected BatteryLevel detected.", body);
                        this.BatteryLevel = 0;
                    break;
                }
			
				// Set the Current Temperature
                this.TemperatureSensor.getCharacteristic(Characteristic.CurrentTemperature).updateValue(this.CurrentTemperature);
			
                // Set the Battery Level
                this.BatteryService.setCharacteristic(Characteristic.BatteryLevel, this.BatteryLevel);

                // Set the Status Low Battery
                if(this.BatteryLevel <= 10) {this.BatteryService.setCharacteristic(Characteristic.StatusLowBattery, Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);}
                else {this.BatteryService.setCharacteristic(Characteristic.StatusLowBattery, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);}
                this._refreshDeviceInformation();
            }
            else {this.log.error("Could not connect.", err, response, body);}
        }.bind(this));
    },

    _getValue: function(CharacteristicName, callback) {
        this.log.debug("GET", CharacteristicName);
		callback(null);
    },

    _setValue: function(CharacteristicName, value, callback) {
        this.log.debug("SET", CharacteristicName, value);
        callback();
    }

};
