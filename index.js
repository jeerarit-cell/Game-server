// ========================================================
// SIMPLE GAME SAVE SERVER (MODE B)
// ========================================================

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// ================= CONFIG =================
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const USER_FILE = path.join(DATA_DIR, "users.json");

// ================= INIT STORAGE =================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USER_FILE)) fs.writeFileSync(USER_FILE, "{}");

// ================= HELPERS =================
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

// ================= ROUTES =================

// ---- Health Check ----
app.get("/", (req, res) => {
  res.send("SERVER OK");
});

// ---- LOAD GAME DATA ----
// body: { userId }
app.post("/load", (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ ok: false, error: "NO_USER_ID" });
  }

  const users = readUsers();

  // ไม่สร้าง user เอง
  // ถ้าไม่มี = new user → client จะ init เอง
  res.json({
    ok: true,
    data: users[userId] || null
  });
});

// ---- SAVE GAME DATA ----
// body: { userId, data }
app.post("/save", (req, res) => {
  const { userId, data } = req.body;
  if (!userId || !data) {
    return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
  }

  const users = readUsers();

  // overwrite ตรง ๆ ตาม client
  users[userId] = {
    ...data,
    userId,
    updatedAt: now()
  };

  writeUsers(users);
  res.json({ ok: true });
});

// ================= START =================
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});