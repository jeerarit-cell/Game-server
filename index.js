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
// 4. START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
