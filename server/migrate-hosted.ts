import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the hosted Supabase Postgres connection string.')

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
try {
  const migration = await readFile(fileURLToPath(new URL('./migrations/002_postgres.sql', import.meta.url)), 'utf8')
  await pool.query(migration)
  console.log('Hosted Tess schema applied successfully.')
} finally {
  await pool.end()
}