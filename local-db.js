'use strict';

// Large persistent local storage layer. IndexedDB is used as the primary
// offline store, while localStorage remains a small synchronous fallback.
window.WatanLocalDB = (() => {
    const DB_NAME = 'WatanExchangeLocal';
    const DB_VERSION = 1;
    const STORE_NAME = 'appState';
    const STATE_KEY = 'main';

    function openDatabase() {
        return new Promise((resolve, reject) => {
            if(!('indexedDB' in window)) {
                reject(new Error('IndexedDB is not supported'));
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if(!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
        });
    }

    async function get() {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, 'readonly');
            const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
            transaction.oncomplete = () => database.close();
            transaction.onerror = () => database.close();
        });
    }

    async function set(value) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).put(value, STATE_KEY);
            transaction.oncomplete = () => {
                database.close();
                resolve(true);
            };
            transaction.onerror = () => {
                const error = transaction.error || new Error('IndexedDB write failed');
                database.close();
                reject(error);
            };
            transaction.onabort = transaction.onerror;
        });
    }

    async function remove() {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).delete(STATE_KEY);
            transaction.oncomplete = () => {
                database.close();
                resolve(true);
            };
            transaction.onerror = () => {
                const error = transaction.error || new Error('IndexedDB delete failed');
                database.close();
                reject(error);
            };
            transaction.onabort = transaction.onerror;
        });
    }

    async function requestPersistentStorage() {
        try {
            if(!navigator.storage?.persist) return false;
            if(await navigator.storage.persisted?.()) return true;
            return await navigator.storage.persist();
        } catch(error) {
            console.warn('Persistent storage request failed:', error);
            return false;
        }
    }

    async function estimate() {
        try {
            if(!navigator.storage?.estimate) return null;
            return await navigator.storage.estimate();
        } catch(error) {
            return null;
        }
    }

    return { get, set, remove, requestPersistentStorage, estimate };
})();
