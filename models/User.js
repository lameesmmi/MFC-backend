'use strict';

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const AVATAR_COLORS = [
  '#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c',
  '#3498db','#9b59b6','#e91e63','#00bcd4','#8bc34a',
];

const userSchema = new mongoose.Schema(
  {
    name:  { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    role:  { type: String, enum: ['admin', 'operator', 'viewer'], default: 'viewer' },
    color: { type: String, default: () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] },
  },
  { timestamps: true },
);

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.statics.formatForApi = function (doc) {
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj.password;
  delete obj.__v;
  obj.id = String(obj._id);
  delete obj._id;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
