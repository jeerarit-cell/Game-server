const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
require("dotenv").config();

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

// --- CONFIG ---
const RPC_URL = process.env.RPC_URL || "https://worldchain-mainnet.g.alchemy.com/public";
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;
const VAULT_ADDRESS = process.env.CONTRACT_ADDRESS;
const SELL_RATE = Number(process.env.SELL_RATE_COIN_PER_WLD) || 1100; // 👈 ปรับเรทเริ่มต้นตรงนี้

if (!PRIVATE_KEY || !VAULT_ADDRESS) {
    console.error("❌ MISSING CONFIG: Check Private Key or Contract Address");
    process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
let users = {};

// --- DEBUG FUNCTION: เช็คละเอียดว่าทำไมลายเซ็นไม่ผ่าน ---
function verifyUserSignature(message, signature, wallet) {
    try {
        const recovered = ethers.verifyMessage(message, signature);
        
        console.log("🔍 DEBUG SIGNATURE:");
        console.log("   - Message:", message);
        console.log("   - Wallet Sent:", wallet);
        console.log("   - Recovered:", recovered);

        // เทียบกันแบบตัวพิมพ์เล็กทั้งหมด
        return recovered.toLowerCase() === wallet.toLowerCase();
    } catch (err) {
        console.error("Signature Error:", err);
        return false;
    }
}

app.post("/api/login", (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ success: false, message: "No address" });
    if (!users[address]) users[address] = { coin: 5000, lastLogin: Date.now() };
    res.json({ success: true, balance: users[address].coin });
});

app.post("/api/withdraw", async (req, res) => {
    console.log("---- WITHDRAW REQUEST ----");
    try {
        const { wallet, amount, message, signature } = req.body;

        if (!wallet || !amount || !message || !signature) {
            return res.status(400).json({ success: false, message: "Missing Data" });
        }

        // 1. ตรวจสอบลายเซ็น (พร้อม Log Debug)
        if (!verifyUserSignature(message, signature, wallet)) {
            console.log("❌ Signature Mismatch!");
            return res.status(401).json({ success: false, message: "Invalid User Signature! You are not the owner." });
        }

        if (!users[wallet]) users[wallet] = { coin: 5000 };
        const user = users[wallet];

        if (user.coin < amount) {
            return res.status(400).json({ success: false, message: "Insufficient Coins" });
        }

        const amountWei = (BigInt(amount) * BigInt(10n ** 18n)) / BigInt(SELL_RATE);
        const nonce = Date.now();

        const packedData = ethers.solidityPackedKeccak256(
            ["address", "uint256", "uint256", "address"],
            [wallet, amountWei, nonce, VAULT_ADDRESS]
        );

        const vaultSignature = await signer.signMessage(ethers.getBytes(packedData));

        user.coin -= amount;
        console.log(`✅ Approved: ${wallet} - ${amount} Coins`);

        res.json({
            success: true,
            claimData: {
                user: wallet,
                amount: amountWei.toString(),
                nonce: nonce,
                signature: vaultSignature,
                vaultAddress: VAULT_ADDRESS
            },
            newBalance: user.coin
        });

    } catch (e) {
        console.error("Server Error:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running port ${PORT}`));
