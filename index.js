const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// ===== CONFIG =====
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const USER_FILE = path.join(DATA_DIR, "users.json");

// ===== INIT STORAGE =====
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USER_FILE)) fs.writeFileSync(USER_FILE, "{}");

// ===== HELPERS =====
function readUsers() {
  return JSON.parse(fs.readFileSync(USER_FILE, "utf8"));
}

function writeUsers(data) {
  fs.writeFileSync(USER_FILE, JSON.stringify(data, null, 2));
}

function now() {
  return new Date().toISOString();
}

// ===== ROUTES =====

// 🔹 health check
app.get("/", (req, res) => {
  res.send("SERVER OK");
});

// 🔹 LOAD (หลัง login)
app.post("/load", (req, res) => {
  const { userId } = req.body;

  if (!userId)
    return res.status(400).json({ error: "NO_USER_ID" });

  const users = readUsers();

  // ผู้ใช้ใหม่
  if (!users[userId]) {
    users[userId] = {
      userId,
      createdAt: now(),
      updatedAt: now(),
      stats: {
        level: 1,
        gold: 0,
        win: 0,
        lose: 0
      },
      inventory: [],
      flags: {}
    };
    writeUsers(users);
  }

  res.json({
    ok: true,
    data: users[userId]
  });
});

// 🔹 SAVE (เซฟจากเกม)
app.post("/save", (req, res) => {
  const { userId, payload } = req.body;

  if (!userId || !payload)
    return res.status(400).json({ error: "BAD_REQUEST" });

  const users = readUsers();

  if (!users[userId])
    return res.status(404).json({ error: "USER_NOT_FOUND" });

  users[userId] = {
    ...users[userId],
    ...payload,
    updatedAt: now()
  };

  writeUsers(users);

  res.json({ ok: true });
});

// 🔹 FORFEIT / LOSS (กันหนี)
app.post("/forfeit", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.sendStatus(400);

  const users = readUsers();
  if (!users[userId]) return res.sendStatus(404);

  users[userId].stats.lose += 1;
  users[userId].updatedAt = now();

  writeUsers(users);
  res.json({ ok: true });
});

// ===== START =====
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});