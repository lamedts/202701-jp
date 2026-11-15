import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { encrypt, iterations } from './protect.mjs';

const password = 'test-only-unlock-phrase';
const source = '<!doctype html><html><body><h1>Private winter itinerary ♡</h1><img src="https://example.com/photo.jpg"><script>window.itineraryLoaded=true;</script></body></html>';
const template = await readFile(new URL('./gate.html', import.meta.url), 'utf8');
const gateScript = [...template.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
const sessionScript = await readFile(new URL('./session.js', import.meta.url), 'utf8');
const threeDays = 3 * 24 * 60 * 60 * 1000;

function fakeIndexedDB() {
  const records = new Map();
  return {
    records,
    open() {
      const request = {
        result: {
          createObjectStore() {},
          close() {},
          transaction() {
            const transaction = {
              objectStore() {
                const run = action => {
                  const operation = {};
                  queueMicrotask(() => {
                    operation.result = action();
                    operation.onsuccess?.();
                    transaction.oncomplete?.();
                  });
                  return operation;
                };
                return {
                  get: key => run(() => records.get(key)),
                  put: (value, key) => run(() => records.set(key, value)),
                  delete: key => run(() => records.delete(key))
                };
              }
            };
            return transaction;
          }
        }
      };
      queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    }
  };
}

function browser(payload, enteredPassword, crypto = webcrypto, options = {}) {
  const listeners = new Map();
  const elements = new Map();
  const output = { html: null, closed: false };
  for (const id of ['unlock-form', 'password', 'unlock', 'unlock-error', 'reveal', 'encrypted-itinerary']) {
    elements.set(id, {
      value: '', type: 'password', textContent: '', disabled: false, attributes: {},
      addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      focus() { this.focused = true; }
    });
  }
  elements.get('password').value = enteredPassword;
  elements.get('encrypted-itinerary').textContent = JSON.stringify(payload);
  const context = vm.createContext({
    crypto, TextEncoder, TextDecoder, Uint8Array, JSON,
    indexedDB: options.indexedDB,
    Date: class extends Date { static now() { return options.clock?.now ?? Date.now(); } },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    location: { hash: '' }, requestAnimationFrame: handler => handler(),
    document: {
      getElementById: id => elements.get(id),
      open() { output.opened = true; },
      write(html) { output.html = html; },
      close() { output.closed = true; }
    }
  });
  if (options.indexedDB) vm.runInContext(sessionScript, context);
  vm.runInContext(gateScript, context);
  return { elements, output, submit: () => listeners.get('unlock-form:submit')({ preventDefault() {} }), reveal: () => listeners.get('reveal:click')() };
}

test('the real browser unlock handler decrypts the exact UTF-8 document', async () => {
  const payload = await encrypt(source, password);
  assert.equal(payload.iterations, iterations);
  assert.equal(Buffer.from(payload.salt, 'base64').length, 16);
  assert.equal(Buffer.from(payload.iv, 'base64').length, 12);
  const page = browser(payload, password);
  await page.submit();
  assert.equal(page.output.html, source);
  assert.equal(page.output.closed, true);
  assert.equal(page.elements.get('password').value, '');
});

test('a successful unlock persists a non-extractable key and restores it on reload', async () => {
  const payload = await encrypt(source, password);
  const storage = fakeIndexedDB();
  const clock = { now: 1_800_000_000_000 };
  const first = browser(payload, password, webcrypto, { indexedDB: storage, clock });
  await first.submit();
  const saved = storage.records.get('itinerary');
  assert.equal(saved.key.extractable, false);
  assert.equal(saved.lastUsed, clock.now);
  assert.equal(saved.salt, payload.salt);
  assert.equal(JSON.stringify([...storage.records.values()]).includes(password), false);

  clock.now += threeDays - 1000;
  const second = browser(payload, '', webcrypto, { indexedDB: storage, clock });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(second.output.html, source);
  assert.equal(storage.records.get('itinerary').lastUsed, clock.now);

  clock.now += threeDays - 1000;
  const third = browser(payload, '', webcrypto, { indexedDB: storage, clock });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(third.output.html, source);
  assert.equal(storage.records.get('itinerary').lastUsed, clock.now);
});

test('an idle session expires after three days and requires the password again', async () => {
  const payload = await encrypt(source, password);
  const storage = fakeIndexedDB();
  const clock = { now: 1_800_000_000_000 };
  const first = browser(payload, password, webcrypto, { indexedDB: storage, clock });
  await first.submit();

  clock.now += threeDays;
  const expired = browser(payload, '', webcrypto, { indexedDB: storage, clock });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(expired.output.html, null);
  assert.equal(storage.records.has('itinerary'), false);
});

test('a content rebuild with the same salt keeps an active session working', async () => {
  const firstPayload = await encrypt(source, password);
  const storage = fakeIndexedDB();
  const clock = { now: 1_800_000_000_000 };
  const first = browser(firstPayload, password, webcrypto, { indexedDB: storage, clock });
  await first.submit();

  const updatedSource = source.replace('Private winter itinerary', 'Updated winter itinerary');
  const updatedPayload = await encrypt(updatedSource, password, { salt: Buffer.from(firstPayload.salt, 'base64') });
  assert.equal(updatedPayload.salt, firstPayload.salt);
  assert.notEqual(updatedPayload.iv, firstPayload.iv);
  const updated = browser(updatedPayload, '', webcrypto, { indexedDB: storage, clock });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(updated.output.html, updatedSource);
});

test('activity in an open itinerary extends its three-day expiry', async () => {
  const storage = fakeIndexedDB();
  const clock = { now: 1_800_000_000_000 };
  const listeners = new Map();
  let reloads = 0;
  const context = vm.createContext({
    indexedDB: storage,
    Date: class extends Date { static now() { return clock.now; } },
    setTimeout: () => 1,
    clearTimeout() {},
    location: { reload() { reloads++; } },
    addEventListener(type, handler) { listeners.set(type, handler); },
    document: { addEventListener(type, handler) { listeners.set(type, handler); } }
  });
  vm.runInContext(sessionScript, context);
  const session = context.SnowRouteSession;
  await session.save({ nonExtractableKey: true }, 'site-salt');
  await session.startActivity('site-salt');

  clock.now += threeDays - 1000;
  await listeners.get('pointerdown')();
  assert.equal(storage.records.get('itinerary').lastUsed, clock.now);
  assert.equal(reloads, 0);

  clock.now += threeDays;
  await listeners.get('pointerdown')();
  assert.equal(storage.records.has('itinerary'), false);
  assert.equal(reloads, 1);
});

test('wrong passwords leave content locked and allow another attempt', async () => {
  const page = browser(await encrypt(source, password), 'wrong');
  await page.submit();
  assert.equal(page.output.html, null);
  assert.match(page.elements.get('unlock-error').textContent, /密碼唔啱/);
  assert.equal(page.elements.get('unlock').disabled, false);
  assert.equal(page.elements.get('password').attributes['aria-invalid'], 'true');
  page.elements.get('password').value = password;
  await page.submit();
  assert.equal(page.output.html, source);
});

test('tampering with encrypted content is rejected', async () => {
  const payload = await encrypt(source, password);
  const changed = Buffer.from(payload.ciphertext, 'base64');
  changed[0] ^= 1;
  payload.ciphertext = changed.toString('base64');
  const page = browser(payload, password);
  await page.submit();
  assert.equal(page.output.html, null);
});

test('fresh encryptions use new random salt, IV and ciphertext', async () => {
  const first = await encrypt(source, password);
  const second = await encrypt(source, password);
  for (const key of ['salt', 'iv', 'ciphertext']) assert.notEqual(first[key], second[key]);
  assert.ok(!JSON.stringify(first).includes(password));
  assert.ok(!JSON.stringify(first).includes('Private winter itinerary'));
  await assert.rejects(() => encrypt(source, ''), /password is required/);
});

test('unsupported browsers show a clear message without revealing content', async () => {
  const page = browser(await encrypt(source, password), password, {});
  await page.submit();
  assert.equal(page.output.html, null);
  assert.match(page.elements.get('unlock-error').textContent, /HTTPS/);
});

test('show-password control toggles its accessible state', async () => {
  const page = browser({}, password);
  page.reveal();
  assert.equal(page.elements.get('password').type, 'text');
  assert.equal(page.elements.get('reveal').attributes['aria-pressed'], 'true');
  page.reveal();
  assert.equal(page.elements.get('password').type, 'password');
  assert.equal(page.elements.get('reveal').attributes['aria-pressed'], 'false');
});
