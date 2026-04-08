require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ─── MONGOOSE CONNECT ───────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─── SCHEMAS ────────────────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  name: String, phone: String, address: String, pincode: String,
  city: String, state: String, product: String, productName: String,
  productId: String, quantity: { type: Number, default: 1 }, size: String,
  price: Number, totalAmount: Number, addressScore: { type: Number, default: 0 },
  status: { type: String, enum: ['new','confirmed','shipped','delivered','cancelled'], default: 'new' },
  shippedAt: { type: Date }, createdAt: { type: Date, default: Date.now }
});

const productSchema = new mongoose.Schema({
  name: String, description: String, price: Number, mrp: Number,
  images: [String], benefits: [String], ingredients: String, howToUse: String,
  stock: { type: Number, default: 100 }, active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const settingSchema = new mongoose.Schema({ metaPixel: String, backendUrl: String });

const testimonialSchema = new mongoose.Schema({
  name: String, location: String, text: String, rating: { type: Number, default: 5 },
  videoUrl: String, avatarLetter: String, active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// FIX: Persistent token schema — tokens survive redeploys because they live in MongoDB
// MongoDB TTL index auto-deletes tokens after 24 hours
const adminTokenSchema = new mongoose.Schema({
  token: { type: String, unique: true, index: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
});

const Order       = mongoose.model('Order',       orderSchema);
const Product     = mongoose.model('Product',     productSchema);
const Setting     = mongoose.model('Setting',     settingSchema);
const Testimonial = mongoose.model('Testimonial', testimonialSchema);
const AdminToken  = mongoose.model('AdminToken',  adminTokenSchema);

// ─── ADMIN AUTH MIDDLEWARE ────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const found = await AdminToken.findOne({ token });
    if (!found) return res.status(401).json({ success: false, error: 'Session expired — please login again' });
    next();
  } catch(e) { return res.status(500).json({ success: false, error: 'Auth error' }); }
}

// ─── HELPER: address score ────────────────────────────────────────────
function calcAddressScore(addr, pincode, city, state) {
  let score = 0;
  if (addr && addr.trim().length > 10) score += 40;
  else if (addr && addr.trim().length > 5) score += 20;
  if (pincode && /^\d{6}$/.test(pincode)) score += 20;
  if (city && city.trim().length > 1) score += 20;
  if (state && state.trim().length > 1) score += 20;
  return score;
}

// ─── PUBLIC ROUTES ────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', brand: 'Vaidyakart', ts: Date.now() }));

app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, address, pincode, city, state, product, productName, productId, quantity, size, price, totalAmount } = req.body;
    if (!name || !name.trim()) return res.json({ success: false, error: 'Name is required' });
    if (!phone || !/^\d{10}$/.test(phone.trim())) return res.json({ success: false, error: 'Valid 10-digit phone is required' });
    if (!address || !address.trim()) return res.json({ success: false, error: 'Address is required' });
    if (!pincode || !/^\d{6}$/.test(pincode.trim())) return res.json({ success: false, error: 'Valid 6-digit pincode is required' });
    if (!city || !city.trim()) return res.json({ success: false, error: 'City is required — valid pincode needed' });
    if (!state || !state.trim()) return res.json({ success: false, error: 'State is required — valid pincode needed' });
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const dup = await Order.findOne({ phone: phone.trim(), createdAt: { $gte: tenMinAgo } });
    if (dup) return res.json({ success: false, duplicate: true, error: 'Aapka order pehle se place ho chuka hai! Thoda wait karein ya customer care se contact karein.' });
    const addressScore = calcAddressScore(address, pincode, city, state);
    const order = new Order({ name, phone, address, pincode, city, state, product, productName, productId, quantity: quantity||1, size, price, totalAmount, addressScore });
    await order.save();
    res.json({ success: true, orderId: order._id });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/products', async (req, res) => {
  try { const products = await Product.find({ active: true }); res.json({ success: true, products }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/pincode/:pin', async (req, res) => {
  try { const resp = await fetch(`https://api.postalpincode.in/pincode/${req.params.pin}`); const data = await resp.json(); res.json(data); }
  catch(e) { res.json([{ Status: 'Error' }]); }
});

app.get('/api/meta', async (req, res) => {
  try { const s = await Setting.findOne(); res.json({ success: true, metaPixel: s?.metaPixel || '' }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/testimonials', async (req, res) => {
  try { const testimonials = await Testimonial.find({ active: true }).sort({ createdAt: -1 }); res.json({ success: true, testimonials }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── LIVE VISITOR TRACKING ────────────────────────────────────────────
const visitorPings = new Map();
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

// ─── ADMIN LOGIN ──────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = 'vk_admin_' + Date.now() + '_' + crypto.randomBytes(16).toString('hex');
    try { await AdminToken.create({ token }); res.json({ success: true, token }); }
    catch(e) { res.json({ success: false, error: 'Login failed: ' + e.message }); }
  } else {
    res.json({ success: false, error: 'Invalid credentials' });
  }
});

app.post('/api/admin/logout', requireAdmin, async (req, res) => {
  const token = req.headers['authorization'].slice(7);
  await AdminToken.deleteOne({ token });
  res.json({ success: true });
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────
app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const { status, search, from, to, page = 1, limit = 50 } = req.query;
    let query = {};
    if (status && status !== 'all') query.status = status;
    if (search) query.$or = [{ name: new RegExp(search,'i') },{ phone: new RegExp(search,'i') },{ city: new RegExp(search,'i') }];
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

// ─── FIX: CSV export MUST come before /api/orders/:id routes ─────────
// Old code had this AFTER /:id routes so Express matched "export" as the :id param
app.get('/api/orders/export/csv', requireAdmin, async (req, res) => {
  try {
    const { from, to, status, ids } = req.query;
    let query = {};
    if (ids) { const idList = ids.split(',').filter(Boolean); query._id = { $in: idList }; }
    else {
      if (status && status !== 'all') query.status = status;
      if (from || to) {
        query.createdAt = {};
        if (from) query.createdAt.$gte = new Date(from);
        if (to) { const d = new Date(to); d.setHours(23,59,59,999); query.createdAt.$lte = d; }
      }
    }
    const orders = await Order.find(query).sort({ createdAt: -1 });
    const headers = ['Order ID','Name','Phone','Address','Pincode','City','State','Product','Qty','Amount','Address Score','Status','Shipped At','Date'];
    const rows = orders.map(o => [
      o._id, o.name, o.phone, `"${(o.address||'').replace(/"/g,'""')}"`,
      o.pincode, o.city, o.state, o.productName, o.quantity,
      o.totalAmount, o.addressScore||0, o.status,
      o.shippedAt ? new Date(o.shippedAt).toLocaleString('en-IN') : '',
      new Date(o.createdAt).toLocaleString('en-IN')
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="vaidyakart-orders.csv"');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(csv);
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.put('/api/orders/bulk/status', requireAdmin, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!ids || !ids.length) return res.json({ success: false, error: 'No IDs provided' });
    const validStatuses = ['new','confirmed','shipped','delivered','cancelled'];
    if (!validStatuses.includes(status)) return res.json({ success: false, error: 'Invalid status' });
    const updateData = { status };
    if (status === 'shipped') updateData.shippedAt = new Date();
    const result = await Order.updateMany({ _id: { $in: ids } }, { $set: updateData });
    res.json({ success: true, updated: result.modifiedCount });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.put('/api/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const updateData = { status };
    if (status === 'shipped') updateData.shippedAt = new Date();
    await Order.findByIdAndUpdate(req.params.id, updateData);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  try { await Order.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/products/all', requireAdmin, async (req, res) => {
  try { const products = await Product.find(); res.json({ success: true, products }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/products', requireAdmin, async (req, res) => {
  try { const p = new Product(req.body); await p.save(); res.json({ success: true, product: p }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try { const p = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json({ success: true, product: p }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try { await Product.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

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
      { $sort: { _id: 1 } }, { $limit: 30 }
    ]);
    let avgOrderIntervalMin = null;
    const recentOrders = await Order.find(dateQuery).sort({ createdAt: 1 }).select('createdAt').limit(200);
    if (recentOrders.length >= 2) {
      let totalMs = 0;
      for (let i = 1; i < recentOrders.length; i++) totalMs += new Date(recentOrders[i].createdAt) - new Date(recentOrders[i-1].createdAt);
      avgOrderIntervalMin = Math.round(totalMs / (recentOrders.length - 1) / 60000);
    }
    res.json({ success: true, totalOrders, newOrders, confirmedOrders, shippedOrders, deliveredOrders, cancelledOrders, revenue, chartData, latestOrders, avgOrderIntervalMin });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/settings', requireAdmin, async (req, res) => {
  try { const s = await Setting.findOne(); res.json({ success: true, metaPixel: s?.metaPixel || '', backendUrl: s?.backendUrl || '' }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/meta', requireAdmin, async (req, res) => {
  try {
    const { metaPixel } = req.body;
    let s = await Setting.findOne();
    if (s) { s.metaPixel = metaPixel; await s.save(); } else { s = await Setting.create({ metaPixel }); }
    res.json({ success: true });
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

app.get('/api/testimonials/all', requireAdmin, async (req, res) => {
  try { const testimonials = await Testimonial.find().sort({ createdAt: -1 }); res.json({ success: true, testimonials }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/testimonials', requireAdmin, async (req, res) => {
  try { const t = new Testimonial(req.body); await t.save(); res.json({ success: true, testimonial: t }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.put('/api/testimonials/:id', requireAdmin, async (req, res) => {
  try { const t = await Testimonial.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json({ success: true, testimonial: t }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.delete('/api/testimonials/:id', requireAdmin, async (req, res) => {
  try { await Testimonial.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/seed', async (req, res) => {
  try {
    const count = await Product.countDocuments();
    if (count === 0) {
      await Product.create({
        name: 'Sugar Control Powder', description: 'Vaidyakart Sugar Control Powder — Ayurvedic blend of 12 herbs.',
        price: 599, mrp: 1299, images: [],
        benefits: ['Controls blood sugar naturally','Boosts insulin sensitivity','Reduces sugar cravings','Improves pancreatic health','No side effects — 100% Ayurvedic','Results in 4–6 weeks'],
        ingredients: 'Karela, Jamun, Methi, Giloy, Vijaysar, Neem, Amla, Gurmar, Ashwagandha, Haritaki, Bibhitaki, Amalaki',
        howToUse: 'Mix 1 teaspoon in warm water. Drink on empty stomach every morning.',
        stock: 200, active: true
      });
      res.json({ success: true, message: 'Seeded' });
    } else { res.json({ success: true, message: 'Products already exist' }); }
  } catch(e) { res.json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Vaidyakart server running on port ${PORT}`);

  // ─── KEEP-ALIVE SELF-PING (every 5 min) ──────────────────────────
  // Render free tier sleeps after 15 min of inactivity.
  // This pings every 5 min to stay awake.
  // ALSO: set up a free external cron at https://cron-job.org pointing
  // to https://aushadhlife.onrender.com every 5 minutes — this is your
  // safety net if the server was already asleep when the interval fires.
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || 'https://aushadhlife.onrender.com';
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/`);
      console.log(`✅ Keep-alive ping [${new Date().toISOString()}]`);
    } catch (e) {
      console.warn('⚠️ Keep-alive ping failed:', e.message);
    }
  }, 5 * 60 * 1000);
});
