(() => {
  const databaseName = 'snow-route-2027-auth';
  const storeName = 'sessions';
  const sessionId = 'itinerary';
  const lifetime = 3 * 24 * 60 * 60 * 1000;

  function transact(mode, action) {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const opening = indexedDB.open(databaseName, 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore(storeName);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        let result;
        let transaction;
        try {
          transaction = db.transaction(storeName, mode);
          const request = action(transaction.objectStore(storeName));
          request.onsuccess = () => { result = request.result; };
          request.onerror = () => reject(request.error);
          transaction.oncomplete = () => { db.close(); resolve(result); };
          transaction.onerror = () => { db.close(); reject(transaction.error); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        } catch (error) {
          db.close();
          reject(error);
        }
      };
    });
  }

  const read = () => transact('readonly', store => store.get(sessionId));
  const clear = () => transact('readwrite', store => store.delete(sessionId));
  const save = (key, salt, lastUsed = Date.now()) =>
    transact('readwrite', store => store.put({ key, salt, lastUsed }, sessionId));
  const isValid = (entry, salt, now = Date.now()) =>
    !!entry?.key && entry.salt === salt && Number.isFinite(entry.lastUsed) &&
    now >= entry.lastUsed && now - entry.lastUsed < lifetime;

  async function startActivity(salt) {
    let entry;
    try { entry = await read(); } catch { return; }
    if (!entry) return;

    let lastTouch = entry.lastUsed;
    let timer;
    let touching = false;
    const scheduleExpiry = () => {
      clearTimeout(timer);
      timer = setTimeout(checkExpiry, Math.max(0, lastTouch + lifetime - Date.now()));
    };
    const lock = async () => {
      try { await clear(); } catch {}
      location.reload();
    };
    const checkExpiry = async () => {
      try {
        const current = await read();
        if (!isValid(current, salt)) return lock();
        lastTouch = current.lastUsed;
        scheduleExpiry();
      } catch { /* Storage may be unavailable while the page remains open. */ }
    };
    const touch = async () => {
      if (touching) return;
      touching = true;
      const now = Date.now();
      try {
        if (now < lastTouch) return lock();
        const current = await read();
        if (!isValid(current, salt, now)) return lock();
        await save(current.key, salt, now);
        lastTouch = now;
        scheduleExpiry();
      } catch { /* Keep the already open page usable if storage fails. */ }
      finally { touching = false; }
    };

    if (!isValid(entry, salt)) return lock();
    scheduleExpiry();
    addEventListener('focus', touch);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) touch(); });
    document.addEventListener('pointerdown', touch, { passive: true });
    document.addEventListener('keydown', touch);
  }

  globalThis.SnowRouteSession = { read, clear, save, isValid, startActivity };
})();
