// Emergency admin lockdown — the state behind the Telegram bot's buttons.
//
// WHY min_iat AND NOT "DELETE FROM admin_sessions":
// authenticate() in middleware/auth.js verifies the admin's JWT and checks the `users` row.
// It never reads admin_sessions. Deleting from that table therefore logs NOBODY out — the
// token keeps working for its full 8-hour life, which is exactly the window an attacker is
// already inside. users.min_iat is the mechanism that actually voids outstanding tokens
// (auth.js rejects any token whose iat predates it), so that is what lockdown sets.
//
// Deleting the rows would also fail outright today: admin_audit_log.session_id references
// admin_sessions(id) with no ON DELETE, and every admin login writes an audit row. We mark
// sessions inactive instead — the log must outlive the sessions it describes.
const { supabaseAdmin } = require('../utils/supabase');
const logger = require('../utils/logger');

const SETTING_LOCKED = 'admin_login_locked';

const isOn = (v) => ['true', 't', '1', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

// Fails OPEN. A database hiccup must not lock the owner out of their own panel: the lock is
// a deliberate emergency action, never an accident. (alert.service makes the mirror-image
// choice for the mirror-image reason — it fails toward noise, never toward silence.)
const isAdminLoginLocked = async () => {
  try {
    const { data, error } = await supabaseAdmin
      .from('platform_settings')
      .select('value')
      .eq('key', SETTING_LOCKED)
      .maybeSingle();

    if (error) throw error;
    return isOn(data?.value);
  } catch (err) {
    logger.error('Could not read admin_login_locked — treating the system as UNLOCKED', {
      error: err.message,
    });
    return false;
  }
};

const setLocked = async (locked) => {
  const { error } = await supabaseAdmin
    .from('platform_settings')
    .upsert(
      {
        key: SETTING_LOCKED,
        value: locked ? 'true' : 'false',
        description: 'Emergency lock on admin login. Toggled from the Telegram bot.',
      },
      { onConflict: 'key' }
    );
  if (error) throw error;
};

// Base columns only. auth_method belongs to the Layer 3 migration, which is not applied —
// naming it here would make every lockdown fail on a column that does not exist yet.
const audit = async (action, ip, afterData) => {
  const { error } = await supabaseAdmin.from('admin_audit_log').insert({
    admin_id:    null, // performed from Telegram, not from an authenticated admin session
    action,
    target_type: 'system',
    target_id:   null,
    ip_address:  ip || null,
    after_data:  afterData || null,
  });
  if (error) throw error;
};

const lockdown = async ({ ip = null, actor = 'telegram' } = {}) => {
  await setLocked(true);

  const lockedAt = new Date().toISOString();

  // This is the line that actually ends the sessions.
  const { data: admins, error: adminErr } = await supabaseAdmin
    .from('users')
    .update({ min_iat: lockedAt })
    .eq('role', 'admin')
    .select('id');
  if (adminErr) throw adminErr;

  // Bookkeeping: nothing reads is_active for auth, but it keeps the session record honest
  // for whoever reads the table after the incident.
  const { error: sessErr } = await supabaseAdmin
    .from('admin_sessions')
    .update({ is_active: false })
    .eq('is_active', true);
  if (sessErr) throw sessErr;

  const invalidated = admins?.length ?? 0;
  await audit('admin_lockdown', ip, { actor, admins_invalidated: invalidated, locked_at: lockedAt });

  logger.warn(`ADMIN LOCKDOWN engaged by ${actor} — ${invalidated} admin token(s) invalidated`);
  return { adminsInvalidated: invalidated };
};

// No confirmation step: unlocking only restores the normal password + 2FA door, so the worst
// case is that an attacker who already controls the Telegram account undoes a lockdown they
// could equally have prevented. min_iat is deliberately NOT rolled back — admins simply sign
// in again and receive fresh tokens.
const unlock = async ({ ip = null, actor = 'telegram' } = {}) => {
  await setLocked(false);
  await audit('admin_unlock', ip, { actor, unlocked_at: new Date().toISOString() });
  logger.warn(`ADMIN LOCKDOWN lifted by ${actor}`);
};

module.exports = { isAdminLoginLocked, lockdown, unlock, SETTING_LOCKED };
