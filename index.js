const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ==========================================
// 1. FIREBASE ADMIN SETUP (ผ่าน FIREBASE_KEY)
// ==========================================
let serviceAccount;
try {
  if (!process.env.FIREBASE_KEY) {
    throw new Error("Missing FIREBASE_KEY in environment variables.");
  }
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (error) {
  console.error("❌ FIREBASE INIT ERROR: ตรวจสอบ FIREBASE_KEY ว่าเป็น JSON ที่ถูกต้องหรือไม่\n", error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ==========================================
// 2. SMART CONTRACT CONFIG & GAME CONFIG
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

// 🌟 เพิ่ม Game Config ให้ Server รู้จัก (ก็อปมาจาก Frontend)
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
// 3. WITHDRAW API (SECURE & TRANSACTIONAL)
// ==========================================
app.post("/api/withdraw", async (req, res) => {
  console.log("---- SECURE WITHDRAW REQUEST ----");
  try {
    const { userId, wallet, amount } = req.body;
    if (!userId || !wallet || !amount) {
      return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
    }

    const requestAmount = Number(amount);
    if (requestAmount <= 0) return res.status(400).json({ success: false, message: "จำนวนเงินไม่ถูกต้อง" });

    const userRef = db.collection("users").doc(userId);
    
    // 🛡️ Transaction
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

    // 🔏 สร้าง Signature
    const amountWei = (BigInt(requestAmount) * 10n ** 18n) / BigInt(SELL_RATE);
    const nonce = Date.now(); 
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
    if (error.message === "USER_NOT_FOUND") clientMessage = "ไม่พบข้อมูลผู้เล่นในระบบ";
    else if (error.message === "WALLET_MISMATCH") clientMessage = "กระเป๋าไม่ตรงกับที่ลงทะเบียนไว้";
    else if (error.message === "INSUFFICIENT_FUNDS") clientMessage = "ยอด Coin ในระบบไม่เพียงพอ";
    res.status(400).json({ success: false, message: clientMessage });
  }
});

// ==========================================
// ⚔️ BATTLE RESULT API (เซิร์ฟเวอร์เป็นคนเซฟ)
// ==========================================
app.post("/api/battle-result", async (req, res) => {
  try {
    // 🌟 รับค่า enemyHpPercent มาด้วยเพื่อเช็ค Good Fight
    const { userId, monsterId, result, playerHpPercent, enemyHpPercent } = req.body;

    if (!userId || !monsterId || !result) {
      return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
    }

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
      
      let earnedToday = Number(userData.earnedFromGameToday) || 0;
      let lastRewardDate = userData.lastRewardDate || "";
      
      const today = new Date().toDateString();
      if (today !== lastRewardDate) {
        earnedToday = 0;
        lastRewardDate = today;
      }

      let rewardCoin = 0;
      let rewardExp = 0;
      let isLevelUp = false;
      let feeRefund = 0;
      let hitDailyLimit = false; // 🌟 ส่งให้ Frontend ด้วย
      let allowedProfit = 0;     // 🌟 ส่งให้ Frontend ด้วย
      
      const entryFee = maxHp; 

      if (result === "win") {
        let baseReward = (playerHpPercent >= 0.5) ? monster.hp : Math.floor(monster.hp / 2);
        
        // เช็ค Daily Limit
        if (earnedToday + baseReward > DAILY_GAME_LIMIT) {
            allowedProfit = Math.max(0, DAILY_GAME_LIMIT - earnedToday);
            hitDailyLimit = true;
            rewardCoin = allowedProfit + entryFee; // คืนทุน + กำไรที่เหลือ
        } else {
            allowedProfit = baseReward;
            rewardCoin = baseReward + entryFee; // คืนทุน + กำไรเต็ม
        }

        currentCoin += allowedProfit; // 🌟 บวกเฉพาะกำไร (เพราะไม่ได้หักทุนออกตั้งแต่แรก)
        currentExp += (expReward[monster.type] || 1);
        earnedToday += allowedProfit;

        // เช็คเลเวลอัพ
        while (levelConfig[currentLevel] && currentExp >= levelConfig[currentLevel].need) {
          currentLevel++;
          isLevelUp = true;
          maxHp = 20 + ((currentLevel - 1) * 2);
        }

      } else if (result === "lose") {
        // 🌟 เช็ค Good Fight (ถ้าเลือดบอสเหลือน้อยกว่า 50% คืนเงินครึ่งนึง)
        if (enemyHpPercent < 0.5) {
            feeRefund = Math.floor(entryFee / 2);
            const netLoss = entryFee - feeRefund; 
            currentCoin -= netLoss; 
        } else {
            // แพ้ราบคาบ เสียค่าเข้าเต็มจำนวน
            currentCoin -= entryFee;
        }
      }

      // ป้องกันเงินติดลบ
      if (currentCoin < 0) currentCoin = 0;

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

      // 🌟 ส่งข้อมูลชุดนี้กลับไปให้ Frontend
      return { 
        ...newData, 
        rewardCoin, 
        rewardExp, 
        isLevelUp, 
        feeRefund,
        entryFee,
        hitDailyLimit,   // เอาไปแสดง Alert
        allowedProfit    // เอาไปแสดงใน Alert
      };
    });

    res.json({ success: true, data: payloadToFrontend });

  } catch (error) {
    console.error("Battle Save Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 🆕 REGISTER API (สร้างผู้เล่นใหม่ & แจกเงินเริ่มต้น)
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
        walletBoundAt: new Date().toISOString()
      }, { merge: true });
    });

    res.json({ success: true, message: "ลงทะเบียนผู้เล่นใหม่สำเร็จ" });

  } catch (error) {
    console.error("Register Error:", error);
    res.status(400).json({ 
      success: false, 
      message: error.message === "USER_ALREADY_REGISTERED" ? "ไอดีนี้ลงทะเบียนไปแล้ว" : "เกิดข้อผิดพลาดในการลงทะเบียน" 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
