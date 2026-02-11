const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const SELL_RATE = Number(process.env.SELL_RATE_COIN_PER_WLD);

// ERC20 transfer ABI
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) public returns (bool)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ERC20_ABI, signer);

// ⚠️ ตอนนี้ยังใช้ memory ก่อน
let users = {
  "0xPUT_REAL_WALLET_HERE": { coin: 5000 }
};

function verifySignature(message, signature, wallet) {
  const recovered = ethers.verifyMessage(message, signature);
  return recovered.toLowerCase() === wallet.toLowerCase();
}

app.post("/api/withdraw", async (req, res) => {
  try {
    const { wallet, amount, message, signature } = req.body;

    if (!wallet || !amount || !message || !signature)
      return res.status(400).json({ message: "Missing data" });

    if (!verifySignature(message, signature, wallet))
      return res.status(400).json({ message: "Invalid signature" });

    const user = users[wallet];
    if (!user)
      return res.status(400).json({ message: "User not found" });

    if (user.coin < amount)
      return res.status(400).json({ message: "Not enough coin" });

    // 🔥 คำนวณ WLD แบบไม่ใช้ float (ปลอดภัย)
    const parsedAmount =
      ethers.parseUnits(amount.toString(), 18) /
      BigInt(SELL_RATE);

    if (parsedAmount <= 0n)
      return res.status(400).json({ message: "Amount too small" });

    // 🔥 ยิงโอนก่อน
    const tx = await contract.transfer(wallet, parsedAmount);
    await tx.wait();

    // 🔥 ค่อยหัก coin หลัง tx สำเร็จ
    user.coin -= amount;

    res.json({
      success: true,
      newBalance: user.coin,
      txHash: tx.hash
    });

  } catch (e) {
    console.error(e);
    res.status(400).json({ message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});