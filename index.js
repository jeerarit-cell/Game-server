import express from "express";
import admin from "firebase-admin";

import cors from "cors";

const app = express();

// 🔥 ต้องมาก่อน routes
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());
app.options("*", cors());

// 🔑 โหลด key จาก ENV
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
import { ethers } from "ethers";
const db = admin.firestore();
const provider = new ethers.JsonRpcProvider(
  process.env.RPC_URL
);
const signer = new ethers.Wallet(
  process.env.SIGNER_PRIVATE_KEY,
  provider
);
// เพิ่มชั่วคราว
console.log("Signer address:", signer.address);

// ==== helper ====
function generateNonce() {
  return Date.now() + Math.floor(Math.random() * 100000);
}

// test route
app.get("/", (req, res) => {
  res.send("Game Server + Firestore connected");
});

const PORT = process.env.PORT || 3000;
// ===== SAVE GAME =====
app.post("/save", async (req, res) => {
  const { userId, data } = req.body;

  if (!userId || !data) {
    return res.status(400).json({ error: "missing userId or data" });
  }

  await db.collection("users").doc(userId).set({
    ...data,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.json({ success: true });
});

// ===== LOAD GAME =====
app.post("/load", async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "missing userId" });
  }

  const doc = await db.collection("users").doc(userId).get();

  if (!doc.exists) {
    return res.json({ exists: false });
  }

  res.json({ exists: true, data: doc.data() });
});


// 👇 วางตรงนี้
app.post("/sell/prepare", async (req, res) => {
  try {
    const { userId, amountCoin, userWallet } = req.body;

    if (!userId || !amountCoin || !userWallet) {
      return res.status(400).json({ ok: false, message: "missing params" });
    }

    const userRef = db.collection("users").doc(userId);
    const snap = await userRef.get();

    if (!snap.exists) {
      return res.json({ ok: false, message: "user not found" });
    }

    const user = snap.data();
    if (user.coin < amountCoin) {
      return res.json({ ok: false, message: "not enough coin" });
    }

    const COIN_PER_WLD = Number(process.env.SELL_RATE_COIN_PER_WLD);
    const amountWLD = amountCoin / COIN_PER_WLD;

    const nonce = generateNonce();

    const amountWLDWei = ethers.parseUnits(amountWLD.toString(), 18);

    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address"],
      [
        userWallet,
        amountWLDWei,
        nonce,
        process.env.CONTRACT_ADDRESS
      ]
    );

    const signature = await signer.signMessage(
      ethers.getBytes(messageHash)
    );

    await db.collection("sellOrders").doc(String(nonce)).set({
      userId,
      userWallet,
      amountCoin,
      amountWLD,
      nonce,
      status: "PREPARED",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      ok: true,
      amountWLD,
      amountWLDWei: amountWLDWei.toString(),
      nonce,
      signature
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});
   app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});