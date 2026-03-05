const { createClient } = require("@supabase/supabase-js");

function isSupabaseIngestEnabled() {
  return String(process.env.SUPABASE_INGEST_ENABLED || "").toLowerCase() === "true";
}

let _supabaseAdmin = null;

function getSupabaseAdmin() {
  if (_supabaseAdmin) return _supabaseAdmin;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase admin client missing env. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on backend only."
    );
  }

  _supabaseAdmin = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return _supabaseAdmin;
}

module.exports = {
  isSupabaseIngestEnabled,
  getSupabaseAdmin,
};
