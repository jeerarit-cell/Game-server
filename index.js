const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// --- CONFIG ---
const RPC_URL = process.env.RPC_URL || "https://worldchain-mainnet.g.alchemy.com/public";
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;
const VAULT_ADDRESS = process.env.CONTRACT_ADDRESS;
const SELL_RATE = Number(process.env.SELL_RATE_COIN_PER_WLD) || 1100;

// --- FIREBASE SETUP ---
if (!process.env.FIREBASE_KEY) {
    console.error("❌ ERROR: Missing FIREBASE_KEY in Render Environment");
    process.exit(1);
}

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase Connected!");
} catch (error) {
    console.error("❌ Firebase Init Error:", error);
}

const db = admin.firestore(); // เรียกใช้ Database

// --- BLOCKCHAIN SETUP ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// --- HELPER FUNCTION ---
async function getUserBalance(wallet) {
    const doc = await db.collection("users").doc(wallet).get();
    if (!doc.exists) {
        // ถ้าไม่มีข้อมูล ให้สร้างใหม่ (เริ่ม 0)
        await db.collection("users").doc(wallet).set({ coin: 0, lastLogin: Date.now() });
        return 0;
    }
    return doc.data().coin || 0;
}

// --- API ---

// API: Login (ใช้ดึงข้อมูลจาก Firebase)
app.post("/api/login", async (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ success: false, message: "No address" });

        const balance = await getUserBalance(address);
        console.log(`👤 Login: ${address} | Balance: ${balance}`);
        
        res.json({ success: true, balance: balance });
    } catch (e) {
        console.error("Login Error:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Withdraw (ตัดเงินใน Firebase)
app.post("/api/withdraw", async (req, res) => {
    console.log("---- WITHDRAW REQUEST ----");
    try {
        const { wallet, amount, message, signature } = req.body;

        if (!wallet || !amount || !message || !signature) {
            return res.status(400).json({ success: false, message: "Missing Data" });
        }

        // 1. ดึงยอดเงินล่าสุดจาก Firebase (Real-time)
        const userRef = db.collection("users").doc(wallet);
        const doc = await userRef.get();
        
        if (!doc.exists) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const currentCoin = doc.data().coin || 0;

        // 2. เช็คยอดเงิน
        if (currentCoin < amount) {
            return res.status(400).json({ success: false, message: "Coin ไม่พอ!" });
        }

        // 3. คำนวณ WLD
        const amountWei = (BigInt(amount) * BigInt(10n ** 18n)) / BigInt(SELL_RATE);
        const nonce = Date.now();

        // 4. Server เซ็นอนุมัติ (Sign)
        const packedData = ethers.solidityPackedKeccak256(
            ["address", "uint256", "uint256", "address"],
            [wallet, amountWei, nonce, VAULT_ADDRESS]
        );
        const vaultSignature = await signer.signMessage(ethers.getBytes(packedData));

        // 5. ตัดยอดเงินใน Firebase ทันที! (ใช้ update)
        await userRef.update({
            coin: admin.firestore.FieldValue.increment(-amount) // ลบยอดออกแบบ Atomic (ปลอดภัยมาก)
        });

        console.log(`✅ Approved & Deducted: ${wallet} - ${amount} Coins`);

        res.json({
            success: true,
            claimData: {
                user: wallet,
                amount: amountWei.toString(),
                nonce: nonce,
                signature: vaultSignature,
                vaultAddress: VAULT_ADDRESS
            },
            newBalance: currentCoin - amount
        });

    } catch (e) {
        console.error("Withdraw Error:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Save Game (เอาไว้ให้ Frontend ยิงมาอัปเดตยอดตอนเล่นได้)
app.post("/api/save", async (req, res) => {
    try {
        const { wallet, coin } = req.body;
        // ในความเป็นจริง ควรมีการเช็ค Security ตรงนี้ด้วยว่าไม่ได้โกง
        // แต่เบื้องต้นให้บันทึกลง Firebase ได้เลย
        await db.collection("users").doc(wallet).update({ coin: coin });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running port ${PORT}`));
