// ============================================
// RECLAIM BACKEND — Node.js + Express
// ============================================
// SETUP:
// npm init -y
// npm install express mongoose jsonwebtoken bcryptjs dotenv cors @google/generative-ai
// ============================================

// 📁 Folder Structure:
// reclaim-backend/
// ├── server.js
// ├── .env
// ├── config/
// │   └── db.js
// ├── models/
// │   └── User.js
// ├── middleware/
// │   └── auth.js
// └── routes/
//     ├── auth.js
//     ├── quests.js
//     ├── leaderboard.js
//     └── aiCoach.js

// ============================================
// .env
// ============================================
// PORT=5000
// MONGO_URI=your_mongodb_atlas_uri
// JWT_SECRET=entropy_reclaimers_secret_key
// GEMINI_API_KEY=your_gemini_api_key

// ============================================
// config/db.js
// ============================================
const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB Connected");
  } catch (err) {
    console.error("❌ DB Error:", err.message);
    process.exit(1);
  }
};

module.exports = connectDB;

// ============================================
// models/User.js
// ============================================
const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  name:             { type: String, required: true },
  email:            { type: String, required: true, unique: true },
  password:         { type: String, required: true },
  xp:               { type: Number, default: 0 },
  coins:            { type: Number, default: 0 },
  streak:           { type: Number, default: 0 },
  level:            { type: Number, default: 1 },
  guild:            { type: String, default: null },
  addictionScore:   { type: String, default: "Medium" }, // Low / Medium / High
  questsCompleted:  { type: Number, default: 0 },
  lastQuestDate:    { type: Date, default: null },
  screenTimeToday:  { type: Number, default: 0 }, // in minutes
}, { timestamps: true });

module.exports = mongoose.model("User", UserSchema);

// ============================================
// middleware/auth.js
// ============================================
const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ msg: "No token. Access denied." });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ msg: "Invalid token." });
  }
};

// ============================================
// routes/auth.js
// ============================================
const express = require("express");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const User    = require("../models/User");
const router  = express.Router();

// POST /auth/register
router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  try {
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ msg: "User already exists" });

    const hash = await bcrypt.hash(password, 10);
    user = await User.create({ name, email, password: hash });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user._id, name, email, xp: 0, coins: 0 } });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

// POST /auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ msg: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user._id, name: user.name, xp: user.xp, coins: user.coins, streak: user.streak } });
  } catch {
    res.status(500).json({ msg: "Server error" });
  }
});

module.exports = router;

// ============================================
// routes/quests.js
// ============================================
const express = require("express");
const User    = require("../models/User");
const auth    = require("../middleware/auth");
const router  = express.Router();

// XP rewards per quest type
const XP_REWARDS = {
  focus_25:   25,
  focus_45:   45,
  focus_60:   60,
  nap:        30,   // Offline NSDR Quest
  exercise:   20,   // Endorphin Break
  braingame:  10,   // Brain Game bonus
};

// POST /quests/complete
router.post("/complete", auth, async (req, res) => {
  const { questType } = req.body; // e.g. "focus_60", "nap", "exercise"

  const xpEarned = XP_REWARDS[questType] || 10;
  const user     = await User.findById(req.user.id);

  // Check & update streak
  const today     = new Date().toDateString();
  const lastDate  = user.lastQuestDate ? new Date(user.lastQuestDate).toDateString() : null;
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  if (lastDate === yesterday) user.streak += 1;       // Continues streak
  else if (lastDate !== today) user.streak = 1;       // Resets streak

  // Streak multiplier (2x if 3+ day streak)
  const multiplier  = user.streak >= 3 ? 2 : 1;
  const finalXP     = xpEarned * multiplier;

  user.xp              += finalXP;
  user.coins           += Math.floor(finalXP / 10); // 10 XP = 1 Coin
  user.questsCompleted += 1;
  user.lastQuestDate    = new Date();
  user.level            = Math.floor(user.xp / 200) + 1; // Level up every 200 XP

  // Recalculate addiction score
  if (user.screenTimeToday < 120)      user.addictionScore = "Low";
  else if (user.screenTimeToday < 300) user.addictionScore = "Medium";
  else                                  user.addictionScore = "High";

  await user.save();

  res.json({
    msg:       "Quest completed! 🎉",
    xpEarned:  finalXP,
    streak:    user.streak,
    level:     user.level,
    coins:     user.coins,
    multiplier,
  });
});

// GET /quests/profile — get user dashboard stats
router.get("/profile", auth, async (req, res) => {
  const user = await User.findById(req.user.id).select("-password");
  res.json(user);
});

module.exports = router;

// ============================================
// routes/leaderboard.js
// ============================================
const express = require("express");
const User    = require("../models/User");
const router  = express.Router();

// GET /leaderboard/global — Top 10 by XP
router.get("/global", async (req, res) => {
  const top = await User.find()
    .sort({ xp: -1 })
    .limit(10)
    .select("name xp coins streak level");

  res.json(top);
});

// GET /leaderboard/guild/:guildName
router.get("/guild/:guildName", async (req, res) => {
  const members = await User.find({ guild: req.params.guildName })
    .sort({ xp: -1 })
    .select("name xp streak level");

  res.json(members);
});

module.exports = router;

// ============================================
// routes/aiCoach.js
// ============================================
const express     = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const auth        = require("../middleware/auth");
const User        = require("../models/User");
const router      = express.Router();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// POST /ai/nudge
router.post("/nudge", auth, async (req, res) => {
  const user = await User.findById(req.user.id);

  const prompt = `
    You are "Rec", a friendly AI habit coach in a student focus app called Reclaim.
    Student name: ${user.name}
    Screen time today: ${user.screenTimeToday} minutes
    Current focus streak: ${user.streak} days
    Addiction level: ${user.addictionScore}
    Quests completed today: ${user.questsCompleted}

    Give a SHORT (2-3 lines), motivating, casual message like a friend.
    If addiction is High, be more urgent. If streak is 3+, celebrate it.
    Suggest one specific offline action (nap, pushups, or a focus quest).
  `;

  try {
    const model    = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result   = await model.generateContent(prompt);
    const message  = result.response.text();
    res.json({ message });
  } catch {
    // Fallback responses if API fails (great for demo!)
    const fallbacks = [
      `Hey ${user.name}! You've been on your phone too long. Start a 25-min Focus Quest — your streak is waiting! 🔥`,
      `${user.name}, your brain needs a break. Try a 20-min power nap and come back stronger 💪`,
      `3 hours of scrolling vs 1 hour of focus — you know which one wins. Start your quest now! ⚔️`,
    ];
    res.json({ message: fallbacks[Math.floor(Math.random() * fallbacks.length)] });
  }
});

module.exports = router;

// ============================================
// server.js  ← THIS IS YOUR MAIN FILE
// ============================================
require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const connectDB = require("./config/db");

const app = express();
connectDB();

app.use(cors());
app.use(express.json());

// Routes
app.use("/auth",        require("./routes/auth"));
app.use("/quests",      require("./routes/quests"));
app.use("/leaderboard", require("./routes/leaderboard"));
app.use("/ai",          require("./routes/aiCoach"));

// Health check
app.get("/", (req, res) => res.json({ msg: "🚀 Reclaim API is live!" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
