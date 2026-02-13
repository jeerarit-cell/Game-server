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
  console.error("❌ FIREBASE INIT ERROR: ตรวจสอบ FIREBASE_KEY\n", error.message);
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

if (!PRIVATE_KEY || !VAULT_ADDRESS) {
  console.error("❌ MISSING CONFIG: ตรวจสอบ SIGNER_PRIVATE_KEY หรือ CONTRACT_ADDRESS");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// 🌟 Game Config
const DAILY_GAME_LIMIT = 10000;
const levelConfig = { 1: { need: 150 }, 2: { need: 300 }, 3: { need: 450 }, 4: { need: 700 }, 5: { need: 1000 } };
const expReward = { 'common': 1, 'miniboss': 2, 'boss': 3, 'legendary': 5 };
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

// ==========================================
// API 1: REGISTER (สร้างตัวละคร & แจกเงินเริ่มต้น)
// ==========================================
app.post("/api/register", async (req, res) => {
  try {
    const { userId, wallet, name } = req.body;
    if (!userId || !wallet || !name) return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });

    const userRef = db.collection("users").doc(userId);

    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (doc.exists && doc.data().walletBound) throw new Error("USER_ALREADY_REGISTERED");

      t.set(userRef, {
        name: name,
        walletAddress: wallet,
        walletBound: true,
        coin: 40,          
        level: 1,           
        hp: 20,             
        exp: 0,
        earnedFromGameToday: 0,
        lastRewardDate: new Date().toDateString(),
        createdAt: new Date().toISOString(),
      }, { merge: true });
    });

    res.json({ success: true, message: "ลงทะเบียนผู้เล่นใหม่สำเร็จ" });
  } catch (error) {
    console.error("Register Error:", error);
    res.status(400).json({ success: false, message: error.message === "USER_ALREADY_REGISTERED" ? "ไอดีนี้ลงทะเบียนไปแล้ว" : "เกิดข้อผิดพลาด" });
  }
});

// ==========================================
// API 2: BATTLE START (หักเงินค่าเข้าก่อนสู้)
// ==========================================
app.post("/api/battle-start", async (req, res) => {
  try {
    const { userId, monsterId } = req.body;
    if (!userId || !monsterId) return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });

    const monster = monsterDB.find(m => m.id === monsterId);
    if (!monster) return res.status(400).json({ success: false, message: "ไม่พบมอนสเตอร์" });

    const userRef = db.collection("users").doc(userId);

    const newBalance = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("USER_NOT_FOUND");

      let userData = doc.data();
      let currentCoin = Number(userData.coin) || 0;
      let entryFee = 20 + ((Number(userData.level) || 1) - 1) * 2; // ค่าเข้า = Max HP ปัจจุบัน

      if (currentCoin < entryFee) throw new Error("INSUFFICIENT_COIN");

      // หักเงินทันที! ป้องกันการหนีออกเกม
      currentCoin -= entryFee;
      t.update(userRef, { coin: currentCoin });

      return currentCoin;
    });

    res.json({ success: true, newBalance: newBalance });
  } catch (error) {
    console.error("Battle Start Error:", error);
    res.status(400).json({ success: false, message: error.message === "INSUFFICIENT_COIN" ? "เงิน COIN ไม่พอ" : "เกิดข้อผิดพลาด" });
  }
});

