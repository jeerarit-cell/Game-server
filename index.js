// ========================================================
// GAME SAVE SERVER (STABLE / FULL FLOW)
// ========================================================

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const USER_FILE = path.join(DATA_DIR, "users.json");

// ---------------- INIT ----------------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USER_FILE)) fs.writeFileSync(USER_FILE, "{}");

// ---------------- HELPERS ----------------
function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USER_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeUsers(data) {
  fs.writeFileSync(USER_FILE, JSON.stringify(data, null, 2));
}

function now() {
  return new Date().toISOString();
}

function defaultGameData(userId) {
  return {
    userId,
    coin: 200,
    level: 1,
    exp: 0,
    hp: 20,
    maxHP: 20,
    inBattle: false,
    isSuddenDeath: false,
    earnedToday: 0,
    lastRewardDate: new Date().toDateString(),
    dailyStamp: [],
    stampStreak: 0,
    createdAt: now(),
    updatedAt: now()
  };
}

// ---------------- ROUTES ----------------

// Health
app.get("/", (req, res) => {
  res.send("SERVER OK");
});

// LOAD
app.post("/load", (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ ok: false, error: "NO_USER_ID" });
  }

  const users = readUsers();

  if (!users[userId]) {
    users[userId] = defaultGameData(userId);
    writeUsers(users);
  }

  res.json({
    ok: true,
    data: users[userId]
  });
});

// SAVE
app.post("/save", (req, res) => {
  const { userId, data } = req.body;
  if (!userId || !data) {
    return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
  }

  const users = readUsers();

  users[userId] = {
    ...data,
    userId,
    updatedAt: now()
  };

  writeUsers(users);
  res.json({ ok: true });
});

// FORFEIT (กันหนี / disconnect)
app.post("/forfeit", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ ok: false });

  const users = readUsers();
  if (!users[userId]) return res.status(404).json({ ok: false });

  users[userId].inBattle = false;
  users[userId].updatedAt = now();
  writeUsers(users);

  res.json({ ok: true });
});

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});