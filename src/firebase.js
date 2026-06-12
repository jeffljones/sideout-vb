import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

/* Paste the real web-app config here, from:
   Firebase console → ⚙️ Project settings → Your apps → SIDEOUT (Web).
   This object is public-safe by design — access control lives in
   firestore.rules, not in the config. */
export const firebaseConfig = {
  apiKey: "AIzaSyAlsM5okZXHx5fkgqjVYCO5RAbl_DSolMY",
  authDomain: "sideout-vb.firebaseapp.com",
  projectId: "sideout-vb",
  storageBucket: "sideout-vb.firebasestorage.app",
  messagingSenderId: "972336973317",
  appId: "1:972336973317:web:65fe6e3ac9b659cbb57e6c",
  measurementId: "G-PYV3BJV732",
};

export const configReady = !Object.values(firebaseConfig).some((v) => String(v).includes("PASTE_ME"));

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
