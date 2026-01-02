
/**
 * Supabase Cloud Relay v3.4
 * Target Project: fiuodbhgvmylvbanbfve
 */

const SUPABASE_URL = "https://fiuodbhgvmylvbanbfve.supabase.co";
const SUPABASE_KEY = "sb_secret_x33xGa8YmioWvfyvDtWNXA_fT_8VL9V_";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-client-info, apikey, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, collection, filter, update } = req.body;
  
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ 
      error: "Supabase Credentials Missing", 
      details: "The relay is missing the project URL or Key." 
    });
  }

  const table = collection || 'provisioning_logs';
  const baseUrl = `${SUPABASE_URL}/rest/v1/${table}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  try {
    let response;
    let result;

    switch (action) {
      case 'ping':
        // Direct probe of the REST gateway
        response = await fetch(`${SUPABASE_URL}/rest/v1/`, { 
          method: 'GET', 
          headers: { 'apikey': SUPABASE_KEY } 
        });
        
        return res.status(200).json({ 
          ok: response.status === 200 || response.status === 204, 
          status: response.status,
          provider: 'Supabase/PostgreSQL',
          project: 'fiuodbhgvmylvbanbfve'
        });

      case 'find':
        let queryUrl = baseUrl + '?select=*';
        if (filter && filter.id) queryUrl += `&id=eq.${filter.id}`;
        
        response = await fetch(queryUrl, { method: 'GET', headers });
        if (!response.ok) {
           const errText = await response.text();
           return res.status(response.status).json({ 
             error: `Table [${table}] Error`, 
             details: errText,
             code: 'TABLE_QUERY_FAILED' 
           });
        }
        
        result = await response.json();
        return res.status(200).json({ documents: Array.isArray(result) ? result : [] });

      case 'updateOne':
        const payload = update?.$set || {};
        if (!payload.id) throw new Error("Supabase Upsert requires an 'id' field.");

        // PostgreSQL Upsert via POST + Resolution Header
        response = await fetch(baseUrl, {
          method: 'POST',
          headers: {
            ...headers,
            'Prefer': 'resolution=merge-duplicates,return=representation'
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errorMsg = await response.text();
          throw new Error(`Upsert Failed: ${errorMsg}`);
        }

        result = await response.json();
        return res.status(200).json({ 
          ok: true, 
          upsertedId: result[0]?.id 
        });

      case 'deleteOne':
        if (!filter || !filter.id) throw new Error("Delete requires an ID.");
        
        response = await fetch(`${baseUrl}?id=eq.${filter.id}`, {
          method: 'DELETE',
          headers: { ...headers, 'Prefer': 'return=minimal' }
        });
        
        return res.status(200).json({ ok: response.ok });

      case 'listCollections':
        const tables = ['agents', 'pages', 'conversations', 'messages', 'links', 'media', 'provisioning_logs'];
        const stats = await Promise.all(tables.map(async (t) => {
          try {
            const check = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=count`, { 
              method: 'GET', 
              headers: { ...headers, 'Prefer': 'count=exact' } 
            });
            return { 
              name: t, 
              exists: check.status === 200 || check.status === 206, 
              count: check.ok ? parseInt(check.headers.get('content-range')?.split('/')[1] || '0') : 0 
            };
          } catch (e) {
            return { name: t, exists: false, count: 0 };
          }
        }));
        return res.status(200).json({ ok: true, collections: stats });

      default:
        return res.status(400).json({ error: 'Invalid operation' });
    }
  } catch (error) {
    return res.status(500).json({ 
      error: error.message,
      code: 'SUPABASE_RELAY_CRITICAL'
    });
  }
}
