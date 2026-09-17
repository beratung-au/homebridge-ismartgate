'use strict';

const mdns = require('mdns-js');
const ServiceType = require('mdns-js/lib/service_type').ServiceType;

// mdns-js 1.0.3 throws when an incoming PTR has an unsupported service type.
// Validate the same strings it would parse, before they reach this browser.
function invalidServiceType(packet, record) {
  if (record.type !== 12) return false; // DNS PTR record

  let value;
  if (packet.header.qr === 1 && record.name.indexOf('_service') === 0) {
    if (!record.data) return false;
    value = record.data;
  } else if (record.name.indexOf('_') === 0) {
    value = record.name;
  } else {
    return false;
  }

  try {
    new ServiceType(value.replace('.local', ''));
    return false;
  } catch (error) {
    return true;
  }
}

function filterPackets(packets) {
  const sections = ['answer', 'authority', 'additional'];
  const result = [];
  let changed = false;

  packets.forEach(function(packet) {
    let copy = packet;
    sections.forEach(function(section) {
      // Leave structural errors to the decoder; only filter invalid PTR types.
      if (!Array.isArray(packet[section])) return;
      const records = packet[section].filter(function(record) {
        return !invalidServiceType(packet, record);
      });
      if (records.length !== packet[section].length) {
        if (copy === packet) {
          copy = Object.assign(Object.create(Object.getPrototypeOf(packet)), packet);
        }
        copy[section] = records;
        changed = true;
      }
    });

    // An emptied invalid packet must not make mdns-js skip later valid packets.
    if (copy !== packet && sections.every(function(section) {
      return Array.isArray(copy[section]) && copy[section].length === 0;
    })) return;

    result.push(copy);
  });
  return changed ? result : packets;
}

function createBrowser(serviceType) {
  const browser = mdns.createBrowser(serviceType);
  const listener = browser.onMessageListener;
  browser.networking.removeListener('packets', listener);
  browser.onMessageListener = function(packets, remote, connection) {
    const filtered = filterPackets(packets);
    if (filtered.length > 0) return listener(filtered, remote, connection);
  };
  browser.networking.on('packets', browser.onMessageListener);
  // Browser.stop() removes onMessageListener, including this replacement.
  return browser;
}

module.exports = {createBrowser, filterPackets};
