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
// ================================
// LOAD + NORMALIZE SAVE (MASTER)
// ================================
app.post("/load", (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: "missing userId" });
    }

    console.log("[LOAD] userId =", userId);

    let save = db.get(userId);

    // -------------------------------
    // NEW USER (NO SAVE)
    // -------------------------------
    if (!save) {
        console.log("[LOAD] new user, create default save");

        save = {
            userId,
            createdAt: Date.now(),
            updatedAt: Date.now(),

            // progression
            level: 1,
            exp: 0,
            gold: 0,

            // HP / combat
            maxHP: 20,
            currentHP: 20,

            // sudden death
            suddenDeath: {
                active: false,
                baseMaxHP: 20
            },

            // battle
            battle: {
                inBattle: false,
                enemyId: null,
                turn: 0
            },

            // daily
            daily: {
                lastClaim: 0,
                streak: 0
            },

            // flags
            flags: {
                forfeit: false,
                locked: false
            },

            version: 1
        };

        db.set(userId, save);
        return res.json(save);
    }

    // -------------------------------
    // NORMALIZE EXISTING SAVE
    // -------------------------------
    console.log("[LOAD] existing save, normalize");

    const normalized = {
        // identity
        userId,
        createdAt: save.createdAt ?? Date.now(),
        updatedAt: Date.now(),

        // progression
        level: Number.isInteger(save.level) ? save.level : 1,
        exp: Number.isInteger(save.exp) ? save.exp : 0,
        gold: Number.isInteger(save.gold) ? save.gold : 0,

        // HP
        maxHP: Number.isInteger(save.maxHP) ? save.maxHP : 20,
        currentHP: Number.isInteger(save.currentHP)
            ? Math.min(save.currentHP, save.maxHP ?? 20)
            : (save.maxHP ?? 20),

        // sudden death
        suddenDeath: {
            active: !!save.suddenDeath?.active,
            baseMaxHP: Number.isInteger(save.suddenDeath?.baseMaxHP)
                ? save.suddenDeath.baseMaxHP
                : (save.maxHP ?? 20)
        },

        // battle
        battle: {
            inBattle: !!save.battle?.inBattle,
            enemyId: save.battle?.enemyId ?? null,
            turn: Number.isInteger(save.battle?.turn) ? save.battle.turn : 0
        },

        // daily
        daily: {
            lastClaim: Number.isInteger(save.daily?.lastClaim)
                ? save.daily.lastClaim
                : 0,
            streak: Number.isInteger(save.daily?.streak)
                ? save.daily.streak
                : 0
        },

        // flags
        flags: {
            forfeit: !!save.flags?.forfeit,
            locked: !!save.flags?.locked
        },

        version: 1
    };

    // overwrite normalized save
    db.set(userId, normalized);

    console.log("[LOAD] normalized save sent");

    res.json(normalized);
});
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
    data,
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
   app.post("/sell/confirm", async (req, res) => {
  try {
    const { nonce, txHash } = req.body;

    if (!nonce || !txHash) {
      return res.status(400).json({ ok: false, message: "missing params" });
    }

    // 1. เช็ก order
    const orderRef = db.collection("sellOrders").doc(String(nonce));
    const snap = await orderRef.get();

    if (!snap.exists) {
      return res.json({ ok: false, message: "order not found" });
    }

    const order = snap.data();
    if (order.status === "DONE") {
      return res.json({ ok: true, message: "already confirmed" });
    }

    // 2. ตรวจ tx บน chain
    const tx = await provider.getTransactionReceipt(txHash);
    if (!tx || tx.status !== 1) {
      return res.json({ ok: false, message: "tx not confirmed yet" });
    }

    // 3. ตัด coin ผู้เล่น
    const userRef = db.collection("users").doc(order.userId);

    await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) throw new Error("user missing");

      const user = userSnap.data();
      if (user.coin < order.amountCoin) {
        throw new Error("coin already used");
      }

      t.update(userRef, {
        coin: user.coin - order.amountCoin
      });

      t.update(orderRef, {
        status: "DONE",
        txHash,
        confirmedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});
   app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});