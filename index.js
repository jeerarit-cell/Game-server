const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ==========================================
// 1. FIREBASE ADMIN SETUP
// ==========================================
let serviceAccount;
try {
  if (!process.env.FIREBASE_KEY) throw new Error("Missing FIREBASE_KEY");
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (error) {
  console.error("❌ FIREBASE INIT ERROR:", error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ==========================================
// 2. SMART CONTRACT & GAME CONFIG
// ==========================================
const RPC_URL = process.env.RPC_URL || "https://worldchain-mainnet.g.alchemy.com/public";
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;
const VAULT_ADDRESS = process.env.CONTRACT_ADDRESS;
const SELL_RATE = Number(process.env.SELL_RATE_COIN_PER_WLD) || 1100;

// 🌟 ตัวแปรควบคุมขั้นต่ำ (ดึงจาก .env หรือใช้ Default)
const MIN_BUY_WLD = Number(process.env.MIN_BUY_WLD) || 0.1;
const MIN_WITHDRAW_COIN = Number(process.env.MIN_WITHDRAW_COIN) || 1100;

if (!PRIVATE_KEY || !VAULT_ADDRESS) {
  console.error("❌ MISSING CONFIG: ตรวจสอบ SIGNER_PRIVATE_KEY หรือ CONTRACT_ADDRESS");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const DAILY_GAME_LIMIT = 10000;
const monsterDB = [
    { id: 1, name: "Duck Fighter", hp: 20, type: "common" },
    { id: 2, name: "Dog Fighter", hp: 20, type: "common" },
    { id: 3, name: "Scorpion Fighter", hp: 20, type: "common" },
    { id: 4, name: "Rabbit Fighter", hp: 20, type: "common" },
    { id: 5, name: "Wolf Fighter", hp: 20, type: "common" },
    { id: 6, name: "Fire Gobin", hp: 30, type: "miniboss" }, 
    { id: 7, name: "THE OVERLORD", hp: 40, type: "boss" },
    { id: 8, name: "GOLDEN DRAGON", hp: 50, type: "legendary" }
];
const levelConfig = { 1: { need: 150 }, 2: { need: 300 }, 3: { need: 450 }, 4: { need: 700 }, 5: { need: 1000 } };
const expReward = { 'common': 1, 'miniboss': 2, 'boss': 3, 'legendary': 5 };

// ==========================================
// API 0 & 1: GET PLAYER & REGISTER
// ==========================================
app.post("/api/get-player", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: "Missing userId" });
    const userRef = db.collection("users").doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) return res.json({ success: false, message: "USER_NOT_FOUND" });
    res.json({ success: true, data: doc.data() });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { userId, wallet, name } = req.body;
    const userRef = db.collection("users").doc(userId);
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (doc.exists && doc.data().walletBound) throw new Error("USER_ALREADY_REGISTERED");
      t.set(userRef, {
        name, walletAddress: wallet, walletBound: true, coin: 40, level: 1, hp: 20, exp: 0,
        earnedFromGameToday: 0, lastRewardDate: new Date().toDateString(), createdAt: new Date().toISOString()
      }, { merge: true });
    });
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==========================================
// API 1.5: BUY COINS (ระบบเดิม - เช็ค 0.1 WLD)
// ==========================================
app.post("/api/buy-coins", async (req, res) => {
  try {
    const { userId, amountBought, reference, wldAmount } = req.body;
    if (Number(wldAmount) < MIN_BUY_WLD) {
      return res.status(400).json({ success: false, message: `ขั้นต่ำในการซื้อคือ ${MIN_BUY_WLD} WLD` });
    }
    const userRef = db.collection("users").doc(userId);
    const txRef = db.collection("transactions").doc(String(reference));

    const newBalance = await db.runTransaction(async (t) => {
      if ((await t.get(txRef)).exists) throw new Error("REFERENCE_ALREADY_USED");
      const userDoc = await t.get(userRef);
      let currentCoin = Number(userDoc.data().coin) || 0;
      currentCoin += Number(amountBought);
      t.update(userRef, { coin: currentCoin });
      t.set(txRef, { userId, type: "BUY", source: "WLD_LEGACY", amountCoin: Number(amountBought), wldAmount: Number(wldAmount), timestamp: admin.firestore.FieldValue.serverTimestamp() });
      return currentCoin;
    });
    res.json({ success: true, newBalance });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ==========================================
// API 2 & 3: BATTLE START & ACTION
// ==========================================
// (คงเดิมตามที่คุณส่งมา เพื่อความถูกต้องของ Logic เกม)
app.post("/api/battle-start", async (req, res) => {
    try {
      const { userId, monsterId } = req.body;
      const monster = monsterDB.find(m => m.id === monsterId);
      const userRef = db.collection("users").doc(userId);
      const newBalance = await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        let userData = doc.data();
        let entryFee = 20 + ((Number(userData.level) || 1) - 1) * 2;
        if (userData.coin < entryFee) throw new Error("INSUFFICIENT_COIN");
        t.update(userRef, { coin: userData.coin - entryFee, inBattle: true, b_monsterId: monsterId, b_eHp: monster.hp, b_pHp: entryFee, b_multiplier: 1 });
        return userData.coin - entryFee;
      });
      res.json({ success: true, newBalance });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post("/api/battle-action", async (req, res) => {
    try {
      const { userId, playerDeck } = req.body;
      const userRef = db.collection("users").doc(userId);
      const payload = await db.runTransaction(async (t) => {
          const doc = await t.get(userRef);
          const userData = doc.data();
          if (!userData.inBattle) throw new Error("NO_ACTIVE_BATTLE");
          const monster = monsterDB.find(m => m.id === userData.b_monsterId);
          
          let enemyDeck = [1, 2, 3, 4, 5].sort(() => Math.random() - 0.5);
          let pDmg = 0; let eDmg = 0;
          for(let i=0; i<5; i++) {
              if (playerDeck[i] > enemyDeck[i]) pDmg += playerDeck[i];
              else if (enemyDeck[i] > playerDeck[i]) eDmg += enemyDeck[i];
          }

          let eHp = userData.b_eHp - (pDmg * userData.b_multiplier);
          let pHp = userData.b_pHp - (eDmg * userData.b_multiplier);
          let status = (eHp <= 0 && pHp <= 0) ? "double_ko" : (eHp <= 0) ? "win" : (pHp <= 0) ? "lose" : "playing";

          // อัปเดตผลตาม Status (Logic เดิมของคุณ)
          if(status === "playing" || status === "double_ko") {
              t.update(userRef, { b_eHp: eHp <= 0 ? monster.hp : eHp, b_pHp: pHp <= 0 ? (20 + (userData.level-1)*2) : pHp, b_multiplier: status === "double_ko" ? 2 : 1 });
          } else {
              t.update(userRef, { inBattle: false, coin: userData.coin + (status === "win" ? (monster.hp + (20 + (userData.level-1)*2)) : 0), b_eHp: admin.firestore.FieldValue.delete(), b_pHp: admin.firestore.FieldValue.delete() });
          }
          return { enemyDeck, eHp, pHp, battleStatus: status };
      });
      res.json({ success: true, data: payload });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ==========================================
// API 4 & 5: WITHDRAW SYSTEM (เช็ค 1,100 Coin)
// ==========================================
app.post("/api/withdraw", async (req, res) => {
  try {
    const { userId, amount } = req.body;
    const requestAmount = Number(amount);
    if (requestAmount < MIN_WITHDRAW_COIN) return res.status(400).json({ success: false, message: `ถอนขั้นต่ำ ${MIN_WITHDRAW_COIN} Coins` });

    const userRef = db.collection("users").doc(userId);
    const doc = await userRef.get();
    const userData = doc.data();
    if (!doc.exists || userData.coin < requestAmount) throw new Error("INSUFFICIENT_FUNDS");

    const amountWei = (BigInt(requestAmount) * 10n ** 18n) / BigInt(SELL_RATE);
    const nonce = Date.now();
    const packedData = ethers.solidityPackedKeccak256(["address", "uint256", "uint256", "address"], [userData.walletAddress, amountWei, nonce, VAULT_ADDRESS]);
    const signature = await signer.signMessage(ethers.getBytes(packedData));

    res.json({ success: true, claimData: { amount: amountWei.toString(), nonce, signature, vaultAddress: VAULT_ADDRESS } });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post("/api/withdraw-success", async (req, res) => {
    try {
      const { userId, amount, nonce } = req.body;
      const txRef = db.collection("transactions").doc(String(nonce));
      await db.runTransaction(async (t) => {
        if ((await t.get(txRef)).exists) throw new Error("ALREADY_DEDUCTED");
        const userRef = db.collection("users").doc(userId);
        const userData = (await t.get(userRef)).data();
        t.update(userRef, { coin: userData.coin - Number(amount) });
        t.set(txRef, { userId, type: "SELL", amountCoin: Number(amount), timestamp: admin.firestore.FieldValue.serverTimestamp() });
      });
      res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

// ==========================================
// API NEW: CLAIM CHASER (ระบบใหม่ - No Limit)
// ==========================================
app.post("/api/claim-chaser", async (req, res) => {
  try {
    const { userId, wldTxHash, amountWld } = req.body;
    const tx = await provider.getTransaction(wldTxHash);
    if (!tx || tx.to.toLowerCase() !== process.env.WLD_POOL_WALLET.toLowerCase()) throw new Error("INVALID_TX");

    const swapRef = db.collection("chaser_swaps").doc(wldTxHash);
    const userRef = db.collection("users").doc(userId);

    const claimData = await db.runTransaction(async (t) => {
      if ((await t.get(swapRef)).exists) throw new Error("TX_USED");
      const userData = (await t.get(userRef)).data();
      
      const chaserRate = Number(process.env.CHASER_RATE) || 10000;
      const finalAmount = Number(amountWld) * chaserRate * 1.02;
      const amountWei = ethers.parseUnits(finalAmount.toFixed(0), 18);
      const nonce = Date.now();
      const deadline = Math.floor(Date.now() / 1000) + 600;

      t.set(swapRef, { userId, source: "CHASER_SWAP", wldAmount: Number(amountWld), status: "PENDING", timestamp: admin.firestore.FieldValue.serverTimestamp() });
      
      const packedData = ethers.solidityPackedKeccak256(["address", "uint256", "uint256", "uint256", "address"], [userData.walletAddress, amountWei, nonce, deadline, process.env.CHASER_VAULT_ADDRESS]);
      const signature = await signer.signMessage(ethers.getBytes(packedData));
      return { amount: amountWei.toString(), nonce, deadline, signature };
    });
    res.json({ success: true, claimData });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

// ==========================================
// OTHER: FEED & CLEANUP & PING
// ==========================================
app.get("/api/kill-feed", async (req, res) => {
    const snap = await db.collection('kill_feed').orderBy('timestamp', 'desc').limit(5).get();
    res.json({ success: true, data: snap.docs.map(d => d.data()) });
});

app.get("/ping", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
