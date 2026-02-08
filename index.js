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
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});