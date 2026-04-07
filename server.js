require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── MONGOOSE CONNECT ───────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─── SCHEMAS ────────────────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  name: String,
  phone: String,
  address: String,
  pincode: String,
  city: String,
  state: String,
  product: String,
  productName: String,
  productId: String,
  quantity: { type: Number, default: 1 },
  size: String,
  price: Number,
  totalAmount: Number,
  addressScore: { type: Number, default: 0 },
  status: { type: String, enum: ['new','confirmed','shipped','delivered','cancelled'], default: 'new' },
  createdAt: { type: Date, default: Date.now }
});

const productSchema = new mongoose.Schema({
  name: String,
  description: String,
  price: Number,
  mrp: Number,
  images: [String],      // supports 1–3 images
  benefits: [String],
  ingredients: String,
  howToUse: String,
  stock: { type: Number, default: 100 },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const settingSchema = new mongoose.Schema({
  metaPixel: String,
  backendUrl: String
});

// ─── TOKEN STORE (in-memory, simple) ────────────────────────────────
// For production consider JWT, but this keeps it dependency-free
const activeTokens = new Set();

const Order   = mongoose.model('Order',   orderSchema);
const Product = mongoose.model('Product', productSchema);
const Setting = mongoose.model('Setting', settingSchema);

// ─── ADMIN AUTH MIDDLEWARE ───────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ─── HELPER: address score ───────────────────────────────────────────
function calcAddressScore(addr, pincode, city, state) {
  let score = 0;
  if (addr && addr.trim().length > 10) score += 40;
  else if (addr && addr.trim().length > 5) score += 20;
  if (pincode && /^\d{6}$/.test(pincode)) score += 20;
  if (city && city.trim().length > 1) score += 20;
  if (state && state.trim().length > 1) score += 20;
  return score;
}

// ─── PUBLIC ROUTES ───────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', brand: 'Vaidyakart' }));

// Place order (public — customers submit from frontend)
app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, address, pincode, city, state, product, productName, productId, quantity, size, price, totalAmount } = req.body;
    const addressScore = calcAddressScore(address, pincode, city, state);
    const order = new Order({ name, phone, address, pincode, city, state, product, productName, productId, quantity: quantity||1, size, price, totalAmount, addressScore });
    await order.save();
    res.json({ success: true, orderId: order._id });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Public products (active only — used by frontend landing page)
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find({ active: true });
    res.json({ success: true, products });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Pincode lookup (public)
app.get('/api/pincode/:pin', async (req, res) => {
  try {
    const resp = await fetch(`https://api.postalpincode.in/pincode/${req.params.pin}`);
    const data = await resp.json();
    res.json(data);
  } catch(e) { res.json([{ Status: 'Error' }]); }
});

// Meta pixel (public read)
app.get('/api/meta', async (req, res) => {
  try {
    const s = await Setting.findOne();
    res.json({ success: true, metaPixel: s?.metaPixel || '' });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── ADMIN LOGIN ──────────────────────────────────────────────────────

// ─── LIVE VISITOR TRACKING ───────────────────────────────────────────
const visitorPings = new Map(); // sessionId -> { lastPing, page }

app.post('/api/visitors/ping', (req, res) => {
  const { sessionId, page } = req.body;
  if (!sessionId) return res.json({ success: false });
  visitorPings.set(sessionId, { lastPing: Date.now(), page: page || '/' });
  const now = Date.now();
  for (const [id, v] of visitorPings) { if (now - v.lastPing > 45000) visitorPings.delete(id); }
  res.json({ success: true });
});

app.get('/api/visitors/live', requireAdmin, (req, res) => {
  const now = Date.now();
  for (const [id, v] of visitorPings) { if (now - v.lastPing > 45000) visitorPings.delete(id); }
  res.json({ success: true, count: visitorPings.size });
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USER &&
    password === process.env.ADMIN_PASS
  ) {
    const token = 'vk_admin_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    activeTokens.add(token);
    // Auto-expire token after 24 hours
    setTimeout(() => activeTokens.delete(token), 24 * 60 * 60 * 1000);
    res.json({ success: true, token });
  } else {
    res.json({ success: false, error: 'Invalid credentials' });
  }
});

// Admin logout
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.headers['authorization'].slice(7);
  activeTokens.delete(token);
  res.json({ success: true });
});

// ─── ADMIN-PROTECTED ROUTES ───────────────────────────────────────────

// All orders (admin)
app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const { status, search, from, to, page = 1, limit = 50 } = req.query;
    let query = {};
    if (status && status !== 'all') query.status = status;
    if (search) query.$or = [
      { name: new RegExp(search, 'i') },
      { phone: new RegExp(search, 'i') },
      { city: new RegExp(search, 'i') }
    ];
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59,999); query.createdAt.$lte = d; }
    }
    const skip = (parseInt(page)-1) * parseInt(limit);
    const total = await Order.countDocuments(query);
    const orders = await Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit));
    res.json({ success: true, orders, total, page: parseInt(page), pages: Math.ceil(total/parseInt(limit)) });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Bulk status update — MUST be BEFORE /api/orders/:id routes to avoid Express matching 'bulk' as an :id
