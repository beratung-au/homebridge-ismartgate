'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const hap = require('hap-nodejs');
const info = require('../lib/device-info');
const version = require('../package.json').version;
const auth = info.credentials('admin', 'password');
const xml = '<response><model>iSmartGate LITE</model><firmwareversion>1.7.0</firmwareversion>' +
  '<remoteaccess>https://a1b2c3d4e5.isgaccess.com/</remoteaccess><pin>redacted</pin>' +
  '<door1><sensorid>sensor-only</sensorid></door1></response>';
const expected = {model: 'iSmartGate LITE', firmware: '1.7.0', udi: 'a1b2c3d4e5'};

test('cipher and token match the independent Python library test vector', () => {
  assert.equal(auth.token, 'f7001ecfe4d09ea0e58cb09058ba11ffe3ea36f0');
  const plain = '["admin", "notRealPassword", "info", "", ""]';
  const encoded = '497c04879e0d26afxuTQ0lB1Rd0c0G/l6Tiw+YCjnN9oG26d3I5IyGQpvkcpJ9l2aHDcTdquB0RnkWgi';
  assert.equal(info.encrypt(plain, auth.key, '497c04879e0d26af'), encoded);
  assert.equal(info.decrypt(encoded, auth.key), plain);
  assert.equal(info.credentials('Admin', 'password').token, auth.token);
});

test('device response returns only allowlisted metadata, including a documented UDI fallback', () => {
  assert.deepEqual(info.parseInfo(xml), expected);
});

test('remote access can be disabled; only its locally returned address is inspected', () => {
  assert.equal(info.parseInfo(xml.replace('<pin>', '<remoteaccessenabled>no</remoteaccessenabled><pin>')).udi, expected.udi);
  for (const value of ['a1b2c3d4e5.isgaccess.com', 'https://a1b2c3d4e5.isgaccess.com/index.php']) {
    assert.equal(info.udiFromRemoteAccess(value), expected.udi);
  }
});

test('unknown remote-address formats never become a guessed serial number', () => {
  for (const value of ['https://a1b2c3d4e5.isgaccess.com.attacker.test', 'https://isgaccess.com',
    'https://a1b2c3d4e5.isgaccess.com:1234', 'https://login:secret@a1b2c3d4e5.isgaccess.com',
    'http://192.0.2.1', 'https://not-a-udi.isgaccess.com', 'file://a1b2c3d4e5.isgaccess.com']) {
    assert.equal(info.udiFromRemoteAccess(value), undefined);
  }
  assert.deepEqual(info.parseInfo('<response><firmwareversion>761</firmwareversion></response>'), {firmware:'761'});
});

test('missing or invalid individual fields are omitted without discarding valid firmware', () => {
  assert.deepEqual(info.parseInfo('<response><model>' + 'x'.repeat(65) + '</model>' +
    '<firmwareversion>1.7.0</firmwareversion><remoteaccess /></response>'), {firmware:'1.7.0'});
  assert.deepEqual(info.parseInfo('<response><model>LITE</model><firmwareversion>login failed</firmwareversion></response>'), {model:'LITE'});
});

test('XML entities and CDATA are decoded by the parser', () => {
  assert.deepEqual(info.parseInfo('<response><model><![CDATA[iSmartGate LITE]]></model>' +
    '<firmwareversion>1.7.&#48;</firmwareversion></response>'), {model:'iSmartGate LITE',firmware:'1.7.0'});
});

test('malformed, ambiguous and unsafe XML is rejected', () => {
  for (const value of ['', '<html><model>LITE</model></html>', '<response><model>LITE</response>',
    '<response><model>LITE</model><model>PRO</model></response>',
    '<response><model><nested>LITE</nested></model></response>',
    '<!DOCTYPE response [<!ENTITY remote SYSTEM "file:///not-read">]><response><model>&remote;</model></response>',
    '<response><model>&undeclared;</model></response>',
    '<response><error><code>1</code></error><model>LITE</model></response>',
    '<response><door1><model>not-controller</model></door1></response>',
    '<response>' + '<nested>'.repeat(33) + '</nested>'.repeat(33) + '</response>']) {
    assert.throws(() => info.parseInfo(value));
  }
});

function transport(body, status = 200, mode = 'complete') {
  let seen;
  const request = new EventEmitter();
  const response = new EventEmitter();
  request.destroy = () => {request.destroyed = true;};
  response.destroy = () => {response.destroyed = true;};
  response.statusCode = status;
  return {request, response, get seen() {return seen;}, get(options, callback) {
    seen = options;
    process.nextTick(() => {
      if (mode === 'hang') return;
      if (mode === 'request-error') {request.emit('error', new Error('secret=do-not-print')); return;}
      callback(response);
      if (response.destroyed) return;
      if (mode === 'aborted') {response.emit('aborted'); return;}
      response.emit('data', Buffer.from(body));
      if (mode !== 'trickle') response.emit('end');
    });
    return request;
  }};
}

test('only a local info command is sent; no door command, cookie, proxy or redirect is used', async () => {
  const wire = transport(info.encrypt(xml, auth.key));
  assert.deepEqual(await info.fetchInfo('192.0.2.10','admin','password',{get:wire.get}), expected);
  const query = new URLSearchParams(wire.seen.path.split('?')[1]);
  assert.deepEqual(JSON.parse(info.decrypt(query.get('data'), auth.key)), ['admin','password','info','','']);
  assert.equal(query.get('token'), auth.token);
  assert.equal(wire.seen.hostname, '192.0.2.10');
  assert.equal(wire.seen.port, 80);
  assert.equal(wire.seen.method, 'GET');
  assert.equal(wire.seen.agent, false);
  assert.equal(wire.seen.headers.Cookie, undefined);
});

test('Unicode login values survive JSON encryption', async () => {
  const username='Tést', password='not-real-é🔑', keys=info.credentials(username,password);
  const wire=transport(info.encrypt(xml,keys.key));
  await info.fetchInfo('2001:db8::1',username,password,{get:wire.get});
  const query=new URLSearchParams(wire.seen.path.split('?')[1]);
  assert.deepEqual(JSON.parse(info.decrypt(query.get('data'),keys.key)),[username,password,'info','','']);
});

test('redirects, oversized, incomplete, invalid and plaintext responses fail without leaking data', async () => {
  const cases=[transport('',302),transport('x'.repeat(65537)),transport('secret-raw-body'),
    transport(xml),transport('',200,'aborted'),transport('',200,'request-error'),
    transport(info.encrypt('<response><error><code>1</code></error></response>',auth.key))];
  for(const wire of cases) {
    await assert.rejects(info.fetchInfo('192.0.2.10','admin','password',{get:wire.get}),
      error => error.message === 'Device information unavailable; sensor polling is unchanged.');
    assert.equal(wire.request.destroyed,true);
  }
});

test('hard deadline cancels both a stalled connection and an unfinished response', async () => {
  for(const mode of ['hang','trickle']) {
    const wire=transport('partial',200,mode);
    await assert.rejects(info.fetchInfo('192.0.2.10','admin','password',{get:wire.get,timeoutMs:20}));
    assert.equal(wire.request.destroyed,true);
    if(mode==='trickle') assert.equal(wire.response.destroyed,true);
  }
});

test('missing credentials and non-IP destinations make no network request', async () => {
  let calls=0;
  const get=() => {calls++; throw new Error('must not be called');};
  for(const args of [['device.example','admin','password'],['192.0.2.10','','password'],['192.0.2.10','admin',null]]) {
    await assert.rejects(info.fetchInfo(...args,{get}));
  }
  assert.equal(calls,0);
});

function pluginFixture(fetchInfo) {
  const source=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
  const browser=new EventEmitter(); browser.discover=() => {};
  const requests=[], calls=[], timers=[];
  const request={jar:() => ({}),post:(opts,callback)=>requests.push({type:'post',opts,callback}),
    get:(opts,callback)=>requests.push({type:'get',opts,callback})};
  const module={exports:{}};
  vm.runInNewContext(source, {module,require(name) {
    if(name==='request') return request;
    if(name==='./lib/discovery') return {createBrowser:() => browser};
    if(name==='./lib/device-info') return {fetchInfo(...args) {calls.push(args); return fetchInfo(...args);}};
    if(name==='./package.json') return {version};
    throw new Error('Unexpected dependency '+name);
  },setInterval:(fn,ms)=>timers.push({fn,ms}),setTimeout:(fn,ms)=>timers.push({fn,ms})});
  let Constructor, registration;
  // HOOBS supports the legacy BatteryService alias used by the original plugin.
  const service=Object.assign({},hap.Service,{BatteryService:hap.Service.Battery});
  module.exports({hap:{...hap,Service:service},registerAccessory(...args) {
    registration=args.slice(0,2); Constructor=args[2];
  }});
  const logs=[];
  const log=Object.fromEntries(['info','debug','warn','error'].map(k=>[k,(...args)=>logs.push(args)]));
  const config={name:'iSmartGate Temperature',username:'test-login',password:'test-password'};
  const before=JSON.stringify(config);
  const instance=new Constructor(log,config);
  const services=instance.getServices();
  return {instance,services,browser,requests,calls,timers,registration,logs,config,before};
}

