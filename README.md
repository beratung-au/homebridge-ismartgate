# iSmartGate Temperature & Battery for Apple Home

**See more of what is happening around your garage or gate, right in Apple Home.**

Your iSmartGate sensor has more to share than whether the door is open or closed. This Homebridge plugin brings its **temperature and battery readings** into Apple Home, alongside your other accessories.

This community fork builds on the original `homebridge-ismartgate` plugin with a focused improvement: handling network announcements that could previously crash device discovery.

> **Development preview · `1.4.3-discovery.1`**
>
> All 12 automated checks passed. Installation and long-term testing of this packaged fork are still pending.

## A little more insight into your smart home

- **Temperature at a glance:** see the reading from your iSmartGate sensor in Apple Home.
- **Battery visibility:** check the sensor's reported battery level from the same app.
- **Alongside your existing door controls:** the plugin adds these sensor readings; iSmartGate's native HomeKit integration provides the garage door or gate controls.

## Why this fork exists

Smart-home devices share a network with speakers, computers and plenty of other equipment. They announce their services so other devices can find them.

Some announcements, including `spotify-social-listening`, contain service names that the original plugin's discovery library cannot parse. Encountering one could cause discovery to crash, even though the announcement had nothing to do with iSmartGate.

**This fix skips those unsupported records and keeps processing valid discovery information.** It addresses that specific crash while preserving the plugin's existing temperature, battery, login and refresh behaviour.

## What changed

- Added a discovery guard inside the plugin, so the fix travels with this fork when it is installed.
- Preserved valid records, including those arriving alongside an unsupported record.
- Kept the plugin name and accessory identity: `homebridge-ismartgate` / `iSmartGate`.
- Added 12 automated checks covering the original failure, valid discovery, mixed records and cleanup when discovery stops.

For developers: the guard lives in `lib/discovery.js` and applies to this plugin's discovery browser. It leaves original packet objects and other mDNS consumers untouched. The `mdns-js` dependency is pinned to the tested version, `1.0.3`, because the guard uses its internal browser interface. No dependency files need to be edited manually.

## Network setup: one network or separate VLANs?

The plugin needs to **find iSmartGate**, **read its sensor data**, and **share those readings with Apple Home**. These are separate connections.

### On the same LAN or VLAN

When iSmartGate, Homebridge/HOOBS and your local Apple Home devices share one network, no cross-VLAN discovery relay is needed. They still need permission to communicate: guest Wi-Fi, client isolation and multicast filtering can block local connections.

### On separate VLANs

For example, you might keep iSmartGate on an IoT VLAN, HOOBS on a services VLAN, and your Apple Home devices on a trusted VLAN.

Bonjour/mDNS discovery normally stays within the local network. Sharing it across VLANs requires an mDNS relay, reflector or proxy. A firewall rule allowing UDP 5353 alone does not provide that relay. See [Apple's Bonjour overview](https://support.apple.com/en-au/guide/deployment/dep9151c4ace/web).

The current [plugin code](index.js) relies on the following network paths:

| Purpose | What needs to be reachable |
| --- | --- |
| Find iSmartGate | Bonjour/mDNS discovery between iSmartGate and the HOOBS/Homebridge host. The plugin searches for `_hap._tcp.local`; mDNS uses UDP 5353. |
| Read temperature and battery | The HOOBS/Homebridge host must reach iSmartGate's discovered IP address over **HTTP, TCP port 80**, with return traffic allowed. |
| Display the readings in Apple Home | Local Apple Home controllers and the home hub need to discover and reach the HOOBS/Homebridge bridge on its **configured HomeKit TCP port**. This is separate from the web administration port. |

Use narrowly scoped rules between the required hosts and networks. Discovery forwarding does not itself grant permission for the HTTP or HomeKit connections. The existing device login uses unencrypted local HTTP, so keep that access restricted to trusted hosts.

**Using UniFi?** Its [mDNS Proxy](https://help.ui.com/hc/en-us/articles/12648701398807-UniFi-Gateway-Multicast-DNS-mDNS-Proxy) can share selected services between selected VLANs. Check that the required networks and `_hap._tcp.local` service are included. The connection rules in the table still apply.

Two details matter when troubleshooting:

- This version relies on automatic discovery and has **no manual IP-address setting**. A DHCP reservation can keep an address stable, but it does not replace discovery.
- The garage door's native HomeKit connection is separate from this plugin's sensor-data connection. Working door controls alone do not prove that HOOBS can read temperature and battery data.

These are network prerequisites, not a claim of tested cross-VLAN compatibility. **This fork has not yet been validated across VLANs.** Its discovery guard handles unsupported announcements; it does not configure routing, firewall rules or mDNS forwarding.

## Compatibility and scope

The original plugin lists **iSmartGate Gate Lite** support and handles **one garage door or gate**. Other models have not been verified for this fork.

This is a targeted discovery fix. The remaining legacy dependencies and sensor-handling logic have not been comprehensively updated or validated.

## Availability and testing

The current version is available as source on the [`fix/mdns-discovery-crash` branch](https://github.com/beratung-au/homebridge-ismartgate/tree/fix/mdns-discovery-crash). It has not been published to npm or the HOOBS plugin library, and it is **not HOOBS-certified**.

All **12 automated checks passed on Node.js 20.19.1**. They exercise the real discovery library using simulated network records, without contacting a device or operating a door.

An earlier, directly applied discovery fix was followed by a successful HOOBS bridge restart and working temperature and battery readings in Apple Home. That was a different implementation of the same filtering approach. **This packaged fork has not yet been installed and tested end to end on HOOBS.**

### Running the tests

From a checkout of the development branch, using Node.js 20 or newer:

```sh
npm ci --ignore-scripts
npm test
```

The package's `private: true` setting prevents accidental npm publication. The GitHub source remains public.

## Credits and licence

Thank you to **codyc1515** for creating the [original homebridge-ismartgate plugin](https://github.com/codyc1515/homebridge-ismartgate). The original project is archived; this fork carries forward its work with the discovery fix described above.

The original copyright notice and [MIT licence](LICENSE) are retained.

This is an independent community project and is not affiliated with or endorsed by iSmartGate.
