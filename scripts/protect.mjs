import { webcrypto } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';

export const iterations = 600000;
const root = new URL('../', import.meta.url);
const encode = value => Buffer.from(value).toString('base64');

export async function encrypt(html, password) {
  if (!password) throw new Error('A password is required.');
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(html));
  return { version: 1, iterations, salt: encode(salt), iv: encode(iv), ciphertext: encode(ciphertext) };
}

export async function build(password) {
  const source = await readFile(new URL('.private/itinerary.html', root), 'utf8');
  const bears = '<img class="bear-couple" src="assets/yier-bubu.png" width="512" height="512" alt="一二攬住布布的原角色貼圖" decoding="async">';
  const template = await readFile(new URL('scripts/gate.html', root), 'utf8');
  const payload = await encrypt(source, password);
  const output = template.replace('<!-- CHARACTERS -->', bears).replace('__ENCRYPTED_PAYLOAD__', JSON.stringify(payload));
  await writeFile(new URL('index.html', root), output);
  console.log('Encrypted index.html rebuilt. The password and editable source are not included in the published files.');
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return input.replace(/\r?\n$/, '');
  }
  process.stdout.write('Website password (hidden): ');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const finish = () => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') { finish(); reject(new Error('Cancelled.')); }
      else if (key.name === 'return' || key.name === 'enter') { finish(); resolve(password); }
      else if (key.name === 'backspace') password = [...password].slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text) password += text;
    };
    process.stdin.on('keypress', onKey);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await build(await readPassword()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
