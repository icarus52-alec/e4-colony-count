const bridge = window.e4SyncBridge;
const config = window.E4_FIREBASE_CONFIG || {};
const syncButton = document.getElementById('syncButton');
const ownerUid = String(config.ownerUid || '');
const version = '12.18.0';
let currentUser = null;
let ready = false;
let busy = false;
let rerun = false;
let timer = null;
let authApi;
let firestoreApi;
let auth;
let db;
let sessionsCollection;
const uploadedSessions = new Map();
const uploadedPhotos = new Set();
const dirtyPhotos = new Set();

const setStatus = (label, detail) => bridge.setStatus(label, detail);
const isOwner = () => currentUser?.uid === ownerUid;
bridge.isSignedIn = isOwner;

const stable = value => JSON.stringify(value, (_, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.keys(item).sort().reduce((sorted, key) => {
    sorted[key] = item[key];
    return sorted;
  }, {});
});

async function documentId(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function scheduleSync() {
  if (!ready || !isOwner()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { flush().catch(() => {}); }, 900);
}

bridge.onSave(scheduleSync);
bridge.onPhotoSaved(id => { dirtyPhotos.add(id); scheduleSync(); });
bridge.onPhotoDeleted(scheduleSync);

if (!['apiKey', 'authDomain', 'projectId', 'appId', 'ownerUid'].every(key => String(config[key] || '').trim())) {
  setStatus('同步尚未設定', '本機計數與照片仍可使用。');
} else {
  start().catch(error => {
    console.error('E4 Firebase setup failed.', error);
    setStatus('同步連線失敗', '請檢查網路或稍後重試；本機資料仍已儲存。');
  });
}

async function start() {
  const [{ initializeApp }, authModule, firestoreModule] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-firestore.js`)
  ]);
  authApi = authModule;
  firestoreApi = firestoreModule;
  const app = initializeApp(config, 'e4-colony-count');
  auth = authApi.getAuth(app);
  db = firestoreApi.getFirestore(app);
  sessionsCollection = firestoreApi.collection(db, 'e4Owners', ownerUid, 'sessions');
  await authApi.setPersistence(auth, authApi.browserLocalPersistence);
  window.e4CloudDownloadPhoto = downloadPhoto;

  const handleSyncClick = async () => {
    if (isOwner()) {
      await authApi.signOut(auth);
      return;
    }
    try {
      const provider = new authApi.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await authApi.signInWithPopup(auth, provider);
    } catch (error) {
      if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(error.code)) {
        await authApi.signInWithRedirect(auth, new authApi.GoogleAuthProvider());
      } else if (error.code !== 'auth/popup-closed-by-user') {
        console.error('E4 sign-in failed.', error);
        setStatus('登入失敗', error.code === 'auth/unauthorized-domain' ? '請在 Firebase 加入 GitHub Pages 授權網域。' : '請再試一次登入。');
      }
    }
  };
  syncButton.onclick = handleSyncClick;

  authApi.onAuthStateChanged(auth, async user => {
    currentUser = user;
    ready = false;
    clearTimeout(timer);
    if (user && !isOwner()) {
      setStatus('帳號不符', '只有配方庫管理帳號可以同步 E4 紀錄。');
      await authApi.signOut(auth);
      return;
    }
    if (!user) {
      setStatus('登入以同步', '尚未登入；計數與照片保存在目前裝置。');
      return;
    }
    setStatus('同步中…', '正在合併此裝置與雲端的 E4 紀錄。');
    try {
      await initialSync();
      ready = true;
      await flush();
      syncButton.onclick = handleSyncClick;
    } catch (error) {
      console.error('E4 initial sync failed.', error);
      setStatus('同步失敗，點此重試', error.code === 'permission-denied'
        ? '請先在 Firebase 發布 E4 專用的私人 Firestore 規則。'
        : '資料仍保存在此裝置；請檢查網路後重試。');
      syncButton.onclick = async () => {
        setStatus('同步中…', '正在重新嘗試同步。');
        try { await initialSync(); ready = true; await flush(); syncButton.onclick = handleSyncClick; }
        catch (retryError) { console.error(retryError); setStatus('同步失敗，點此重試', '請檢查 Firebase 規則或網路。'); }
      };
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ready && !busy) refresh();
  });
  setInterval(() => { if (document.visibilityState === 'visible' && ready && !busy) refresh(); }, 30000);
}

async function initialSync() {
  const snapshot = await firestoreApi.getDocsFromServer(sessionsCollection);
  const remote = {};
  snapshot.forEach(item => {
    const data = item.data();
    if (data.key && data.session) remote[data.key] = data.session;
  });
  uploadedSessions.clear();
  Object.entries(remote).forEach(([key, session]) => uploadedSessions.set(key, stable(session)));
  bridge.mergeCloudSessions(remote);
}

async function refresh() {
  try { await initialSync(); await flush(); syncButton.onclick = async () => authApi.signOut(auth); }
  catch (error) { console.error('E4 refresh failed.', error); setStatus('同步暫停，點此重試', '本機資料已保存；請檢查網路。'); syncButton.onclick = refresh; }
}

async function flush() {
  if (!isOwner() || !ready) return;
  if (busy) { rerun = true; return; }
  busy = true;
  setStatus('同步中…', '正在同步計數與照片。');
  try {
    for (const key of bridge.getPendingSessionDeletes()) {
      await firestoreApi.deleteDoc(firestoreApi.doc(sessionsCollection, await documentId(key)));
      uploadedSessions.delete(key);
      bridge.markSessionDeleted(key);
    }
    const referenced = new Set(bridge.getPhotoIds());
    for (const id of bridge.getPendingPhotoDeletes()) {
      if (!referenced.has(id)) await removeRemotePhoto(id);
      bridge.markPhotoDeleted(id);
    }
    for (const id of referenced) {
      const blob = await bridge.getLocalPhoto(id);
      if (blob) await uploadPhoto(id, blob);
    }
    for (const [key, session] of Object.entries(bridge.getSessions())) {
      if (!session.sampleName) continue;
      const value = stable(session);
      if (uploadedSessions.get(key) === value) continue;
      const ref = firestoreApi.doc(sessionsCollection, await documentId(key));
      await firestoreApi.setDoc(ref, { key, session, updatedAt: firestoreApi.serverTimestamp() });
      uploadedSessions.set(key, value);
    }
    setStatus('已同步 · 登出', `已連結 ${currentUser.email}；本機和雲端均有紀錄。`);
  } catch (error) {
    console.error('E4 sync failed.', error);
    setStatus('同步失敗，點此重試', error.code === 'permission-denied'
      ? '請先在 Firebase 發布 E4 專用的私人 Firestore 規則。'
      : '本機資料仍已保存；請檢查網路後重試。');
    syncButton.onclick = () => flush();
    throw error;
  } finally {
    busy = false;
    if (rerun) { rerun = false; scheduleSync(); }
  }
}

async function photoRef(id) {
  return firestoreApi.doc(db, 'e4Owners', ownerUid, 'photos', await documentId(id));
}

async function uploadPhoto(id, blob) {
  if (uploadedPhotos.has(id) && !dirtyPhotos.has(id)) return;
  const ref = await photoRef(id);
  const existing = await firestoreApi.getDoc(ref);
  if (existing.exists() && !dirtyPhotos.has(id)) { uploadedPhotos.add(id); return; }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const chunks = dataUrl.match(/.{1,300000}/g) || [];
  for (let i = 0; i < chunks.length; i++) {
    await firestoreApi.setDoc(firestoreApi.doc(ref, 'parts', String(i)), { data: chunks[i] });
  }
  const prior = existing.exists() ? Number(existing.data().partCount || 0) : 0;
  for (let i = chunks.length; i < prior; i++) await firestoreApi.deleteDoc(firestoreApi.doc(ref, 'parts', String(i)));
  await firestoreApi.setDoc(ref, { photoId: id, partCount: chunks.length, mimeType: blob.type, updatedAt: firestoreApi.serverTimestamp() });
  uploadedPhotos.add(id);
  dirtyPhotos.delete(id);
}

async function downloadPhoto(id) {
  if (!isOwner()) return undefined;
  const ref = await photoRef(id);
  const meta = await firestoreApi.getDoc(ref);
  if (!meta.exists()) return undefined;
  const count = Number(meta.data().partCount || 0);
  if (count < 1 || count > 100) throw new Error('Invalid E4 photo chunk count');
  const parts = await Promise.all(Array.from({ length: count }, (_, i) => firestoreApi.getDoc(firestoreApi.doc(ref, 'parts', String(i)))));
  if (parts.some(part => !part.exists())) throw new Error('E4 photo is incomplete');
  const dataUrl = parts.map(part => part.data().data).join('');
  return fetch(dataUrl).then(response => response.blob());
}

async function removeRemotePhoto(id) {
  const ref = await photoRef(id);
  const meta = await firestoreApi.getDoc(ref);
  if (!meta.exists()) return;
  const count = Number(meta.data().partCount || 0);
  for (let i = 0; i < count; i++) await firestoreApi.deleteDoc(firestoreApi.doc(ref, 'parts', String(i)));
  await firestoreApi.deleteDoc(ref);
  uploadedPhotos.delete(id);
}