// ==========================================
// API 3: BATTLE RESULT (คำนวณรางวัลตอนสู้จบ)
// ==========================================
app.post("/api/battle-result", async (req, res) => {
  try {
    const { userId, monsterId, result, playerHpPercent, enemyHpPercent } = req.body;
    if (!userId || !monsterId || !result) return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });

    const monster = monsterDB.find(m => m.id === monsterId);
    if (!monster) return res.status(400).json({ success: false, message: "ไม่พบมอนสเตอร์" });

    const userRef = db.collection("users").doc(userId);

    const payloadToFrontend = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("USER_NOT_FOUND");

      let userData = doc.data();
      let currentCoin = Number(userData.coin) || 0;
      let currentLevel = Number(userData.level) || 1;
      let currentExp = Number(userData.exp) || 0;
      let maxHp = 20 + ((currentLevel - 1) * 2);
      let entryFee = maxHp; // ค่าเข้าที่จ่ายไปแล้ว
      
      let earnedToday = Number(userData.earnedFromGameToday) || 0;
      let lastRewardDate = userData.lastRewardDate || "";
      
      const today = new Date().toDateString();
      if (today !== lastRewardDate) {
        earnedToday = 0;
        lastRewardDate = today;
      }

      let rewardCoin = 0; let rewardExp = 0; let feeRefund = 0;
      let isLevelUp = false; let hitDailyLimit = false; let allowedProfit = 0;

      // ==========================================================
      // 🏆 คำนวณเงินใหม่ (เพราะผู้เล่นโดนหักเงินไปแล้วใน Battle Start)
      // ==========================================================
      if (result === "win") {
        let baseReward = (playerHpPercent >= 0.5) ? monster.hp : Math.floor(monster.hp / 2);
        
        // เช็ค Daily Limit
        if (earnedToday + baseReward > DAILY_GAME_LIMIT) {
            allowedProfit = Math.max(0, DAILY_GAME_LIMIT - earnedToday);
            hitDailyLimit = true;
        } else {
            allowedProfit = baseReward;
        }

        // คืนเงินที่หักไป (entryFee) + กำไรที่ได้ (allowedProfit)
        rewardCoin = allowedProfit + entryFee; 
        currentCoin += rewardCoin; 

        // คำนวณ EXP และ Level
        currentExp += (expReward[monster.type] || 1);
        earnedToday += allowedProfit;

        while (levelConfig[currentLevel] && currentExp >= levelConfig[currentLevel].need) {
          currentLevel++;
          isLevelUp = true;
          maxHp = 20 + ((currentLevel - 1) * 2);
        }

      } else if (result === "lose") {
        if (enemyHpPercent < 0.5) {
            // Good Fight! คืนเงินให้ครึ่งนึง (เพราะตอนแรกหักไปเต็ม)
            feeRefund = Math.floor(entryFee / 2);
            currentCoin += feeRefund; 
        }
        // ถ้าแพ้ราบคาบ (enemyHpPercent >= 0.5) ไม่ต้องทำอะไร เพราะเงินโดนหักไปก่อนหน้านี้แล้ว
      }

      const newData = {
        coin: currentCoin,
        level: currentLevel,
        exp: currentExp,
        hp: maxHp, 
        earnedFromGameToday: earnedToday,
        lastRewardDate: lastRewardDate,
        updatedAt: new Date().toISOString()
      };

      t.update(userRef, newData);

      // ส่งกลับไปอัปเดตหน้าจอผู้เล่น
      return { 
        ...newData, 
        rewardCoin, rewardExp, isLevelUp, feeRefund, entryFee, hitDailyLimit, allowedProfit 
      };
    });

    res.json({ success: true, data: payloadToFrontend });
  } catch (error) {
    console.error("Battle Save Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// API 4: WITHDRAW (ระบบถอนเงิน & ลายเซ็น Smart Contract)
// ==========================================
app.post("/api/withdraw", async (req, res) => {
  console.log("---- SECURE WITHDRAW REQUEST ----");
  try {
    const { userId, wallet, amount } = req.body;
    if (!userId || !wallet || !amount) return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });

    const requestAmount = Number(amount);
    if (requestAmount <= 0) return res.status(400).json({ success: false, message: "จำนวนเงินไม่ถูกต้อง" });

    const userRef = db.collection("users").doc(userId);
    
    // หักเงินใน Database แบบ Transaction
    const newBalance = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("USER_NOT_FOUND");

      const userData = doc.data();
      if (!userData.walletAddress || userData.walletAddress.toLowerCase() !== wallet.toLowerCase()) {
        throw new Error("WALLET_MISMATCH");
      }

      const realBalance = Number(userData.coin) || 0;
      if (realBalance < requestAmount) throw new Error("INSUFFICIENT_FUNDS");

      const updatedBalance = realBalance - requestAmount;
      t.update(userRef, { coin: updatedBalance, lastWithdrawal: new Date().toISOString() });
      return updatedBalance; 
    });

    console.log(`✅ [DB Deducted] User: ${userId} | Remained: ${newBalance} Coins`);

    // สร้าง Signature สำหรับ Smart Contract
    const amountWei = (BigInt(requestAmount) * 10n ** 18n) / BigInt(SELL_RATE);
    const nonce = Date.now(); 
    
    // Ethers V6 Syntax (solidityPackedKeccak256 & getBytes)
    const packedData = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address"],
      [wallet, amountWei, nonce, VAULT_ADDRESS]
    );
    const vaultSignature = await signer.signMessage(ethers.getBytes(packedData));

    res.json({
      success: true,
      newBalance: newBalance,
      claimData: { amount: amountWei.toString(), nonce: nonce, signature: vaultSignature, vaultAddress: VAULT_ADDRESS }
    });
  } catch (error) {
    console.error("❌ Withdraw Error:", error.message || error);
    let clientMessage = "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์";
    if (error.message === "USER_NOT_FOUND") clientMessage = "ไม่พบข้อมูลผู้เล่น";
    else if (error.message === "WALLET_MISMATCH") clientMessage = "กระเป๋าไม่ตรงกับที่ลงทะเบียน";
    else if (error.message === "INSUFFICIENT_FUNDS") clientMessage = "ยอด Coin ไม่เพียงพอ";
    res.status(400).json({ success: false, message: clientMessage });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
