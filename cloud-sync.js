(function attachCloudSync(root) {
  "use strict";

  let app = null;
  let db = null;

  function isConfigured() {
    const config = root.FIREBASE_CONFIG;
    return Boolean(
      config &&
      config.apiKey &&
      config.projectId &&
      typeof root.firebase !== "undefined"
    );
  }

  function ensureDb() {
    if (db) return db;
    if (!isConfigured()) return null;
    app = root.firebase.apps && root.firebase.apps.length
      ? root.firebase.app()
      : root.firebase.initializeApp(root.FIREBASE_CONFIG);
    db = root.firebase.firestore();
    return db;
  }

  function normalizeSyncCode(code) {
    return String(code || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 64);
  }

  function docRefFor(code) {
    const database = ensureDb();
    const normalized = normalizeSyncCode(code);
    if (!database || !normalized) return null;
    return database.collection("worksheetLibraries").doc(normalized);
  }

  async function pushLibrary(code, entries) {
    const ref = docRefFor(code);
    if (!ref) throw new Error("동기화가 설정되지 않았습니다.");
    await ref.set({
      entries,
      updatedAt: root.firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  function watchLibrary(code, onChange, onError) {
    const ref = docRefFor(code);
    if (!ref) {
      if (onError) onError(new Error("동기화가 설정되지 않았습니다."));
      return () => {};
    }
    return ref.onSnapshot(snapshot => {
      const data = snapshot.data();
      onChange(data && Array.isArray(data.entries) ? data.entries : []);
    }, onError);
  }

  root.CloudSync = Object.freeze({
    isConfigured,
    normalizeSyncCode,
    pushLibrary,
    watchLibrary
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
