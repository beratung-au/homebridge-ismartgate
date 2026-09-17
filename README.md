# iSmartGate discovery reliability fork

This branch contains a narrow fix for the discovery crash triggered by an unsupported mDNS service name, such as `spotify-social-listening`.

The original plugin is preserved as the baseline. The plugin identity (`homebridge-ismartgate` / `iSmartGate`) and its temperature, battery, login and refresh behaviour stay the same. The fork version is `1.4.3-discovery.1`; `private: true` prevents accidental npm publication. Fork: https://github.com/beratung-au/homebridge-ismartgate. The original project is https://github.com/codyc1515/homebridge-ismartgate.

## Discovery fix

`lib/discovery.js` filters PTR service records that mdns-js cannot parse before they reach this plugin's browser. Valid records from the same packet are retained. Packets emptied by filtering are omitted so they cannot suppress valid packets later in a batch. Original packet objects and other mDNS consumers are not modified. Browser shutdown removes the replacement listener normally.

The wrapper uses mdns-js 1.0.3 internals, so that dependency is pinned to the tested version. It does not edit files in node_modules. Installing this fork includes the guard; installing the original upstream package does not.

The earlier on-device mitigation changed the dependency decoder directly. This branch implements the same filtering intent inside the plugin for persistence across reinstalls; it has not yet replaced the running HOOBS installation.

## Validation

Tests require Node.js 20 or newer and use the real mdns-js decoder, service validator and browser with synthetic DNS records and an in-memory network emitter. No real network discovery, device login or door commands are performed.

```sh
npm ci --ignore-scripts
npm test
```

All 12 automated checks passed on Node.js 20.19.1.

The on-device decoder mitigation was followed by a successful bridge restart and working temperature and battery readings in Apple Home. Those observations apply to the earlier mitigation, not an end-to-end deployment test of this fork. Long-term operation remains to be checked.

This change addresses the recorded discovery crash only. It does not modernise every legacy dependency or repair unrelated sensor/device faults.

The upstream MIT license and attribution are retained in `LICENSE`. Original upstream notes follow.

---

# Update
This plug-in is no longer supported. I am using Home Assistant now which has a native iSmartGate integration.

# homebridge-ismartgate
[Homebridge](https://github.com/nfarina/homebridge) plug-in for iSmartGate HomeKit devices to expose their Temperature & Battery services, which would otherwise be hidden.

## Things to know
* Supports only a single garage door / gate
* Only exposes the Temperature & Battery services, as the device already has HomeKit support for the Garage Door service. If you need a Garage Door service as well, take a look at the plug-in [homebridge-gogogate2](https://www.npmjs.com/package/homebridge-gogogate2).
* Only the iSmartGate Gate Lite is supported. While no other devices have been tested, I see no reason that they should not work.

### Legal
* Licensed under [MIT](LICENSE)
* This is not an official plug-in and is not affiliated with iSmartGate in any way
