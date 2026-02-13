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
  // แปลง String จาก ENV ให้กลายเป็น JSON Object
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
// 2. SMART CONTRACT CONFIG
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

// ==========================================
// 3. WITHDRAW API (SECURE & TRANSACTIONAL)
// ==========================================
app.post("/api/withdraw", async (req, res) => {
  console.log("---- SECURE WITHDRAW REQUEST ----");
  
  try {
    const { userId, wallet, amount } = req.body;

    if (!userId || !wallet || !amount) {
      return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน (ต้องการ userId, wallet, amount)" });
    }

    const requestAmount = Number(amount);
    if (requestAmount <= 0) {
      return res.status(400).json({ success: false, message: "จำนวนเงินไม่ถูกต้อง" });
    }

    // ==========================================
    // 🛡️ เริ่มต้น TRANSACTION (ป้องกันการกดรัวๆ / Double Spend)
    // ==========================================
    const userRef = db.collection("users").doc(userId);
    
    // ทำงานใน Transaction: อ่านข้อมูล -> ตรวจสอบ -> หักเงิน 
    const newBalance = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      
      if (!doc.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const userData = doc.data();

      // เช็คว่ากระเป๋าตรงกันไหม (ป้องกันคนอื่นสวมรอย)
      if (!userData.walletAddress || userData.walletAddress.toLowerCase() !== wallet.toLowerCase()) {
        throw new Error("WALLET_MISMATCH");
      }

      // เช็คยอดเงินจริงบน Database
      const realBalance = Number(userData.coin) || 0;
      if (realBalance < requestAmount) {
        throw new Error("INSUFFICIENT_FUNDS");
      }

      // หักเงินเตรียมไว้เลย
      const updatedBalance = realBalance - requestAmount;
      
      // บันทึกกลับลง Database
      t.update(userRef, {
        coin: updatedBalance,
        lastWithdrawal: new Date().toISOString()
      });

      return updatedBalance; // คืนค่ายอดเงินล่าสุดออกไปใช้ต่อ
    });

    console.log(`✅ [DB Deducted] User: ${userId} | Remained: ${newBalance} Coins`);

    // ==========================================
    // 🔏 PREPARE & SIGN SMART CONTRACT DATA
    // ==========================================
    // คำนวณเป็นหน่วย Wei (18 Decimals) ตาม Rate ที่ตั้งไว้
    const amountWei = (BigInt(requestAmount) * 10n ** 18n) / BigInt(SELL_RATE);
    const nonce = Date.now(); 

    // แพ็คข้อมูลให้ตรงกับ Smart Contract (address, uint256, uint256, address)
    const packedData = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address"],
      [wallet, amountWei, nonce, VAULT_ADDRESS]
    );

    console.log("⏳ Signing Vault Approval...");
    const vaultSignature = await signer.signMessage(ethers.getBytes(packedData));
    console.log("✅ Signature Generated");

    // ==========================================
    // 📤 ส่งกลับให้หน้าบ้านไป Claim
    // ==========================================
    res.json({
      success: true,
      newBalance: newBalance, // ส่งยอดเงินอัปเดตไปให้หน้าบ้านแสดงผล
      claimData: {
        amount: amountWei.toString(),
        nonce: nonce,
        signature: vaultSignature,
        vaultAddress: VAULT_ADDRESS
      }
    });

  } catch (error) {
    console.error("❌ Withdraw Error:", error.message || error);

    // ส่งข้อความ Error กลับไปให้หน้าบ้านแบบเข้าใจง่ายๆ
    let clientMessage = "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์";
    if (error.message === "USER_NOT_FOUND") clientMessage = "ไม่พบข้อมูลผู้เล่นในระบบ";
    else if (error.message === "WALLET_MISMATCH") clientMessage = "กระเป๋าไม่ตรงกับที่ลงทะเบียนไว้";
    else if (error.message === "INSUFFICIENT_FUNDS") clientMessage = "ยอด Coin ในระบบไม่เพียงพอ";

    res.status(400).json({
      success: false,
      message: clientMessage
    });
  }
});

// ==========================================
// 4. START SERVER SAVE
// ==========================================
    // ==========================================