app.put('/api/orders/bulk/status', requireAdmin, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!ids || !ids.length) return res.json({ success: false, error: 'No IDs provided' });
    const validStatuses = ['new','confirmed','shipped','delivered','cancelled'];
    if (!validStatuses.includes(status)) return res.json({ success: false, error: 'Invalid status' });
    const result = await Order.updateMany({ _id: { $in: ids } }, { $set: { status } });
    res.json({ success: true, updated: result.modifiedCount });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Update single order status
app.put('/api/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await Order.findByIdAndUpdate(req.params.id, { status });
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Delete order
app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    await Order.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Export CSV
app.get('/api/orders/export/csv', requireAdmin, async (req, res) => {
  try {
    const { from, to, status } = req.query;
    let query = {};
    if (status && status !== 'all') query.status = status;
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59,999); query.createdAt.$lte = d; }
    }
    const orders = await Order.find(query).sort({ createdAt: -1 });
    const headers = ['Order ID','Name','Phone','Address','Pincode','City','State','Product','Size','Qty','Amount','Address Score','Status','Date'];
    const rows = orders.map(o => [
      o._id, o.name, o.phone, `"${(o.address||'').replace(/"/g,'""')}"`,
      o.pincode, o.city, o.state, o.productName, o.size||'', o.quantity,
      o.totalAmount, o.addressScore||0, o.status,
      new Date(o.createdAt).toLocaleString('en-IN')
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="vaidyakart-orders.csv"');
    res.send(csv);
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// All products (admin — includes inactive)
app.get('/api/products/all', requireAdmin, async (req, res) => {
  try {
    const products = await Product.find();
    res.json({ success: true, products });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Create product
app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const p = new Product(req.body);
    await p.save();
    res.json({ success: true, product: p });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Update product
app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const p = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, product: p });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Delete product
app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Stats (admin)
app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    let dateQuery = {};
    if (from || to) {
      dateQuery.createdAt = {};
      if (from) dateQuery.createdAt.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59,999); dateQuery.createdAt.$lte = d; }
    }
    const [totalOrders, newOrders, confirmedOrders, shippedOrders, deliveredOrders, cancelledOrders, revenueData, latestOrders] = await Promise.all([
      Order.countDocuments(dateQuery),
      Order.countDocuments({ ...dateQuery, status: 'new' }),
      Order.countDocuments({ ...dateQuery, status: 'confirmed' }),
      Order.countDocuments({ ...dateQuery, status: 'shipped' }),
      Order.countDocuments({ ...dateQuery, status: 'delivered' }),
      Order.countDocuments({ ...dateQuery, status: 'cancelled' }),
      Order.aggregate([{ $match: { ...dateQuery, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$totalAmount' } } }]),
      Order.find(dateQuery && Object.keys(dateQuery).length ? dateQuery : {}).sort({ createdAt: -1 }).limit(10)
    ]);
    const revenue = revenueData[0]?.total || 0;
    const chartData = await Order.aggregate([
      { $match: dateQuery },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 }, revenue: { $sum: '$totalAmount' } } },
      { $sort: { _id: 1 } },
      { $limit: 30 }
    ]);
    res.json({ success: true, totalOrders, newOrders, confirmedOrders, shippedOrders, deliveredOrders, cancelledOrders, revenue, chartData, latestOrders });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Meta pixel (admin write)
app.post('/api/meta', requireAdmin, async (req, res) => {
  try {
    const { metaPixel } = req.body;
    let s = await Setting.findOne();
    if (s) { s.metaPixel = metaPixel; await s.save(); }
    else { s = await Setting.create({ metaPixel }); }
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Settings (admin)
app.get('/api/settings', requireAdmin, async (req, res) => {
  try {
    const s = await Setting.findOne();
    res.json({ success: true, metaPixel: s?.metaPixel || '', backendUrl: s?.backendUrl || '' });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/settings', requireAdmin, async (req, res) => {
  try {
    const { metaPixel, backendUrl } = req.body;
    let s = await Setting.findOne();
    if (s) { if(metaPixel!==undefined) s.metaPixel=metaPixel; if(backendUrl!==undefined) s.backendUrl=backendUrl; await s.save(); }
    else { s = await Setting.create({ metaPixel, backendUrl }); }
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Seed default product
app.post('/api/seed', async (req, res) => {
  try {
    const count = await Product.countDocuments();
    if (count === 0) {
      await Product.create({
        name: 'Sugar Control Powder',
        description: 'Vaidyakart Sugar Control Powder — Ayurvedic blend of 12 herbs to naturally manage blood sugar levels. Trusted by thousands across India.',
        price: 599,
        mrp: 1299,
        images: [],
        benefits: ['Controls blood sugar naturally','Boosts insulin sensitivity','Reduces sugar cravings','Improves pancreatic health','No side effects — 100% Ayurvedic','Results in 4–6 weeks'],
        ingredients: 'Karela, Jamun, Methi, Giloy, Vijaysar, Neem, Amla, Gurmar, Ashwagandha, Haritaki, Bibhitaki, Amalaki',
        howToUse: 'Mix 1 teaspoon in warm water. Drink on empty stomach every morning. Use daily for best results.',
        stock: 200,
        active: true
      });
      res.json({ success: true, message: 'Seeded Sugar Control Powder' });
    } else {
      res.json({ success: true, message: 'Products already exist' });
    }
  } catch(e) { res.json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Vaidyakart server running on port ${PORT}`));
