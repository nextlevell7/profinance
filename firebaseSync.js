// firebaseSync.js - ProFinance Real-Time Cloud Sync Engine
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getFirestore, doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDEpp5kHf1jv3m_ymchAnOSR5Er7Yzq-7w",
  authDomain: "profinance-64ba1.firebaseapp.com",
  projectId: "profinance-64ba1",
  storageBucket: "profinance-64ba1.firebasestorage.app",
  messagingSenderId: "901101542022",
  appId: "1:901101542022:web:51cc3e21f6c87b55f44f07",
  measurementId: "G-08YD7BGT7K"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const SYNC_KEYS = [
  'profinance_app_data',
  'profinance_cards',
  'profinance_budgets',
  'profinance_custom_cats',
  'profinance_custom_origins',
  'profinance_deleted_origins',
  'profinance_deleted_cats',
  'profinance_fixed_bills',
  'profinance_business_profile',
  'profinance_business_taxes'
];

let isReceivingFromCloud = false;
let activeListeners = [];
let lastKnownPayloads = {};
let currentActiveClientKey = null;

export function getSyncClientKey() {
  const saved = localStorage.getItem('profinance_saved_client_key');
  if (saved && saved.trim()) return saved.trim();

  // Apenas Administrador Master autenticado na sessão tem acesso ao canal 'admin_master'
  const adminPass = sessionStorage.getItem('profinance_admin_pass');
  const isMasterAuthed = adminPass && (
    adminPass === '9937314286890361836671256cf88709c26bef673d201989e89f73611b55e77b' ||
    (typeof window !== 'undefined' && window.currentAuthSession && window.currentAuthSession.role === 'admin')
  );

  if (isMasterAuthed) {
    return 'admin_master';
  }

  // Sem autenticação: NUNCA sincronizar com conta de terceiros
  return null;
}

function pushToCloud(key, payload, clientKey) {
  if (!payload || isReceivingFromCloud || !clientKey) return;
  lastKnownPayloads[key] = payload;
  const cloudDocId = `${clientKey}_${key}`;
  setDoc(doc(db, "sync_data", cloudDocId), {
    payload: payload,
    timestamp: Date.now()
  }, { merge: true }).catch(err => console.error("Erro Nuvem:", err));
}

export function initFirebaseSync() {
  const clientKey = getSyncClientKey();
  if (!clientKey) {
    activeListeners.forEach(unsub => { try { unsub(); } catch(e){} });
    activeListeners = [];
    currentActiveClientKey = null;
    return;
  }

  if (currentActiveClientKey === clientKey && activeListeners.length > 0) {
    return;
  }
  currentActiveClientKey = clientKey;
  console.log(`🔥 Firebase Sync Inicializado para conta isolada: ${clientKey}`);

  activeListeners.forEach(unsub => { try { unsub(); } catch(e){} });
  activeListeners = [];

  if (!window._firebaseSyncPatched) {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      originalSetItem.apply(this, arguments);
      if (SYNC_KEYS.includes(key) && !isReceivingFromCloud) {
        const cKey = getSyncClientKey();
        if (cKey) {
          pushToCloud(key, value, cKey);
        }
      }
    };
    window._firebaseSyncPatched = true;
  }

  SYNC_KEYS.forEach(key => {
    lastKnownPayloads[key] = localStorage.getItem(key) || null;
    const cloudDocId = `${clientKey}_${key}`;

    const unsub = onSnapshot(doc(db, "sync_data", cloudDocId), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        if (data && data.payload !== undefined && data.payload !== lastKnownPayloads[key]) {
          console.log(`📥 Atualização da nuvem recebida para [${key}]`);
          lastKnownPayloads[key] = data.payload;
          isReceivingFromCloud = true;
          if (data.payload === null || data.payload === undefined) {
            localStorage.removeItem(key);
          } else {
            localStorage.setItem(key, data.payload);
          }
          isReceivingFromCloud = false;
          window.dispatchEvent(new CustomEvent('cloudSyncUpdate', { detail: key }));
        }
      } else {
        // Documento na nuvem ainda não existe para este usuário
        // Só faz upload se for admin_master (migração inicial)
        if (clientKey === 'admin_master') {
          const localVal = localStorage.getItem(key);
          if (localVal) {
            pushToCloud(key, localVal, clientKey);
          }
        }
        // Para contas de clientes novos: nunca sobe resíduos de outros usuários! Começa limpo.
      }
    }, (err) => {
      console.error(`Firebase snapshot error for ${cloudDocId}:`, err);
    });
    activeListeners.push(unsub);
  });
}

initFirebaseSync();

window.addEventListener('clientLoggedIn', initFirebaseSync);
window.addEventListener('focus', () => {
  if (getSyncClientKey() !== currentActiveClientKey) {
    initFirebaseSync();
  }
});
window.addEventListener('storage', (e) => {
  if (e.key === 'profinance_saved_client_key' || e.key === 'profinance_active_scope') {
    initFirebaseSync();
  }
});
