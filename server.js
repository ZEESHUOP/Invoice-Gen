require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", __dirname + "/views");

app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(express.json({ limit: "5mb" }));
app.use(express.static(__dirname + "/public"));

app.use(session({
  secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  mobile: { type: String, default: "" },
  whatsapp: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});

const invoiceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  invoiceNumber: { type: String, required: true },
  orderId: { type: String, default: "" },
  invoiceDate: { type: String, default: "" },
  dueDate: { type: String, default: "" },
  reference: { type: String, default: "" },
  status: {
    type: String,
    enum: ["Paid", "Unpaid", "Pending", "Failed", "Cancelled"],
    default: "Pending"
  },
  seller: { type: Object, default: {} },
  customer: { type: Object, default: {} },
  shipping: { type: Object, default: {} },
  items: { type: Array, default: [] },
  payment: { type: Object, default: {} },
  totals: { type: Object, default: {} },
  design: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
const Invoice = mongoose.model("Invoice", invoiceSchema);

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ ok: false, message: "Please login first." });
  }
  next();
}

function makeInvoiceNumber() {
  const year = new Date().getFullYear();
  const random = Math.floor(100000 + Math.random() * 900000);
  return `INV-${year}-${random}`;
}

function makeOrderId() {
  const year = new Date().getFullYear();
  const random = Math.floor(100000 + Math.random() * 900000);
  return `ORD-${year}-${random}`;
}

app.get("/", (req, res) => {
  res.render("index", {
    loggedIn: Boolean(req.session.userId),
    userEmail: req.session.userEmail || ""
  });
});

app.post("/api/register", async (req, res) => {
  try {
    const { email, password, confirmPassword, mobile, whatsapp, terms } = req.body;

    if (!email || !password || !confirmPassword) {
      return res.status(400).json({ ok: false, message: "Email and password are required." });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ ok: false, message: "Passwords do not match." });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, message: "Password must be at least 6 characters." });
    }
    if (!terms) {
      return res.status(400).json({ ok: false, message: "Please accept Terms & Conditions." });
    }

    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) {
      return res.status(409).json({ ok: false, message: "Account already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      email: email.toLowerCase().trim(),
      passwordHash,
      mobile: mobile || "",
      whatsapp: whatsapp || ""
    });

    req.session.userId = user._id.toString();
    req.session.userEmail = user.email;

    res.json({ ok: true, message: "Account created successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Registration failed." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: (email || "").toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ ok: false, message: "Invalid email or password." });
    }

    const valid = await bcrypt.compare(password || "", user.passwordHash);
    if (!valid) {
      return res.status(401).json({ ok: false, message: "Invalid email or password." });
    }

    req.session.userId = user._id.toString();
    req.session.userEmail = user.email;

    res.json({ ok: true, message: "Login successful." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Login failed." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId).select("-passwordHash");
  res.json({ ok: true, user });
});

app.get("/api/dashboard", requireAuth, async (req, res) => {
  try {
    const invoices = await Invoice.find({ userId: req.session.userId }).lean();

    const paid = invoices.filter(i => i.status === "Paid");
    const pending = invoices.filter(i => i.status === "Pending");
    const unpaid = invoices.filter(i => i.status === "Unpaid");

    const totalIncome = paid.reduce((s, i) => s + Number(i.totals?.grandTotal || 0), 0);
    const totalRevenue = invoices.reduce((s, i) => s + Number(i.totals?.grandTotal || 0), 0);
    const pendingAmount = pending.reduce((s, i) => s + Number(i.totals?.grandTotal || 0), 0);

    const now = new Date();
    const monthlyIncome = paid
      .filter(i => {
        const d = new Date(i.createdAt);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      })
      .reduce((s, i) => s + Number(i.totals?.grandTotal || 0), 0);

    const monthLabels = [];
    const monthValues = [];
    for (let x = 5; x >= 0; x--) {
      const d = new Date(now.getFullYear(), now.getMonth() - x, 1);
      monthLabels.push(d.toLocaleString("en-IN", { month: "short" }));
      monthValues.push(
        paid.filter(i => {
          const id = new Date(i.createdAt);
          return id.getMonth() === d.getMonth() && id.getFullYear() === d.getFullYear();
        }).reduce((s, i) => s + Number(i.totals?.grandTotal || 0), 0)
      );
    }

    res.json({
      ok: true,
      stats: {
        totalIncome,
        totalRevenue,
        monthlyIncome,
        pendingAmount,
        paidCount: paid.length,
        pendingCount: pending.length,
        unpaidCount: unpaid.length,
        failedCount: invoices.filter(i => i.status === "Failed").length,
        cancelledCount: invoices.filter(i => i.status === "Cancelled").length,
        totalCount: invoices.length
      },
      chart: { labels: monthLabels, values: monthValues },
      recent: invoices.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Dashboard error." });
  }
});

app.get("/api/invoices", requireAuth, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && req.query.status !== "All") filter.status = req.query.status;

    const invoices = await Invoice.find({
      userId: req.session.userId,
      ...filter
    }).sort({ createdAt: -1 }).lean();

    res.json({ ok: true, invoices });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Could not load invoices." });
  }
});

app.post("/api/invoices", requireAuth, async (req, res) => {
  try {
    const data = req.body || {};
    const invoice = await Invoice.create({
      userId: req.session.userId,
      invoiceNumber: data.invoiceNumber || makeInvoiceNumber(),
      orderId: data.orderId || makeOrderId(),
      invoiceDate: data.invoiceDate || new Date().toISOString().slice(0,10),
      dueDate: data.dueDate || "",
      reference: data.reference || "",
      status: data.status || "Pending",
      seller: data.seller || {},
      customer: data.customer || {},
      shipping: data.shipping || {},
      items: Array.isArray(data.items) ? data.items : [],
      payment: data.payment || {},
      totals: data.totals || {},
      design: data.design || {}
    });

    res.json({ ok: true, invoice });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Could not save invoice." });
  }
});

app.put("/api/invoices/:id", requireAuth, async (req, res) => {
  try {
    const invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, userId: req.session.userId },
      { ...req.body, updatedAt: new Date() },
      { new: true, runValidators: true }
    );

    if (!invoice) return res.status(404).json({ ok: false, message: "Invoice not found." });
    res.json({ ok: true, invoice });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Could not update invoice." });
  }
});

app.delete("/api/invoices/:id", requireAuth, async (req, res) => {
  try {
    const result = await Invoice.deleteOne({
      _id: req.params.id,
      userId: req.session.userId
    });

    if (!result.deletedCount) return res.status(404).json({ ok: false, message: "Invoice not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Could not delete invoice." });
  }
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, () => console.log(`Invoice Gen running on port ${PORT}`));
  })
  .catch(err => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });
