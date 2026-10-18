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

function browser(payload, enteredPassword, crypto = webcrypto) {
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
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    location: { hash: '' }, requestAnimationFrame: handler => handler(),
    document: {
      getElementById: id => elements.get(id),
      open() { output.opened = true; },
      write(html) { output.html = html; },
      close() { output.closed = true; }
    }
  });
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

test('rebuilds use new random salt, IV and ciphertext', async () => {
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