test('real HAP information-copy behavior returns newly discovered metadata with unchanged identity', async () => {
  const f=pluginFixture(async () => expected);
  assert.deepEqual(f.registration,['homebridge-ismartgate','iSmartGate']);
  const beforeUUID=hap.uuid.generate('iSmartGate:'+f.instance.name);
  const accessory=new hap.Accessory(f.instance.name,beforeUUID);
  const information=accessory.getService(hap.Service.AccessoryInformation);
  for(const service of f.services) {
    if(service.UUID===hap.Service.AccessoryInformation.UUID) information.replaceCharacteristicsFromService(service);
    else accessory.addService(service);
  }
  const originalServices=accessory.services.map(s=>s.UUID);
  f.instance.hostname='192.0.2.10';
  await f.instance._refreshDeviceInformation();
  for(const [characteristic,value] of [[hap.Characteristic.Model,'iSmartGate LITE'],
    [hap.Characteristic.FirmwareRevision,'1.7.0'],[hap.Characteristic.SerialNumber,'UDI-a1b2c3d4e5']]) {
    assert.equal(await information.getCharacteristic(characteristic).handleGetRequest(),value);
  }
  assert.equal(accessory.UUID,beforeUUID);
  assert.equal(hap.uuid.generate('iSmartGate:'+f.instance.name),beforeUUID);
  assert.deepEqual(accessory.services.map(s=>s.UUID),originalServices);
  assert.equal(f.instance.uuid_base,undefined);
  assert.equal(JSON.stringify(f.config),f.before);
  assert.equal(f.calls.length,1); // Reading HomeKit metadata did not make additional HTTP requests.
});

test('discovery still uses the existing device login and sensor polling', async () => {
  const f=pluginFixture(async () => expected);
  assert.equal(f.requests.length,0);
  f.browser.emit('update',{txt:['md=iSmartGate'],addresses:['192.0.2.10']});
  f.timers.find(t=>t.ms===2500).fn();
  assert.equal(f.requests[0].opts.url,'http://192.0.2.10/index.php');
  f.requests[0].callback(null,{statusCode:200,headers:{}},'');
  assert.equal(f.requests[1].opts.url,'http://192.0.2.10/isg/temperature.php?door=1');
  f.requests[1].callback(null,{statusCode:200},'[27200,"80"]');
  await f.instance._infoRequest.promise;
  assert.equal(f.instance.CurrentTemperature,27.2);
  assert.equal(f.instance.BatteryLevel,80);
  assert.equal(f.calls.length,1);
});

test('failed metadata lookup preserves working sensor readings and last-known metadata', async () => {
  let fail=false;
  const f=pluginFixture(async () => {if(fail) throw new Error('secret-response'); return expected;});
  f.instance.hostname='192.0.2.10';
  await f.instance._refreshDeviceInformation();
  fail=true; f.instance._nextInfoAt=0;
  f.instance.response={headers:{}};
  f.instance._refresh();
  f.requests[0].callback(null,{statusCode:200},'[28000,"80"]');
  await f.instance._infoRequest.promise;
  assert.equal(f.instance.CurrentTemperature,28);
  assert.equal(f.instance.BatteryLevel,80);
  assert.equal(f.instance._informationValues.firmware,'1.7.0');
  assert.equal(JSON.stringify(f.logs).includes('secret-response'),false);
  assert.equal(f.instance._infoRequest,null);
  const count=f.calls.length;
  f.instance._refreshDeviceInformation();
  assert.equal(f.calls.length,count); // Rate limited until the next refresh window.
});

test('concurrent lookups coalesce and late responses from a previous address are ignored', async () => {
  const pending=[];
  const f=pluginFixture(() => new Promise(resolve=>pending.push(resolve)));
  f.instance.hostname='192.0.2.10';
  const first=f.instance._refreshDeviceInformation();
  f.instance._refreshDeviceInformation();
  await Promise.resolve();
  assert.equal(f.calls.length,1);
  f.instance.hostname='192.0.2.11';
  const second=f.instance._refreshDeviceInformation();
  await Promise.resolve();
  pending[1]({...expected,firmware:'1.8.0'}); await second;
  pending[0](expected); await first;
  assert.equal(f.instance._informationValues.firmware,'1.8.0');
  assert.equal(f.instance._infoRequest,null);
});

test('initial unknown serial is not a login, and partial metadata preserves already known fields', async () => {
  let result=expected;
  const f=pluginFixture(async () => result);
  assert.equal(f.instance._informationValues.serial,'Unknown');
  f.instance.hostname='192.0.2.10';
  await f.instance._refreshDeviceInformation();
  result={firmware:'1.8.0'}; f.instance._nextInfoAt=0;
  await f.instance._refreshDeviceInformation();
  assert.equal(f.instance._informationValues.serial,'UDI-a1b2c3d4e5');
  assert.equal(f.instance._informationValues.model,'iSmartGate LITE');
  assert.equal(f.instance._informationValues.firmware,'1.8.0');
});
