const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
require("dotenv").config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ค่า Config
const RPC_URL = process.env.RPC_URL || "https://worldchain-mainnet.g.alchemy.com/public";
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY; // คีย์ของกระเป๋าบอท (คนเซ็น)
const VAULT_ADDRESS = process.env.CONTRACT_ADDRESS; // ⚠️ ใส่เลข Contract "GameVault" ที่คุณเพิ่ง Deploy
const SELL_RATE = Number(process.env.SELL_RATE_COIN_PER_WLD) || 1000;

// Setup Wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// จำลอง Database
let users = {};

app.post("/api/withdraw", async (req, res) => {
    console.log("---- CLAIM REQUEST ----");
    try {
        const { wallet, amount } = req.body; // รับแค่ wallet กับ amountCoin

        // 1. สร้าง User จำลองถ้าไม่มี (สำหรับเทส)
        if (!users[wallet]) users[wallet] = { coin: 5000 };
        const user = users[wallet];

        // 2. เช็คยอด Coin ในเกม
        if (user.coin < amount) {
            return res.status(400).json({ message: "Coin ไม่พอ" });
        }

        // 3. คำนวณยอด WLD (Wei)
        const amountWldWei = (BigInt(amount) * BigInt(10n ** 18n)) / BigInt(SELL_RATE);
        
        // 4. สร้าง "Nonce" (เลขรันป้องกันการใช้ซ้ำ)
        // ในระบบจริงควรเก็บ nonce ไว้ใน DB หรือดึงจาก Contract
        const nonce = Date.now(); 

        // 5. ✍️ สร้างลายเซ็น (Signature)
        // ต้องเรียงข้อมูลให้ตรงกับใน Solidity: (user, amount, nonce, vaultAddress)
        const packedData = ethers.solidityPackedKeccak256(
            ["address", "uint256", "uint256", "address"],
            [wallet, amountWldWei, nonce, VAULT_ADDRESS]
        );
        
        // เซ็นด้วย Private Key ของบอท
        const signature = await signer.signMessage(ethers.getBytes(packedData));

        // 6. หัก Coin ในเกมทันที (กันกดซ้ำ)
        user.coin -= amount;

        console.log(`✅ Signed for ${wallet}: ${amountWldWei.toString()} Wei`);

        // 7. ส่งลายเซ็นกลับไปให้ Frontend (ยังไม่มีการโอนเกิดขึ้นจริงตรงนี้)
        res.json({
            success: true,
            claimData: {
                amount: amountWldWei.toString(),
                nonce: nonce,
                signature: signature
            },
            newBalance: user.coin
        });

    } catch (e) {
        console.error("Server Error:", e);
        res.status(500).json({ message: e.message });
    }
});

// ... (ส่วน Login เหมือนเดิม)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
