import { createHash } from 'node:crypto';
import { fetchJson } from './http.js';
import { safeHistory, packState } from './session.js';

export const MEMORY_READ_TIMEOUT_MS = 450;
export const MEMORY_WRITE_TIMEOUT_MS = 350;

export function memoryConfig() {
  const mode = String(process.env.MEMORY_BACKEND || 'session').trim();
  if (mode === 'session') return null;
  if (mode !== 'supabase') throw new Error('MEMORY_CONFIG');
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !key) throw new Error('MEMORY_CONFIG');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_secret_')) {
    // Legacy service-role keys are JWTs. New secret keys are not bearer tokens.
    try {
      const parts = key.split('.');
      if (parts.length !== 3 || JSON.parse(Buffer.from(parts[1], 'base64url')).role !== 'service_role') throw new Error();
    } catch {
      throw new Error('MEMORY_CONFIG');
    }
    headers.Authorization = 'Bearer ' + key;
  }
  return { url, headers };
}

export function conversationId(session) {
  const skill = session?.skill_id;
  const user = session?.user?.user_id;
  const app = session?.application?.application_id;
  const present = value => typeof value === 'string' && value.trim().length > 0;
  if (!present(skill)) return null;
  const kind = present(user) ? 'user' : 'application';
  const identity = kind === 'user' ? user : app;
  if (!present(identity)) return null;
  return createHash('sha256').update(JSON.stringify(['v1', skill, kind, identity])).digest('hex');
}

function endpoint(config, id) {
  const url = new URL(config.url + '/rest/v1/alice_memory');
  url.searchParams.set('conversation_id', 'eq.' + id);
  return url;
}

function searchState(search) {
  return packState([], search).search || {};
}

function validRecord(row) {
  return row && Array.isArray(row.history) && row.history.length <= 8 && row.history.length % 2 === 0
    && row.history.every((item, i) => item?.role === (i % 2 === 0 ? 'user' : 'model') && typeof item.text === 'string')
    && row.search && typeof row.search === 'object' && !Array.isArray(row.search)
    && (row.search.query === undefined || typeof row.search.query === 'string')
    && Number.isSafeInteger(row.revision) && row.revision >= 0 && row.revision < Number.MAX_SAFE_INTEGER;
}

export async function loadMemory(config, id, timeoutMs) {
  const url = endpoint(config, id);
  url.searchParams.set('select', 'history,search,revision');
  url.searchParams.set('limit', '1');
  const { response, data } = await fetchJson(url, {
    method: 'GET', headers: config.headers, redirect: 'error'
  }, Math.min(MEMORY_READ_TIMEOUT_MS, timeoutMs));
  if (!response.ok) throw new Error('MEMORY_READ_FAILED');
  if (!Array.isArray(data) || data.length > 1 || (data.length === 1 && !validRecord(data[0]))) {
    throw new Error('MEMORY_INVALID_DATA');
  }
  if (!data.length) return { history: [], search: {}, revision: null };
  return { history: safeHistory(data[0].history), search: searchState(data[0].search), revision: data[0].revision };
}

export async function saveMemory(config, id, previous, history, search, timeoutMs) {
  const insert = previous.revision === null;
  const revision = insert ? 1 : previous.revision + 1;
  const url = endpoint(config, id);
  url.searchParams.set('select', 'revision');
  if (!insert) url.searchParams.set('revision', 'eq.' + previous.revision);
  const row = {
    history: safeHistory(history), search: searchState(search),
    revision, updated_at: new Date().toISOString()
  };
  if (insert) row.conversation_id = id;
  const { response, data } = await fetchJson(url, {
    method: insert ? 'POST' : 'PATCH',
    headers: { ...config.headers, Prefer: 'return=representation' },
    body: JSON.stringify(row), redirect: 'error'
  }, Math.min(MEMORY_WRITE_TIMEOUT_MS, timeoutMs));
  // Compare-and-swap: no retries from stale history, including after a clear.
  if (response.status === 409 || (response.ok && Array.isArray(data) && !data.length)) throw new Error('MEMORY_CONFLICT');
  if (!response.ok || !Array.isArray(data) || data.length !== 1 || data[0]?.revision !== revision) throw new Error('MEMORY_WRITE_FAILED');
  return row;
}

export function logMemoryError(error, phase) {
  const known = /^(?:MEMORY_CONFIG|MEMORY_READ_FAILED|MEMORY_INVALID_DATA|MEMORY_CONFLICT|MEMORY_WRITE_FAILED)$/;
  console.warn(known.test(error?.message) ? error.message
    : error?.message === 'REQUEST_TIMEOUT' ? 'MEMORY_' + phase + '_TIMEOUT' : 'MEMORY_' + phase + '_FAILED');
}
