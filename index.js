const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

/*
  ตอนนี้ใช้ memory store ไปก่อน
  เดี๋ยวค่อยเปลี่ยนเป็น Firebase
*/
let users = {
  "0xUserWalletHere": {
    coin: 1000
  }
};

function verifySignature(message, signature, wallet) {
  const recovered = ethers.verifyMessage(message, signature);
  return recovered.toLowerCase() === wallet.toLowerCase();
}

app.post("/api/withdraw", async (req, res) => {
  try {
    const { wallet, amount, message, signature } = req.body;

    if (!wallet || !amount || !signature)
      return res.status(400).json({ message: "Missing data" });

    if (!verifySignature(message, signature, wallet))
      return res.status(400).json({ message: "Invalid signature" });

    const user = users[wallet];
    if (!user)
      return res.status(400).json({ message: "User not found" });

    if (user.coin < amount)
      return res.status(400).json({ message: "Not enough coin" });

    // 🔥 หัก coin ที่ server
    user.coin -= amount;

    return res.json({
      success: true,
      newBalance: user.coin
    });

  } catch (e) {
    return res.status(400).json({ message: e.message });
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});