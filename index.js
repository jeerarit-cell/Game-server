const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
require("dotenv").config();

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

// ================= CONFIG =================
const RPC_URL =
  process.env.RPC_URL ||
  "https://worldchain-mainnet.g.alchemy.com/public";

const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;
const VAULT_ADDRESS = process.env.CONTRACT_ADDRESS;

const SELL_RATE =
  Number(process.env.SELL_RATE_COIN_PER_WLD) || 1100;

if (!PRIVATE_KEY || !VAULT_ADDRESS) {
  console.error("❌ MISSING CONFIG: Check Private Key or Contract Address");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// ================= DEV MEMORY DB =================
// ⚠ ใช้สำหรับ DEV เท่านั้น (รีสตาร์ทแล้วข้อมูลหาย)
let users = {};

// ================= LOGIN =================
app.post("/api/login", (req, res) => {
  const { address } = req.body;

  if (!address) {
    return res.status(400).json({
      success: false,
      message: "No address"
    });
  }

  if (!users[address]) {
    users[address] = {
      coin: 5000,
      lastLogin: Date.now()
    };
  }

  res.json({
    success: true,
    balance: users[address].coin
  });
});

// ================= WITHDRAW =================
app.post("/api/withdraw", async (req, res) => {
  console.log("---- WITHDRAW REQUEST ----");
  console.log("BODY:", req.body);

  try {
    const { wallet, amount } = req.body;

    if (!wallet || amount == null) {
      return res.status(400).json({
        success: false,
        message: "Missing wallet or amount"
      });
    }

    if (!users[wallet]) {
      users[wallet] = { coin: 5000 };
    }

    const user = users[wallet];

    if (user.coin < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient Coins"
      });
    }

    // ===== คำนวณ WLD (18 decimals) =====
    const amountWei =
      (BigInt(amount) * 10n ** 18n) / BigInt(SELL_RATE);

    const nonce = Date.now();

    // ===== Server Sign (Vault Signature) =====
    const packedData = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address"],
      [wallet, amountWei, nonce, VAULT_ADDRESS]
    );

    console.log("⏳ Signing Vault...");
    const vaultSignature = await signer.signMessage(
      ethers.getBytes(packedData)
    );
    console.log("✅ Signed");

    // ===== หักเหรียญ =====
    user.coin -= amount;

    res.json({
      success: true,
      claimData: {
        amount: amountWei.toString(),
        nonce: nonce,
        signature: vaultSignature,
        vaultAddress: VAULT_ADDRESS
      },
      newBalance: user.coin
    });

  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);