// ⚔️ BATTLE RESULT API (เซิร์ฟเวอร์เป็นคนเซฟ)
// ==========================================
app.post("/api/battle-result", async (req, res) => {
  try {
    const { userId, monsterId, result, playerHpPercent } = req.body;

    if (!userId || !monsterId || !result) {
      return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
    }

    // 1. ตรวจสอบว่ามีมอนสเตอร์ตัวนี้จริงๆ ไหม
    const monster = monsterDB.find(m => m.id === monsterId);
    if (!monster) return res.status(400).json({ success: false, message: "ไม่พบมอนสเตอร์" });

    const userRef = db.collection("users").doc(userId);

    // 2. ใช้ Transaction ล็อคข้อมูล ป้องกันการกดรัวๆ (Double Request)
    const updatedData = await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("USER_NOT_FOUND");

      let userData = doc.data();
      let currentCoin = Number(userData.coin) || 0;
      let currentLevel = Number(userData.level) || 1;
      let currentExp = Number(userData.exp) || 0;
      let maxHp = 20 + ((currentLevel - 1) * 2);
      
      // ดึงข้อมูลรายวันมาเช็ค Limit
      let earnedToday = Number(userData.earnedFromGameToday) || 0;
      let lastRewardDate = userData.lastRewardDate || "";
      
      const today = new Date().toDateString();
      if (today !== lastRewardDate) {
        earnedToday = 0;
        lastRewardDate = today;
      }

      // ตัวแปรสำหรับส่งกลับไปให้หน้าบ้านโชว์
      let rewardCoin = 0;
      let rewardExp = 0;
      let isLevelUp = false;
      let feeRefund = 0;
      
      const entryFee = maxHp; // ค่าเข้าคือ Max HP

            // =======================================
      // 🏆 คำนวณผลลัพธ์แบบ สุทธิ (Net Change)
      // =======================================
      const entryFee = maxHp; // ค่าเข้าคือ Max HP

      if (result === "win") {
        // --- กรณีชนะ ---
        let baseReward = (playerHpPercent >= 0.5) ? monster.hp : Math.floor(monster.hp / 2);
        
        // เช็คลิมิตรายวัน
        if (earnedToday + baseReward > DAILY_GAME_LIMIT) {
          baseReward = Math.max(0, DAILY_GAME_LIMIT - earnedToday);
        }

        rewardCoin = baseReward + entryFee; // ยอดรวมที่ส่งไปโชว์หน้าบ้าน (กำไร + ทุน)
        rewardExp = expReward[monster.type] || 1;

        // 🌟 เซิร์ฟเวอร์ไม่ได้หักค่าเข้าตอนแรก ดังนั้นบวกแค่ "กำไรสุทธิ" 🌟
        currentCoin += baseReward;
        currentExp += rewardExp;
        earnedToday += baseReward;

        // เช็คเลเวลอัพ
        while (levelConfig[currentLevel] && currentExp >= levelConfig[currentLevel].need) {
          currentLevel++;
          isLevelUp = true;
          maxHp = 20 + ((currentLevel - 1) * 2);
        }

      } else if (result === "lose") {
        // --- กรณีแพ้ ---
        // 🌟 เซิร์ฟเวอร์ไม่ได้หักค่าเข้าตอนแรก ดังนั้นต้องลบ "ค่าเข้าส่วนที่ไม่ได้คืน" ออก 🌟
        feeRefund = Math.floor(entryFee / 2);
        const netLoss = entryFee - feeRefund; 
        currentCoin -= netLoss; 
        
      } else if (result === "draw") {
        // --- กรณีเสมอ --- 
        // หน้าบ้านจะจัดการให้สู้ใหม่รอบหน้า (Double KO) Server ไม่ต้องหักเงิน
      }

      // =======================================
      // 💾 เซิร์ฟเวอร์สั่งเซฟข้อมูลลง Firebase!
      // =======================================
      const newData = {
        coin: currentCoin,
        level: currentLevel,
        exp: currentExp,
        hp: maxHp, // รีเลือดให้เต็ม
        earnedFromGameToday: earnedToday,
        lastRewardDate: lastRewardDate,
        updatedAt: new Date().toISOString()
      };

      t.update(userRef, newData);

      // คืนค่ากลับไปบอกหน้าบ้านว่าเกิดอะไรขึ้นบ้าง
      return { 
        ...newData, 
        rewardCoin, 
        rewardExp, 
        isLevelUp, 
        feeRefund 
      };
    });

    // ส่ง Response กลับไปหาตัวเกม
    res.json({
      success: true,
      data: updatedData
    });

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

    if (!userId || !wallet || !name) {
      return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
    }

    const userRef = db.collection("users").doc(userId);

    // ใช้ Transaction เพื่อความชัวร์ ป้องกันคนกดย้ำๆ เพื่อปั๊มเงิน 200 รัวๆ
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);

      // 🛡️ เช็คว่าถ้าผู้เล่นคนนี้เคยผูกกระเป๋าไปแล้ว จะไม่ยอมให้เซฟทับ (ป้องกันการรีเซ็ตไอดี)
      if (doc.exists && doc.data().walletBound) {
        throw new Error("USER_ALREADY_REGISTERED");
      }

      // 💾 ให้ Server เป็นคนกำหนดค่าเริ่มต้นทั้งหมด (หน้าบ้านแก้ไขเลขพวกนี้ไม่ได้)
      t.set(userRef, {
        name: name,
        walletAddress: wallet,
        walletBound: true,
        coin: 40,          // Server จ่ายเงินขวัญถุง 40 Coins
        level: 1,           // เริ่มที่เลเวล 1
        hp: 20,             // เลือด 20
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
      message: error.message === "USER_ALREADY_REGISTERED" 
        ? "ไอดีนี้ลงทะเบียนไปแล้ว" 
        : "เกิดข้อผิดพลาดในการลงทะเบียน" 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
