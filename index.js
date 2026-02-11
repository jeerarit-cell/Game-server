const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
require("dotenv").config();

const app = express();

// อนุญาต CORS ให้เรียกจากหน้าเว็บได้ทุกโดเมน (หรือระบุเจาะจงเพื่อความปลอดภัยเพิ่ม)
app.use(cors({ origin: "*" }));
app.use(express.json());

// --- 1. CONFIGURATION (ดึงค่าจาก Render Environment) ---
// RPC ของ World Chain Mainnet (ถ้าใน env ไม่ใส่ จะใช้อันนี้เป็น default)
const RPC_URL = process.env.RPC_URL || "https://worldchain-mainnet.g.alchemy.com/public";

// Private Key ของกระเป๋า "Admin/Signer" (คนที่เซ็นอนุมัติ)
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;

// ที่อยู่ Smart Contract "GameVault" ที่คุณ Deploy บน World Chain
const VAULT_ADDRESS = process.env.CONTRACT_ADDRESS;

// อัตราแลกเปลี่ยน (เช่น 1000 Coins = 1 WLD)
const SELL_RATE = Number(process.env.SELL_RATE_COIN_PER_WLD) || 1000;

// ตรวจสอบค่า Config ที่จำเป็น
if (!PRIVATE_KEY || !VAULT_ADDRESS) {
    console.error("❌ CRITICAL ERROR: Missing SIGNER_PRIVATE_KEY or CONTRACT_ADDRESS in .env");
    process.exit(1); // ปิด Server ทันทีถ้าค่าไม่ครบ ป้องกันความผิดพลาด
}

// --- 2. BLOCKCHAIN SETUP ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

console.log(`✅ System Initialized`);
console.log(`   - Signer Wallet: ${signer.address}`);
console.log(`   - Vault Contract: ${VAULT_ADDRESS}`);
console.log(`   - Exchange Rate: ${SELL_RATE} Coins = 1 WLD`);

// --- 3. MOCK DATABASE (⚠️ สำคัญ: ใน Production จริง ควรเปลี่ยนเป็น MongoDB/Postgres) ---
// ปัจจุบันใช้ตัวแปรเก็บใน RAM ถ้า Server รีสตาร์ท ข้อมูลจะหาย
let users = {};

// --- 4. HELPER FUNCTIONS ---

// ฟังก์ชันตรวจสอบว่าเป็นเจ้าของกระเป๋าตัวจริงหรือไม่
function verifyUserSignature(message, signature, wallet) {
    try {
        const recovered = ethers.verifyMessage(message, signature);
        return recovered.toLowerCase() === wallet.toLowerCase();
    } catch (err) {
        console.error("Signature Verification Error:", err);
        return false;
    }
}

// --- 5. API ENDPOINTS ---

/**
 * API: Login
 * ใช้สำหรับล็อกอินและโหลดข้อมูล User (หรือสร้างใหม่ถ้ายังไม่มี)
 */
app.post("/api/login", (req, res) => {
    const { address } = req.body;
    
    if (!address) {
        return res.status(400).json({ success: false, message: "Wallet address is required" });
    }

    // ถ้าเป็น User ใหม่ ให้สร้างข้อมูลเริ่มต้น (Production: ควรดึงจาก DB)
    if (!users[address]) {
        console.log(`👤 New user detected: ${address}`);
        users[address] = { 
            coin: 0, // เริ่มต้น 0 (หรือใส่ 5000 ถ้าอยากแจกฟรีตอนเทส)
            lastLogin: Date.now() 
        };
    }
    
    // (Optional) ถ้าเป็นกระเป๋าแอดมิน ให้เสกเหรียญไว้เทสได้
    // if (address.toLowerCase() === "กระเป๋าคุณ".toLowerCase()) users[address].coin = 10000;

    res.json({ 
        success: true, 
        balance: users[address].coin,
        message: "Login successful"
    });
});

/**
 * API: Withdraw (ขอใบเบิกเงิน)
 * หน้าที่: ตรวจสอบยอดเงิน -> หัก Coin -> เซ็น Digital Signature ส่งกลับไป
 */
app.post("/api/withdraw", async (req, res) => {
    console.log("---- 📝 WITHDRAW REQUEST ----");
    
    try {
        const { wallet, amount, message, signature } = req.body;

        // 1. Validation: ข้อมูลครบไหม
        if (!wallet || !amount || !message || !signature) {
            return res.status(400).json({ success: false, message: "Missing required parameters" });
        }

        // 2. Security: ตรวจสอบลายเซ็นผู้เล่น (ป้องกันคนอื่นมาสั่งถอนเงินเรา)
        if (!verifyUserSignature(message, signature, wallet)) {
            console.log(`❌ Fraud attempt detected for wallet: ${wallet}`);
            return res.status(401).json({ success: false, message: "Invalid User Signature! You are not the owner." });
        }

        // 3. User Check: มี User นี้ในระบบไหม
        const user = users[wallet];
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found. Please login first." });
        }

        // 4. Balance Check: เหรียญพอไหม
        if (user.coin < amount) {
            return res.status(400).json({ success: false, message: `Insufficient balance. You have ${user.coin} coins.` });
        }

        // 5. Calculation: คำนวณจำนวน WLD ที่จะได้รับ (หน่วย Wei)
        // สูตร: (Coin * 1e18) / Rate
        // ใช้ BigInt เพื่อความแม่นยำระดับทศนิยม 18 หลัก
        const amountWei = (BigInt(amount) * BigInt(10n ** 18n)) / BigInt(SELL_RATE);

        if (amountWei <= 0n) {
            return res.status(400).json({ success: false, message: "Amount too small to withdraw." });
        }

        // 6. Generate Signature (หัวใจสำคัญ 💖)
        // สร้าง Nonce (Unique ID) โดยใช้ Timestamp เพื่อไม่ให้ใช้ซ้ำได้ง่ายๆ
        // ในระบบจริงจังอาจต้องใช้ Database เช็ค Nonce ว่าเคยใช้ไปหรือยัง
        const nonce = Date.now(); 

        console.log(`Processing: ${wallet} wants to withdraw ${amount} Coins -> ${ethers.formatUnits(amountWei, 18)} WLD`);

        // Pack ข้อมูลให้ตรงกับ Solidity: keccak256(abi.encodePacked(user, amount, nonce, vaultAddress))
        const packedData = ethers.solidityPackedKeccak256(
            ["address", "uint256", "uint256", "address"],
            [wallet, amountWei, nonce, VAULT_ADDRESS]
        );

        // เซ็นรับรองด้วย Private Key ของ Server (Admin)
        const vaultSignature = await signer.signMessage(ethers.getBytes(packedData));

        // 7. Update Database: หักเหรียญออกจากเกมทันที
        user.coin -= amount;
        console.log(`✅ Approved! User balance deducted. New balance: ${user.coin}`);

        // 8. Response: ส่งข้อมูลกลับไปให้ Frontend ยิงเข้า Smart Contract
        res.json({
            success: true,
            claimData: {
                user: wallet,
                amount: amountWei.toString(), // ต้องส่งเป็น String เพราะ JSON ไม่รองรับ BigInt
                nonce: nonce,
                signature: vaultSignature,
                vaultAddress: VAULT_ADDRESS
            },
            newBalance: user.coin
        });

    } catch (e) {
        console.error("🔥 SERVER ERROR:", e);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
