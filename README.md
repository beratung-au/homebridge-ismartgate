# iSmartGate Temperature & Battery for Apple Home

**See more of what is happening around your garage or gate, right in Apple Home.**

Your iSmartGate sensor has more to share than whether the door is open or closed. This Homebridge plugin brings its **temperature and battery readings** into Apple Home, alongside your other accessories.

This community fork builds on the original `homebridge-ismartgate` plugin with more resilient discovery and automatic device information in Apple Home.

> **Development preview · `1.4.3-discovery.3`**
>
> Tested on an iSmartGate LITE with HOOBS 5.1.8: Apple Home now displays the controller model, firmware and automatically discovered device identifier. All 32 automated checks passed on Node.js 20.19.1. This remains a development preview; long-term reliability, other models and cross-VLAN operation have not yet been validated.

## A little more insight into your smart home

- **Temperature at a glance:** see the reading from your iSmartGate sensor in Apple Home.
- **Battery visibility:** check the sensor's reported battery level from the same app.
- **Useful device information:** automatically read the controller model and firmware, and show its UDI when available, using the same discovered device and existing login.
- **Alongside your existing door controls:** the plugin adds these sensor readings; iSmartGate's native HomeKit integration provides the garage door or gate controls.

## Why this fork exists

Smart-home devices share a network with speakers, computers and plenty of other equipment. They announce their services so other devices can find them.

Some announcements, including `spotify-social-listening`, contain service names that the original plugin's discovery library cannot parse. Encountering one could cause discovery to crash, even though the announcement had nothing to do with iSmartGate.

**This fix skips those unsupported records and keeps processing valid discovery information.** It addresses that specific crash while preserving the plugin's existing temperature, battery, login and refresh behaviour.

## Automatic device information

Setup stays automatic. After discovery and the existing login, the plugin makes a separate, read-only `info` request to the device's local API. No manual IP address, serial number or firmware setting is added.

| Apple Home field | What this version reports |
| --- | --- |
| Manufacturer | iSmartGate |
| Model | The reported controller model, with known names formatted as `iSmartGate LITE` or `iSmartGate PRO` |
| Serial Number | `UDI-` followed by the device UDI, when it can be identified from the locally returned remote-access address |
| Firmware | The device firmware; recognised three-digit iSmartGate revisions are formatted with dots, for example `170` → `1.7.0` |

The formatting rule follows an observed LITE response: the API returned `170` while the device app reported `1.7.0`. Three-digit versions are interpreted only when the reported model is recognised as iSmartGate. Already dotted versions, longer revisions and unknown controller models retain their original firmware value. This does not establish the format of every future firmware release.

The UDI is a **device identifier, not a verified factory serial number**. The API implementation examined does not expose a factory serial. This version recognises a ten-character hexadecimal UDI in an `isgaccess.com` hostname, allowing surrounding whitespace; other address formats are left unknown. It neither contacts that remote address nor enables remote access. If the local response supplies the address while remote access is disabled, it can still be used. Missing metadata does not require enabling cloud access.

The first successful lookup replaces the startup information. Before that, the model is `iSmartGate`, the serial is `Unknown`, and firmware retains the plugin version as a compatibility fallback. The package version remains available in HOOBS independently of the device firmware. HomeKit certification status is unchanged.

Successful values are kept **in memory for the running session** and refreshed about every three hours. Failures retain those values and can be retried through normal sensor polling, at most once per ten minutes. A restart requires rediscovery and a fresh lookup; no bridge files or pairing storage are used as a cache. A partial response updates only the fields it provides.

Each lookup has a five-second deadline and a bounded response size. Metadata reads from Apple Home use cached values immediately; they do not wait for a device request. The metadata path never sends a door command, changes device settings, follows HTTP redirects, or logs credentials or raw API responses. Temperature and battery keep their existing login and polling path.

The accessory name and registration remain unchanged, and metadata is not used as an accessory UUID input. Read handlers also support HOOBS copying information characteristics during startup. Once a copied characteristic has been read, later metadata refreshes update its cached value too, covering HAP responses that temporarily skip read handlers. Apple Home can still retain previously displayed information until it reads the accessory again; the plugin does not reset pairing or force a bridge rebuild.

