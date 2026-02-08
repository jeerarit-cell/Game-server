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
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});