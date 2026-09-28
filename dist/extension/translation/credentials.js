/** Extension-origin IndexedDB is inaccessible to webpage-origin content scripts. */
export function createCredentialStore() {
  let connection;
  const open = () => {
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('ezr-private', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('credentials');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { connection = null; reject(new Error('无法打开本机密钥存储。')); };
    });
    return connection;
  };
  async function access(write, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('credentials', write ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('credentials');
      const request = write ? (value ? store.put(value, 'deepseek') : store.delete('deepseek')) : store.get('deepseek');
      let result = '';
      request.onsuccess = () => { result = typeof request.result === 'string' ? request.result : ''; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(new Error('无法读写本机密钥，请检查浏览器存储。'));
    });
  }
  return { get: () => access(false), set: value => access(true, value) };
}
