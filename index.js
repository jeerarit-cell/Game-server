const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

// ทดสอบก่อน ใช้ memory
let users = {
  "0xPUT_REAL_WALLET_HERE": { coin: 1000 }
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
    if (!user) return res.status(400).json({ message: "User not found" });
    if (user.coin < amount)
      return res.status(400).json({ message: "Not enough coin" });

    user.coin -= amount;

    res.json({
      success: true,
      newBalance: user.coin
    });

  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

// ❗ Render ใช้ process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});