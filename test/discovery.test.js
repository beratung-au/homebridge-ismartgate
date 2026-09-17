'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {createRequire} = require('node:module');
const mdnsRequire = createRequire(require.resolve('mdns-js/package.json'));
const {DNSPacket, DNSRecord} = mdnsRequire('dns-js');
const {ServiceType} = require('mdns-js/lib/service_type');
const Browser = require('mdns-js/lib/browser');
const originalDecoder = require('mdns-js/lib/decoder');
const discoverySource = fs.readFileSync(path.join(__dirname, '../lib/discovery.js'), 'utf8');
const Type = DNSRecord.Type;

function fixture() {
  const network = new EventEmitter();
  network.addUsage = function() {};
  network.removeUsage = function() {};
  const module = {exports:{}};
  vm.runInNewContext(discoverySource, {module, require(name) {
    if (name === 'mdns-js') return {createBrowser(type) {
      return new Browser(network, new ServiceType(type));
    }};
    if (name === 'mdns-js/lib/service_type') return {ServiceType};
    throw new Error('Unexpected import: ' + name);
  }});
  return {network, discovery:module.exports};
}

function packet(answer, additional = [], authority = []) {
  const value = new DNSPacket();
  value.header.qr = 1;
  value.answer = answer;
  value.additional = additional;
  value.authority = authority;
  return value;
}
const invalid = {type:Type.PTR, name:'_spotify-social-listening._tcp.local', data:'Test._spotify-social-listening._tcp.local'};
const valid = {type:Type.PTR, name:'_hap._tcp.local', data:'Test._hap._tcp.local'};
const attributes = [
  {type:Type.TXT, name:'Test._hap._tcp.local', data:['md=iSmartGate']},
  {type:Type.SRV, name:'Test._hap._tcp.local', port:80},
  {type:Type.A, name:'test.local', data:'192.0.2.10'}
];
const remote = {address:'192.0.2.10'};
const connection = {networkInterface:'test-only', interfaceIndex:1};

test('unmodified dependency reproduces the reported crash', function() {
  assert.throws(function() {
    originalDecoder.decodePackets([packet([invalid])]);
  }, /type spotify-social-listening has more than 20 characters/);
});

test('invalid PTR announcement is ignored by the guarded browser', function() {
  const {network, discovery} = fixture();
  const browser = discovery.createBrowser('_hap._tcp');
  let updates = 0;
  browser.on('update', function() {updates++;});
  network.emit('packets', [packet([invalid])], remote, connection);
  assert.equal(updates, 0);
  browser.stop();
});

test('valid discovery works after an invalid announcement', function() {
  const {network, discovery} = fixture();
  const browser = discovery.createBrowser('_hap._tcp');
  const updates = [];
  browser.on('update', function(data) {updates.push(data);});
  network.emit('packets', [packet([invalid])], remote, connection);
  network.emit('packets', [packet([valid], attributes)], remote, connection);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].txt[0], 'md=iSmartGate');
  assert.equal(updates[0].addresses[0], '192.0.2.10');
  browser.stop();
});

test('valid and invalid records in the same packet preserve HomeKit discovery', function() {
  const {discovery} = fixture();
  const input = packet([invalid, valid], attributes);
  const output = discovery.filterPackets([input]);
  const decoded = originalDecoder.decodePackets(output);
  assert.equal(decoded.type.length, 1);
  assert.equal(decoded.type[0].toString(), '_hap._tcp');
  assert.equal(decoded.txt[0], 'md=iSmartGate');
  assert.equal(decoded.port, 80);
});

test('service-enumeration PTR values are checked too', function() {
  const {discovery} = fixture();
  const name = '_services._dns-sd._udp.local';
  const input = packet([
    {type:Type.PTR, name, data:'_spotify-social-listening._tcp.local'},
    {type:Type.PTR, name, data:'_hap._tcp.local'}
  ]);
  const decoded = originalDecoder.decodePackets(discovery.filterPackets([input]));
  assert.equal(decoded.type.length, 1);
  assert.equal(decoded.type[0].toString(), '_hap._tcp');
});

test('all-invalid packet does not suppress a later valid packet in the batch', function() {
  const {discovery} = fixture();
  const decoded = originalDecoder.decodePackets(discovery.filterPackets([
    packet([invalid]), packet([valid], attributes)
  ]));
  assert.equal(decoded.type[0].toString(), '_hap._tcp');
  assert.equal(decoded.txt[0], 'md=iSmartGate');
});

test('incoming packets and dependency validators are not modified', function() {
  const {discovery} = fixture();
  const input = packet([invalid, valid], attributes);
  const before = JSON.stringify(input);
  const output = discovery.filterPackets([input]);
  assert.equal(JSON.stringify(input), before);
  assert.equal(output[0] instanceof DNSPacket, true);
  assert.equal(typeof output[0].each, 'function');
  assert.throws(function() {new ServiceType('_spotify-social-listening._tcp');}, /more than 20/);
});

test('valid packets pass through unchanged, including every record section', function() {
  const {discovery} = fixture();
  const input = [packet([valid], attributes, [valid])];
  assert.equal(discovery.filterPackets(input), input);
});

test('invalid PTR records are filtered from all sections', function() {
  const {discovery} = fixture();
  const input = packet([invalid, valid], [invalid, ...attributes], [invalid]);
  const output = discovery.filterPackets([input])[0];
  assert.equal(output.answer.length, 1);
  assert.equal(output.additional.length, attributes.length);
  assert.equal(output.authority.length, 0);
});

test('unsupported protocols and non-string enumeration data are skipped', function() {
  const {discovery} = fixture();
  const input = packet([
    {type:Type.PTR, name:'_bad._invalid.local', data:'Test._bad._invalid.local'},
    {type:Type.PTR, name:'_services._dns-sd._udp.local', data:42}, valid
  ]);
  const output = discovery.filterPackets([input]);
  assert.equal(output[0].answer.length, 1);
  assert.equal(output[0].answer[0], valid);
});

test('stop removes the replacement listener without disturbing other users', function() {
  const {network, discovery} = fixture();
  const other = function() {};
  network.on('packets', other);
  const browser = discovery.createBrowser('_hap._tcp');
  assert.equal(network.listenerCount('packets'), 2);
  browser.stop();
  assert.deepEqual(network.listeners('packets'), [other]);
});

test('plugin keeps its registered identity and uses the guarded browser', function() {
  const {discovery} = fixture();
  let created = 0, registration;
  const services = [];
  class Service {
    constructor() {services.push(this);}
    setCharacteristic() {return this;}
  }
  const plugin = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../index.js'),'utf8'), {
    module:plugin, require(name) {
      if (name === 'request') return {jar() {return {};}};
      if (name === './lib/discovery') return {createBrowser(type) {
        created++;return discovery.createBrowser(type);
      }};
      if (name === './package.json') return require('../package.json');
      throw new Error('Unexpected import '+name);
    }, setInterval() {}, setTimeout() {throw new Error('Unexpected device login');}
  });
  plugin.exports({hap:{Accessory:{},Characteristic:{},Service:{TemperatureSensor:Service,BatteryService:Service,AccessoryInformation:Service}},
    registerAccessory(name, alias, constructor) {registration={name, alias, constructor};}
  });
  assert.equal(registration.name, 'homebridge-ismartgate');
  assert.equal(registration.alias, 'iSmartGate');
  new registration.constructor({}, {name:'Test sensor'}).getServices();
  assert.equal(created, 1);assert.equal(services.length, 3);
});
