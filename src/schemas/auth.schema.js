const { z, iraqiPhone, token, shortText } = require('./common');

// POST /auth/send-otp
const sendOtp = z.object({
  phone: iraqiPhone,
});

// POST /auth/verify-otp
const verifyOtp = z.object({
  phone: iraqiPhone,
  // The OTP may arrive as a string or a number; the controller compares String(otp).
  otp: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => v.length >= 1 && v.length <= 12, 'Invalid verification code'),
  full_name: shortText.optional(),
});

// POST /auth/refresh
const refresh = z.object({
  refreshToken: token,
});

// POST /auth/logout — refreshToken is optional (logout still succeeds without it).
const logout = z.object({
  refreshToken: token.optional(),
});

module.exports = { sendOtp, verifyOtp, refresh, logout };