The local API protocol is adapted from the [ismartgate library](https://github.com/bdraco/ismartgate); see [third-party notices](THIRD_PARTY_NOTICES.md). This is a community implementation, not an official vendor API guarantee.

## What changed

- Added a discovery guard inside the plugin, so the fix travels with this fork when it is installed.
- Preserved valid records, including those arriving alongside an unsupported record.
- Kept the plugin name and accessory identity: `homebridge-ismartgate` / `iSmartGate`.
- Retained 12 discovery checks and expanded metadata coverage to 20 checks, including observed device formats, whitespace around discovery metadata, failure isolation and the real HomeKit library's handling of copied information.
- Added the pinned `sax` XML parser for metadata responses. Runtime Node.js now requires 12 or newer; automated tests require Node.js 20 or newer.

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
| Read sensors and device information | The HOOBS/Homebridge host must reach iSmartGate's discovered IP address over **HTTP, TCP port 80**, with return traffic allowed. |
| Display the readings in Apple Home | Local Apple Home controllers and the home hub need to discover and reach the HOOBS/Homebridge bridge on its **configured HomeKit TCP port**. This is separate from the web administration port. |

Use narrowly scoped rules between the required hosts and networks. Discovery forwarding does not itself grant permission for the HTTP or HomeKit connections. The existing device login uses unencrypted local HTTP, so keep that access restricted to trusted hosts.

**Using UniFi?** Its [mDNS Proxy](https://help.ui.com/hc/en-us/articles/12648701398807-UniFi-Gateway-Multicast-DNS-mDNS-Proxy) can share selected services between selected VLANs. Check that the required networks and `_hap._tcp.local` service are included. The connection rules in the table still apply.

Two details matter when troubleshooting:

- This version relies on automatic discovery and has **no manual IP-address setting**. A DHCP reservation can keep an address stable, but it does not replace discovery.
- The garage door's native HomeKit connection is separate from this plugin's sensor-data connection. Working door controls alone do not prove that HOOBS can read temperature and battery data.

These are network prerequisites, not a claim of tested cross-VLAN compatibility. **This fork has not yet been validated across VLANs.** Its discovery guard handles unsupported announcements; it does not configure routing, firewall rules or mDNS forwarding.

## Compatibility and scope

The original plugin lists **iSmartGate Gate Lite** support and handles **one garage door or gate**. Other models have not been verified for this fork.

These changes address discovery reliability and device information. The remaining legacy dependencies and sensor-handling logic have not been comprehensively updated or validated.

## Availability and testing

The development branch is [`fix/mdns-discovery-crash`](https://github.com/beratung-au/homebridge-ismartgate/tree/fix/mdns-discovery-crash). Check its package version to identify the revision you are viewing. It has not been published to npm or the HOOBS plugin library, and it is **not HOOBS-certified**.

All **32 automated checks passed on Node.js 20.19.1**. They cover the real discovery decoder, a published independent cipher test vector, encrypted simulated API responses, deadlines, malformed data, absent metadata, sensor continuity, and information-characteristic copying using `hap-nodejs` 1.2.0. Network transport and device discovery are simulated; tests do not contact a real device or operate a door.

The preceding `1.4.3-discovery.1` package was installed in an existing HOOBS 5.1.8 bridge. Startup and device login succeeded, and temperature and battery remained available through the existing Apple Home pairing. Long-term discovery reliability and cross-VLAN operation have not been established by those observations.

**`1.4.3-discovery.3` was installed and checked on a physical iSmartGate LITE installation on 17 September 2026.** The installed plugin files matched the tested package, and the plugin update left the bridge configuration contents unchanged. A read-only device check returned model `iSmartGate LITE`, firmware `1.7.0` and a detected UDI. Apple Home subsequently displayed `iSmartGate LITE`, firmware `1.7` and the UDI-prefixed identifier; temperature readings also continued to update. These observations validate the metadata correction on this installation, not every model or network arrangement.

During validation, the tester reported clearing the plugin's device cache and rebooting HOOBS after older information remained visible. The corrected details appeared afterwards. That sequence does not establish which cache held the old values or whether both actions were necessary, and it is **not a required installation step**. Preserve existing bridge identity and pairing data when updating a remote installation.

Test fixtures use synthetic addresses and identifiers. No real device identifier, credentials or installation screenshots are included in this repository.

### HOOBS version labels and a blank configuration page

A command-line plugin update can leave the HOOBS hub's installed-plugin listing cached at an earlier version. That label is separate from both the installed package version and the controller firmware shown in Apple Home.

The HOOBS web interface also requests the plugin's online catalogue entry before loading its local configuration panel. If that catalogue returns no result, the panel can remain blank even when the plugin and its configuration schema are installed. In the installation investigated, the catalogue returned `count: 0`. This fork does not repair the HOOBS catalogue or modify the HOOBS interface. Its existing configuration fields remain name, username and password; device information is discovered automatically.

Do not remove the bridge or clear its pairing/accessory cache to address these display issues.

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
