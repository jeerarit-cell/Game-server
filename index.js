const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
require("dotenv").config();

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

// ================= CONFIG =================
const RPC_URL = process.env.RPC_URL || "https://worldchain-mainnet.g.alchemy.com/public";
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY; // คีย์ของกระเป๋า Server ที่ใช้เซ็นอนุมัติ
const VAULT_ADDRESS = process.env.CONTRACT_ADDRESS; // ที่อยู่ Smart Contract
const SELL_RATE = Number(process.env.SELL_RATE_COIN_PER_WLD) || 1100;

if (!PRIVATE_KEY || !VAULT_ADDRESS) {
  console.error("❌ MISSING CONFIG: Check Private Key or Contract Address");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// ================= WITHDRAW API =================
app.post("/api/withdraw", async (req, res) => {
  console.log("---- WITHDRAW REQUEST ----");
  
  try {
    // 1. รับค่า currentCoin มาด้วย
    const { wallet, amount, currentCoin } = req.body;

    if (!wallet || amount == null) {
      return res.status(400).json({ success: false, message: "Missing wallet or amount" });
    }

    console.log(`User: ${wallet} | Client Coin: ${currentCoin} | Withdraw: ${amount}`);

    // 2. LOGIC ใหม่: ใช้ยอดเงินจาก Client เป็นหลัก (Trust Client)
    // เพื่อแก้ปัญหา Server รีเซ็ตแล้วเงินเด้งกลับมา 5000
    let userBalance = Number(currentCoin);

    // ป้องกันกรณี Client ส่งมาเป็น null/undefined
    if (isNaN(userBalance)) {
        userBalance = 0; 
    }

    // 3. ตรวจสอบยอดเงิน
    if (userBalance < amount) {
      return res.status(400).json({
        success: false,
        message: "ยอดเงินไม่พอทำรายการ"
      });
    }

    // 4. หักเหรียญ
    let newBalance = userBalance - amount;

    // ==========================================
    // PREPARE SMART CONTRACT DATA
    // ==========================================
    
    // แปลงจำนวนเงินเป็น Wei (18 decimals) โดยหารด้วย Rate
    const amountWei = (BigInt(amount) * 10n ** 18n) / BigInt(SELL_RATE);
    
    const nonce = Date.now(); // ใช้เวลาปัจจุบันเป็น Nonce ป้องกันการใช้ซ้ำ

    // Pack ข้อมูลตาม Format ของ Solidity
    // ต้องเรียงลำดับให้ตรงกับใน Smart Contract: (address, uint256, uint256, address)
    const packedData = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address"],
      [wallet, amountWei, nonce, VAULT_ADDRESS]
    );

    console.log("⏳ Signing Vault Approval...");
    
    // Server เซ็นลายเซ็นอนุมัติ
    const vaultSignature = await signer.signMessage(ethers.getBytes(packedData));
    
    console.log("✅ Signed Success");

    // 5. ส่งข้อมูลกลับไปให้ Client
    res.json({
      success: true,
      claimData: {
        amount: amountWei.toString(),
        nonce: nonce,
        signature: vaultSignature,
        vaultAddress: VAULT_ADDRESS
      },
      newBalance: newBalance // ส่งยอดเงินที่หักแล้วกลับไป
    });

  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error: " + error.message
    });
  }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
