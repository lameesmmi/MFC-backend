'use strict';

const express = require('express');
const router  = express.Router();
const User    = require('../models/User');

// All routes in this file already have requireAuth applied in server.js.
// We only need the role check here.
const { requireRole } = require('../middleware/auth');

// GET /api/users
router.get('/', requireRole('admin'), async (_req, res) => {
  try {
    const users = await User.find().sort({ createdAt: 1 }).lean();
    res.json(users.map(u => {
      const obj = { ...u, id: String(u._id) };
      delete obj._id;
      delete obj.__v;
      delete obj.password;
      return obj;
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users
router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const user = await User.create({ name, email, password, role });
    res.status(201).json(User.formatForApi(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id
router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const { name, role, password } = req.body;
    const user = await User.findById(req.params.id).select('+password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Prevent demoting the last admin
    if (role && role !== 'admin' && user.role === 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last admin' });
      }
    }

    if (name)     user.name = name;
    if (role)     user.role = role;
    if (password) user.password = password;

    await user.save();
    res.json(User.formatForApi(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    if (String(req.user._id) === req.params.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
