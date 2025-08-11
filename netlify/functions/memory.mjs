// netlify/functions/memory.mjs
import { getStore } from '@netlify/blobs';

const store = getStore('operabot-memory');

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
};

const json = (statusCode, body) => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(body),
});

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  try {
    const key = 'global';

    if (event.httpMethod === 'GET') {
      const list = (await store.get(key, { type: 'json' })) || [];
      return json(200, { ok: true, items: list });
    }

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok:false, error: 'JSON inválido' }); }
      let text = String(body.text || '').trim();

      if (!text) return json(400, { ok:false, error: "Falta 'text'" });
      // saneo y límites
      if (text.length > 500) text = text.slice(0, 500);

      const list = (await store.get(key, { type: 'json' })) || [];
      const exists = list.some(item => (item.text || '').toLowerCase() === text.toLowerCase());
      if (!exists) {
        list.push({
          id: 'mem_' + Math.random().toString(36).slice(2),
          text,
          ts: Date.now(),
        });
        // límite de 200 items para no crecer infinito
        while (list.length > 200) list.shift();
        await store.set(key, JSON.stringify(list));
      }
      return json(200, { ok: true, saved: text });
    }

    if (event.httpMethod === 'DELETE') {
      // si mandás ?id=... borra uno; sin id borra todo
      const id = new URL(event.rawUrl).searchParams.get('id');
      if (!id) {
        await store.set(key, JSON.stringify([]));
        return json(200, { ok: true, cleared: true });
      } else {
        const list = (await store.get(key, { type: 'json' })) || [];
        const next = list.filter(x => x.id !== id);
        await store.set(key, JSON.stringify(next));
        return json(200, { ok: true, removed: id, count: next.length });
      }
    }

    return json(405, { ok:false, error: 'Use GET/POST/DELETE' });
  } catch (err) {
    return json(500, { ok:false, error: err?.message || String(err) });
  }
}
