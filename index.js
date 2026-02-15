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
// API 0: GET PLAYER (ดึงข้อมูลตอนล็อกอิน)
// ==========================================
app.post("/api/get-player", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: "Missing userId" });

    const userRef = db.collection("users").doc(userId);
    const doc = await userRef.get();

    if (!doc.exists) {
      // ไม่พบผู้เล่น (ต้องไปหน้าตั้งชื่อ)
      return res.json({ success: false, message: "USER_NOT_FOUND" });
    }

    res.json({ success: true, data: doc.data() });
  } catch (error) {
    console.error("Get Player Error:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

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
// API 1.5: BUY COINS (เติมเงิน & บันทึกลงสมุดบัญชี)
// ==========================================
app.post("/api/buy-coins", async (req, res) => {
  try {
    const { userId, amountBought, reference } = req.body;
    if (!userId || !amountBought || !reference) return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });

    const userRef = db.collection("users").doc(userId);
    // 📌 สร้าง/อ้างอิง สมุดบัญชีโดยใช้ "เลขที่ใบเสร็จ (reference)" เป็นชื่อไฟล์
    const txRef = db.collection("transactions").doc(String(reference));

    const newBalance = await db.runTransaction(async (t) => {
      // 1. เช็คว่าบิลนี้เคยเติมไปแล้วหรือยัง (ป้องกันแฮกเกอร์ยิง API ซ้ำ)
      const txDoc = await t.get(txRef);
      if (txDoc.exists) throw new Error("REFERENCE_ALREADY_USED");

      // 2. ดึงข้อมูลผู้เล่นมาอัปเดตเงิน
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("USER_NOT_FOUND");

      let currentCoin = Number(userDoc.data().coin) || 0;
      currentCoin += Number(amountBought);

      // 3. อัปเดตยอดเงินใหม่ลงโปรไฟล์
      t.update(userRef, { coin: currentCoin });

      // 4. บันทึกประวัติลงสมุดบัญชี
      t.set(txRef, {
        userId: userId,
        type: "BUY",
        amountCoin: Number(amountBought),
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return currentCoin;
    });

    console.log(`✅ [Buy Success] User: ${userId} | Bought: ${amountBought} Coins | Ref: ${reference}`);
    res.json({ success: true, newBalance: newBalance });
  } catch (error) {
    console.error("Buy Coins Error:", error);
    res.status(400).json({ 
      success: false, 
      message: error.message === "REFERENCE_ALREADY_USED" ? "ใบเสร็จนี้ถูกใช้งานเติมเงินไปแล้ว" : "เกิดข้อผิดพลาดในการอัปเดตเหรียญ" 
    });
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
      
      // 📌 [จุดที่แก้ไข] เพิ่ม inBattle: true เพื่อประทับตราว่าคนนี้จ่ายเงินเข้าห้องบอสแล้ว
      t.update(userRef, { coin: currentCoin, inBattle: true });

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
    
    // 📌 ตัวแปรเตรียมไว้สำหรับป้ายวิ่ง
    let feedPlayerName = "HUNTER";
    let feedPlayerLevel = 1;

    const payloadToFrontend = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("USER_NOT_FOUND");

      let userData = doc.data();

      // 🚨 [จุดที่แก้ไข 1] ดักจับแฮกเกอร์! เช็คว่าได้จ่ายค่าเข้าหรือยัง (มีตรา inBattle ไหม)
      if (!userData.inBattle) {
          throw new Error("NO_ACTIVE_BATTLE");
      }
      
      // 📌 เก็บชื่อผู้เล่นไว้ใช้กับป้ายวิ่ง
      feedPlayerName = userData.name || "HUNTER";

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
        
        // 📌 อัปเดตเลเวลล่าสุดไว้ใช้กับป้ายวิ่ง
        feedPlayerLevel = currentLevel;

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
        updatedAt: new Date().toISOString(),
        inBattle: false // 📌 [จุดที่แก้ไข 2] สู้จบแล้ว ลบตราประทับออก ป้องกันการเอายอดเดิมมาเบิกซ้ำ!
      };

      t.update(userRef, newData);

      // ส่งกลับไปอัปเดตหน้าจอผู้เล่น
      return { 
        ...newData, 
        rewardCoin, rewardExp, isLevelUp, feeRefund, entryFee, hitDailyLimit, allowedProfit 
      };
    });

    // ==========================================================
    // 📌 บันทึกข้อมูลลง Kill Feed (ทำเมื่อชนะและได้กำไร)
    // ==========================================================
    if (result === "win" && payloadToFrontend.allowedProfit > 0) {
        try {
            await db.collection('kill_feed').add({
                playerName: feedPlayerName,
                level: feedPlayerLevel,
                monsterName: monster.name,
                reward: payloadToFrontend.allowedProfit, // โชว์กำไรสุทธิ
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (feedErr) {
            console.error("Failed to save kill feed:", feedErr); // ถ้า Error ไม่ต้องให้แอปค้าง
        }
    }

    res.json({ success: true, data: payloadToFrontend });
  } catch (error) {
    console.error("Battle Save Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// API 4: WITHDRAW (ตรวจสอบยอด & สร้างลายเซ็น - ยังไม่หักเงิน)
// ==========================================
app.post("/api/withdraw", async (req, res) => {
  console.log("---- SECURE WITHDRAW REQUEST ----");
  try {
    const { userId, amount } = req.body;
    if (!userId || !amount) return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });

    const requestAmount = Number(amount);
    if (requestAmount <= 0) return res.status(400).json({ success: false, message: "จำนวนเงินไม่ถูกต้อง" });

    const userRef = db.collection("users").doc(userId);
    const doc = await userRef.get(); 
    
    if (!doc.exists) throw new Error("USER_NOT_FOUND");
    
    const userData = doc.data();
    const userWallet = userData.walletAddress;
    const currentBalance = Number(userData.coin) || 0;

    if (!userWallet) throw new Error("WALLET_NOT_FOUND");
    if (currentBalance < requestAmount) throw new Error("INSUFFICIENT_FUNDS");

    // สร้าง Signature สำหรับ Smart Contract
    const amountWei = (BigInt(requestAmount) * 10n ** 18n) / BigInt(SELL_RATE);
    const nonce = Date.now(); 
    
    const packedData = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address"],
      [userWallet, amountWei, nonce, VAULT_ADDRESS]
    );
    const vaultSignature = await signer.signMessage(ethers.getBytes(packedData));

    // ส่งกลับไปให้หน้าเว็บ (ยังไม่หักเงิน)
    res.json({
      success: true,
      claimData: { amount: amountWei.toString(), nonce: nonce, signature: vaultSignature, vaultAddress: VAULT_ADDRESS }
    });
  } catch (error) {
    console.error("❌ Withdraw Request Error:", error.message || error);
    let clientMessage = "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์";
    if (error.message === "USER_NOT_FOUND") clientMessage = "ไม่พบข้อมูลผู้เล่น";
    else if (error.message === "WALLET_NOT_FOUND") clientMessage = "ไม่พบกระเป๋าที่ผูกไว้";
    else if (error.message === "INSUFFICIENT_FUNDS") clientMessage = "ยอด Coin ไม่เพียงพอ";
    res.status(400).json({ success: false, message: clientMessage });
  }
});

// ==========================================
// API 5: WITHDRAW SUCCESS (หักเงินจริง & บันทึกลงสมุดบัญชี)
// ==========================================
app.post("/api/withdraw-success", async (req, res) => {
  try {
    const { userId, amount, nonce } = req.body;
    if (!userId || !amount || !nonce) return res.status(400).json({ success: false });

    const requestAmount = Number(amount);
    const userRef = db.collection("users").doc(userId);
    // 📌 สร้าง/อ้างอิง สมุดบัญชีโดยใช้ "nonce" (รหัสธุรกรรมบนบล็อกเชน) เป็นชื่อไฟล์
    const txRef = db.collection("transactions").doc(String(nonce));

    // หักเงินจริงด้วย Transaction
    const newBalance = await db.runTransaction(async (t) => {
      // 1. เช็คในสมุดบัญชีว่า Nonce นี้ถูกหักเงินไปหรือยัง? (ป้องกันโกง/เน็ตกระตุก)
      const txDoc = await t.get(txRef);
      if (txDoc.exists) throw new Error("ALREADY_DEDUCTED");

      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("USER_NOT_FOUND");

      const realBalance = Number(userDoc.data().coin) || 0;
      if (realBalance < requestAmount) throw new Error("INSUFFICIENT_FUNDS");

      const updatedBalance = realBalance - requestAmount;

      // 2. อัปเดตเงินในโปรไฟล์ (ไม่ต้องยัด array nonce ลงไปให้รกโปรไฟล์อีกแล้ว)
      t.update(userRef, { 
        coin: updatedBalance, 
        lastWithdrawal: new Date().toISOString() 
      });

      // 3. บันทึกประวัติลงสมุดบัญชี
      t.set(txRef, {
        userId: userId,
        type: "SELL",
        amountCoin: requestAmount,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return updatedBalance; 
    });

    console.log(`✅ [Sell Success] User: ${userId} | Sold: ${requestAmount} Coins | Nonce: ${nonce}`);
    res.json({ success: true, newBalance: newBalance });
  } catch (error) {
    console.error("❌ Withdraw Sync Error:", error.message);
    res.status(400).json({ success: false, message: error.message });
  }
});

  // ==========================================
// API 6: GET KILL FEED (ดึงข้อมูลป้ายวิ่ง 5 อันดับล่าสุด)
// ==========================================
app.get("/api/kill-feed", async (req, res) => {
  try {
    const snapshot = await db.collection('kill_feed')
      .orderBy('timestamp', 'desc')
      .limit(5)
      .get();

    let feed = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      feed.push({
        playerName: data.playerName,
        level: data.level,
        monsterName: data.monsterName,
        reward: data.reward
      });
    });

    res.json({ success: true, data: feed });
  } catch (error) {
    console.error("Get Kill Feed Error:", error);
    res.status(500).json({ success: false, message: "Error fetching feed" });
  }
});
   // ==========================================
// AUTO CLEANUP: ลบข้อมูลป้ายวิ่งเก่า (เหลือแค่ 50 รายการล่าสุด)
// ==========================================
async function cleanupOldFeeds() {
  try {
    const snapshot = await db.collection('kill_feed')
      .orderBy('timestamp', 'desc')
      .offset(50)
      .get();

    if (snapshot.empty) return;

    let batch = db.batch();
    let deletedCount = 0;

    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
      deletedCount++;
      // ตัดรอบ commit ทุกๆ 500 รายการตามข้อจำกัดของ Firestore
      if (deletedCount % 500 === 0) {
        batch.commit();
        batch = db.batch(); 
      }
    });

    if (deletedCount % 500 !== 0) {
      await batch.commit();
    }

    console.log(`🗑️ [Auto-Cleanup] ลบประวัติป้ายวิ่งเก่าทิ้งไป ${deletedCount} รายการ`);
  } catch (error) {
    console.error("❌ Cleanup Error:", error);
  }
}

// 📌 รันทำความสะอาดทุกๆ 24 ชั่วโมง
setInterval(cleanupOldFeeds, 24 * 60 * 60 * 1000);
// 📌 รัน 1 ครั้งทันทีเมื่อเปิดเซิร์ฟเวอร์
cleanupOldFeeds();


  // ==========================================
// API: PING (ให้ UptimeRobot มาเคาะกันเซิร์ฟเวอร์หลับ)
// ==========================================
app.get("/ping", (req, res) => {
  res.status(200).send("Server is awake!");
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
