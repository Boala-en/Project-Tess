import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | undefined

export function getPrivateIdentityStorage(): { client: SupabaseClient; bucket: string } {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const bucket = process.env.SUPABASE_IDENTITY_BUCKET
  if (!url || !serviceKey || !bucket) throw new Error('Private identity storage is not configured.')
  client ??= createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  return { client, bucket }
}