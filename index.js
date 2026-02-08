import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json());

// 🔑 โหลด key จาก ENV
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

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