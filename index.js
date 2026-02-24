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
// API 2: BATTLE START (หักเงินค่าเข้าก่อนสู้ & สร้างห้องสู้บนเซิร์ฟเวอร์)
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
      
      // 📌 [จุดที่แก้ไข] เพิ่ม inBattle และให้เซิร์ฟเวอร์จำเลือดบอส/เลือดผู้เล่นไว้ที่ตัวเอง
      t.update(userRef, { 
        coin: currentCoin, 
        inBattle: true,
        b_monsterId: monsterId,
        b_eHp: monster.hp,       // จำเลือดบอส
        b_pHp: entryFee,         // จำเลือดผู้เล่น (เท่ากับ Max HP)
        b_multiplier: 1          // ตัวคูณดาเมจเริ่มต้นที่ 1
      });

      return currentCoin;
    });

    res.json({ success: true, newBalance: newBalance });
  } catch (error) {
    console.error("Battle Start Error:", error);
    res.status(400).json({ success: false, message: error.message === "INSUFFICIENT_COIN" ? "เงิน COIN ไม่พอ" : "เกิดข้อผิดพลาด" });
  }
});

// ==========================================
// API 3: BATTLE ACTION (แทนที่ BATTLE RESULT เดิม - เซิร์ฟเวอร์ดวลไพ่สดๆ)
// ==========================================
app.post("/api/battle-action", async (req, res) => {
  try {
    const { userId, playerDeck } = req.body; // 📌 รับไพ่ 5 ใบจากผู้เล่น

    // 🛡️ [จุดที่แก้ไข - ดักแฮกเกอร์ 1] เช็คว่าส่งไพ่มาครบ 5 ใบ และต้องเป็นเลข 1, 2, 3, 4, 5 เท่านั้น!
    if (!userId || !Array.isArray(playerDeck) || playerDeck.length !== 5) {
        return res.status(400).json({ success: false, message: "ข้อมูลไพ่ไม่ถูกต้อง" });
    }
    const isValidDeck = [...playerDeck].sort((a,b) => a-b).join(',') === '1,2,3,4,5';
    if (!isValidDeck) {
        console.warn(`🚨 HACKER DETECTED! User: ${userId} ส่งไพ่โกง: [${playerDeck}]`);
        return res.status(400).json({ success: false, message: "ตรวจพบการโกงไพ่!" });
    }

    const userRef = db.collection("users").doc(userId);
    
    // ตัวแปรเตรียมไว้สำหรับป้ายวิ่ง
    let feedPlayerName = "HUNTER";
    let feedPlayerLevel = 1;
    let actualMonsterName = "";

    const payloadToFrontend = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("USER_NOT_FOUND");

      let userData = doc.data();

      // 🚨 [จุดที่แก้ไข - ดักแฮกเกอร์ 2] เช็คว่าได้จ่ายค่าเข้าหรือยัง (มีตรา inBattle ไหม)
      if (!userData.inBattle) throw new Error("NO_ACTIVE_BATTLE");
      
      // ดึงข้อมูลมอนสเตอร์จาก Database ที่เซิร์ฟเวอร์จำไว้
      const monsterId = userData.b_monsterId;
      const monster = monsterDB.find(m => m.id === monsterId);
      if (!monster) throw new Error("MONSTER_NOT_FOUND");
      
      feedPlayerName = userData.name || "HUNTER";
      actualMonsterName = monster.name;

      let currentCoin = Number(userData.coin) || 0;
      let currentLevel = Number(userData.level) || 1;
      let currentExp = Number(userData.exp) || 0;
      let maxHp = 20 + ((currentLevel - 1) * 2);
      let entryFee = maxHp; // ค่าเข้าที่จ่ายไปแล้ว
      
      // 📌 ดึงข้อมูลการสู้จากรอบที่แล้วมาทำต่อ (เซิร์ฟเวอร์จำไว้)
      let eHp = Number(userData.b_eHp);
      let pHp = Number(userData.b_pHp);
      let multiplier = Number(userData.b_multiplier);
      
      let earnedToday = Number(userData.earnedFromGameToday) || 0;
      let lastRewardDate = userData.lastRewardDate || "";
      const today = new Date().toDateString();
      if (today !== lastRewardDate) {
        earnedToday = 0;
        lastRewardDate = today;
      }

      // 🤖 เซิร์ฟเวอร์สุ่มไพ่ตัวเองสดๆ!
      let enemyDeck = [1, 2, 3, 4, 5].sort(() => Math.random() - 0.5);

      // ⚔️ เซิร์ฟเวอร์เอาไพ่มาดวลกันบนอากาศ
      let pDmg = 0; let eDmg = 0;
      let pSurvivors = []; let eSurvivors = [];

      for(let i=0; i<5; i++) {
          if (playerDeck[i] > enemyDeck[i]) pSurvivors.push(playerDeck[i]);
          else if (enemyDeck[i] > playerDeck[i]) eSurvivors.push(enemyDeck[i]);
      }

      if (pSurvivors.length > eSurvivors.length) pDmg = pSurvivors.reduce((a, b) => a + b, 0);
      else if (eSurvivors.length > pSurvivors.length) eDmg = eSurvivors.reduce((a, b) => a + b, 0);
      else { pDmg = pSurvivors.reduce((a, b) => a + b, 0); eDmg = eSurvivors.reduce((a, b) => a + b, 0); }

      // หักเลือดตามตัวคูณ
      eHp -= (pDmg * multiplier);
      pHp -= (eDmg * multiplier);

      let battleStatus = "playing"; // สถานะเริ่มต้นคือสู้ต่อ
      let rewardCoin = 0; let rewardExp = 0; let feeRefund = 0;
      let isLevelUp = false; let hitDailyLimit = false; let allowedProfit = 0;

            // 🏆 เช็คผลแพ้ชนะ (Double KO อยู่นี่)
      let displayEHp = eHp; // เตรียมตัวแปรไว้ส่งให้หน้าจอโชว์แอนิเมชัน
      let displayPHp = pHp;

      if (eHp <= 0 && pHp <= 0) {
          battleStatus = "double_ko";
          multiplier = 2; // 📌 แก้เป็น = 2 (ให้เหมือนโค้ดต้นฉบับเป๊ะ)
          eHp = monster.hp; pHp = maxHp; // 📌 รีเซ็ตเลือดลง Database เตรียมรอเทิร์นหน้า
          displayEHp = 0; displayPHp = 0; // 📌 แต่หลอกส่ง 0 ไปให้หน้าจอเล่นแอนิเมชันตายคู่
      } else if (eHp <= 0) {
          battleStatus = "win"; eHp = 0; displayEHp = 0;
      } else if (pHp <= 0) {
          battleStatus = "lose"; pHp = 0; displayPHp = 0;
      }

      // 💾 ถ้าเกมยังไม่จบ อัปเดตเลือดลง Database แล้วรอรับไพ่เทิร์นหน้า
      if (battleStatus === "playing" || battleStatus === "double_ko") {
          t.update(userRef, { b_eHp: eHp, b_pHp: pHp, b_multiplier: multiplier });
      } 
      // 🏁 ถ้าเกมจบ แจกเงินและลบห้องทิ้ง!
      else {
          if (battleStatus === "win") {
            let hpPercent = pHp / maxHp;
            let baseReward = (hpPercent >= 0.5) ? monster.hp : Math.floor(monster.hp / 2);
            
            if (earnedToday + baseReward > DAILY_GAME_LIMIT) {
                allowedProfit = Math.max(0, DAILY_GAME_LIMIT - earnedToday);
                hitDailyLimit = true;
            } else {
                allowedProfit = baseReward;
            }

            rewardCoin = allowedProfit + entryFee; 
            currentCoin += rewardCoin; 

            currentExp += (expReward[monster.type] || 1);
            earnedToday += allowedProfit;

            while (levelConfig[currentLevel] && currentExp >= levelConfig[currentLevel].need) {
              currentLevel++;
              isLevelUp = true;
              maxHp = 20 + ((currentLevel - 1) * 2);
            }
            feedPlayerLevel = currentLevel;

          } else if (battleStatus === "lose") {
            let eHpPercent = eHp / monster.hp;
            if (eHpPercent < 0.5) {
                // คืนเงินครึ่งนึง
                feeRefund = Math.floor(entryFee / 2);
                currentCoin += feeRefund; 
            }
          }

          const newData = {
            coin: currentCoin, level: currentLevel, exp: currentExp, hp: maxHp, 
            earnedFromGameToday: earnedToday, lastRewardDate: lastRewardDate, updatedAt: new Date().toISOString(),
            inBattle: false, // 📌 สู้จบแล้ว ลบตราประทับออก
            b_eHp: admin.firestore.FieldValue.delete(), b_pHp: admin.firestore.FieldValue.delete(),
            b_multiplier: admin.firestore.FieldValue.delete(), b_monsterId: admin.firestore.FieldValue.delete()
          };
          t.update(userRef, newData);
      }

            // ส่งผลลัพธ์ทั้งหมดกลับไปให้หน้าจอ
      return { 
          enemyDeck, 
          eHp: displayEHp, // 📌 เปลี่ยนตรงนี้ เพื่อส่งเลือดหลอก (0) ไปเล่นแอนิเมชัน
          pHp: displayPHp, // 📌 เปลี่ยนตรงนี้ด้วย
          battleStatus, 
          pDmg: (pDmg * multiplier), 
          eDmg: (eDmg * multiplier),
          // ... (ตัวแปรอื่นๆ ปล่อยไว้เหมือนเดิมครับ)

          rewardCoin, rewardExp, isLevelUp, feeRefund, entryFee, hitDailyLimit, allowedProfit,
          coin: currentCoin, level: currentLevel, exp: currentExp, hp: maxHp // ส่งค่าใหม่กลับไปอัปเดตหน้าจอด้วย
      };
    });

    // 📌 บันทึกข้อมูลลง Kill Feed (ทำเมื่อชนะและได้กำไร)
    if (payloadToFrontend.battleStatus === "win" && payloadToFrontend.allowedProfit > 0) {
        try {
            await db.collection('kill_feed').add({
                playerName: feedPlayerName, level: feedPlayerLevel, monsterName: actualMonsterName,
                reward: payloadToFrontend.allowedProfit, timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (feedErr) {
            console.error("Failed to save kill feed:", feedErr); 
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

    // 📌 [อัปเกรด] เปลี่ยนมาใช้ for...of เพื่อให้ระบบ "รอคิว" ได้อย่างสมบูรณ์
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
      deletedCount++;
      
      // ตัดรอบ commit ทุกๆ 500 รายการตามข้อจำกัดของ Firestore
      if (deletedCount % 500 === 0) {
        await batch.commit(); // 📌 เติม await ให้แล้ว
        batch = db.batch(); 
      }
    } // 📌 [แก้บั๊กแล้ว] เปลี่ยนจาก }); เป็น } ตัวเดียวเพียวๆ

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

// =============================================================
// CHASER REWARD SYSTEM - API ENDPOINTS
// =============================================================

// 1. API สำหรับขอใบอนุญาต (ยังไม่หักเงิน)
app.post("/api/get-swap-signature", async (req, res) => {
  try {
    const { userId, amountCoin } = req.body;
    const swapAmount = Number(amountCoin);

    // ใช้ค่าจาก .env ที่คุณกำหนด
    const RATE = Number(process.env.CHASER_RATE) || 10000;
    const BONUS = Number(process.env.CHASER_BONUS) || 0.02;
    const TOKEN_ADDR = process.env.CHASER_TOKEN_ADDRESS;
    const VAULT_ADDR = process.env.CONTRACT_ADDRESS;

    if (swapAmount < 100) throw new Error("ขั้นต่ำคือ 100 COIN");

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) throw new Error("ไม่พบข้อมูลผู้เล่น");
    
    const userData = userDoc.data();
    if (Number(userData.coin) < swapAmount) throw new Error("ยอด COIN ไม่เพียงพอ");

    // --- สูตรคำนวณ: (ยอด Coin * Rate) + โบนัส ---
    const baseChaser = swapAmount * RATE;
    const totalChaser = Math.floor(baseChaser * (1 + BONUS));
    
    // แปลงเป็นหน่วย Wei (18 หลัก)
    const amountWei = ethers.parseUnits(totalChaser.toString(), 18);
    
    const nonce = Date.now(); // เลขใบเสร็จ/Nonce
    const deadline = Math.floor(Date.now() / 1000) + (60 * 10); // หมดอายุใน 10 นาที

    // --- สร้าง Digital Signature ---
    const packedData = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "uint256", "address"],
      [TOKEN_ADDR, amountWei, nonce, deadline, VAULT_ADDR]
    );
    
    // ใช้ Private Key ของ Vault ในการเซ็น (ต้องประกาศ signer ไว้ด้านบนของไฟล์)
    const signature = await signer.signMessage(ethers.getBytes(packedData));

    console.log(`📌 Signature Created for ${userId}: ${totalChaser} Chaser`);

    res.json({
      success: true,
      claimData: {
        tokenAddress: TOKEN_ADDR,
        amount: amountWei.toString(),
        nonce: nonce,
        deadline: deadline,
        signature: signature,
        vaultAddress: VAULT_ADDR
      }
    });
  } catch (error) {
    console.error("❌ Signature Error:", error.message);
    res.status(400).json({ success: false, message: error.message });
  }
});

// 2. API สำหรับยืนยันการหักเงิน (เมื่อ Blockchain สำเร็จแล้ว)
app.post("/api/swap-success", async (req, res) => {
  try {
    const { userId, amountCoin, nonce } = req.body;

    // เช็คว่า Nonce นี้เคยใช้ไปหรือยัง (กันโกง)
    const nonceRef = db.collection("used_nonces").doc(nonce.toString());
    const nonceDoc = await nonceRef.get();
    if (nonceDoc.exists) throw new Error("รายการนี้ถูกดำเนินการไปแล้ว");

    const userRef = db.collection("users").doc(userId);
    
    const result = await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("USER_NOT_FOUND");
      
      const currentCoin = Number(userDoc.data().coin);
      const newBalance = currentCoin - Number(amountCoin);
      
      if (newBalance < 0) throw new Error("ยอดเงินไม่เพียงพอหลังตรวจสอบ");

      // หักเงิน และ บันทึก Nonce ว่าใช้แล้ว
      t.update(userRef, { coin: newBalance });
      t.set(nonceRef, { 
        usedAt: admin.firestore.FieldValue.serverTimestamp(),
        userId: userId,
        amountCoin: amountCoin
      });
      
      return { newBalance };
    });

    console.log(`✅ [Swap Complete] User: ${userId} | Balance: ${result.newBalance}`);
    res.json({ success: true, newBalance: result.newBalance });
  } catch (error) {
    console.error("❌ Swap Success Error:", error.message);
    res.status(400).json({ success: false, message: error.message });
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
