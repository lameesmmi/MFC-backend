'use strict';

const express    = require('express');
const jwt        = require('jsonwebtoken');
const router     = express.Router();
const User       = require('../models/User');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

// GET /api/auth/setup — check if any users exist
router.get('/setup', async (_req, res) => {
  try {
    const count = await User.countDocuments();
    res.json({ needsSetup: count === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/setup — create first admin (only if no users exist)
router.post('/setup', async (req, res) => {
  try {
    const count = await User.countDocuments();
    if (count > 0) return res.status(409).json({ error: 'Setup already complete' });

    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    const user = await User.create({ name, email, password, role: 'admin' });
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: User.formatForApi(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await user.comparePassword(password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: User.formatForApi(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = { ...req.user, id: String(req.user._id) };
  delete user._id;
  res.json(user);
});

// PUT /api/auth/me — update own name or change password
router.put('/me', requireAuth, async (req, res) => {
  try {
    const { name, currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');

    if (name) user.name = name;

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'currentPassword is required to set a new password' });
      }
      const match = await user.comparePassword(currentPassword);
      if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
      user.password = newPassword;
    }

    await user.save();
    res.json(User.formatForApi(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
