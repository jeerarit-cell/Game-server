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
// เช็คว่ามี Key ไหม (ใช้ชื่อ FIREBASE_KEY ตามที่คุณบอก)
if (!process.env.FIREBASE_KEY) {
    console.error("❌ ERROR: Missing FIREBASE_KEY in Render Environment");
    process.exit(1);
}

try {
    // แปลง Text ใน Render กลับเป็น JSON เพื่อใช้งาน
    const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    
    console.log("🔥 Firebase Connected!");
} catch (error) {
    console.error("❌ Firebase Init Error (Check JSON format):", error.message);
    process.exit(1);
}

const db = admin.firestore();

// --- BLOCKCHAIN SETUP ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// --- API ENDPOINTS ---

/**
 * API: Login
 * - ถ้ามีข้อมูลเก่า: ดึง Coin ล่าสุดมา
 * - ถ้าเป็นคนใหม่: สร้างใหม่แล้วให้ 20 Coins
 */
app.post("/api/login", async (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ success: false, message: "No address" });

        // แปลงเป็นตัวพิมพ์เล็กเสมอ เพื่อกันข้อมูลซ้ำ (0xABC != 0xabc)
        const wallet = address.toLowerCase();
        
        const userRef = db.collection("users").doc(wallet);
        const doc = await userRef.get();

        if (!doc.exists) {
            // ✨ ผู้เล่นใหม่: ให้ 20 Coins
            const newUserData = { 
                coin: 20, 
                highScore: 0, // แถมตัวแปรคะแนนสูงสุดให้ด้วย
                lastLogin: admin.firestore.FieldValue.serverTimestamp()
            };
            await userRef.set(newUserData);
            console.log(`👤 New User Created: ${wallet} | Given 20 Coins`);
            return res.json({ success: true, balance: 20, highScore: 0 });
        }

        // ผู้เล่นเก่า
        const data = doc.data();
        console.log(`👤 Login: ${wallet} | Balance: ${data.coin}`);
        res.json({ success: true, balance: data.coin || 0, highScore: data.highScore || 0 });

    } catch (e) {
        console.error("Login Error:", e);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * API: Save Game (บันทึกข้อมูลเกม)
 * - รับ Coin และ HighScore จากหน้าเว็บมาบันทึก
 */
app.post("/api/save", async (req, res) => {
    try {
        const { wallet, coin, highScore } = req.body;
        
        if (!wallet) return res.status(400).json({ message: "No wallet" });

        const userRef = db.collection("users").doc(wallet.toLowerCase());

        // อัปเดตข้อมูลลง Firebase (ใช้ merge: true เพื่อไม่ให้ทับข้อมูลอื่นที่ไม่ได้ส่งมา)
        await userRef.set({
            coin: coin, 
            highScore: highScore, // ถ้าเกมมีคะแนนสูงสุดก็บันทึกด้วย
            lastUpdate: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`💾 Saved: ${wallet} | Coin: ${coin}`);
        res.json({ success: true });

    } catch (e) {
        console.error("Save Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * API: Withdraw (ถอนเงิน)
 * - เช็คยอดจาก Firebase -> ตัดยอด -> เซ็นอนุมัติ
 */
app.post("/api/withdraw", async (req, res) => {
    console.log("---- WITHDRAW REQUEST ----");
    try {
        const { wallet, amount, message, signature } = req.body;

        if (!wallet || !amount) return res.status(400).json({ message: "Missing Data" });

        const userRef = db.collection("users").doc(wallet.toLowerCase());
        
        // ใช้ Transaction เพื่อความชัวร์ (ป้องกันยอดเงินเพี้ยนตอนคนกดรัวๆ)
        const result = await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw "User not found";

            const currentCoin = doc.data().coin || 0;
            if (currentCoin < amount) throw "Coin ไม่พอ";

            // คำนวณยอด
            const amountWei = (BigInt(amount) * BigInt(10n ** 18n)) / BigInt(SELL_RATE);
            const nonce = Date.now();

            // สร้างลายเซ็น
            const packedData = ethers.solidityPackedKeccak256(
                ["address", "uint256", "uint256", "address"],
                [wallet, amountWei, nonce, VAULT_ADDRESS]
            );
            const vaultSignature = await signer.signMessage(ethers.getBytes(packedData));

            // ตัดเงินใน Database
            t.update(userRef, { 
                coin: admin.firestore.FieldValue.increment(-amount) 
            });

            return {
                claimData: {
                    user: wallet,
                    amount: amountWei.toString(),
                    nonce: nonce,
                    signature: vaultSignature,
                    vaultAddress: VAULT_ADDRESS
                },
                newBalance: currentCoin - amount
            };
        });

        res.json({ success: true, ...result });

    } catch (e) {
        console.error("Withdraw Error:", e);
        res.status(500).json({ success: false, message: e.message || e });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running port ${PORT}`));
