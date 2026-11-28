// Endpoint zwracający rzeczywiste gatunki z bazy danych D1 posortowane wg liczby wystąpień

function parseRawGenreTokens(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[,;|]+/)
    .map(s => s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 0 && s.length <= 40);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;
  const withCounts = url.searchParams.get('with_counts') === '1';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (method !== 'GET') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const result = await env.db.prepare(`
      SELECT COALESCE(NULLIF(genre, ''), genres) AS g, COUNT(*) AS cnt
      FROM movies
      WHERE (genre IS NOT NULL AND genre != '') OR (genres IS NOT NULL AND genres != '')
      GROUP BY g
    `).all();

    const genreMap = new Map();

    for (const row of (result?.results || [])) {
      const rowCount = Number(row.cnt) || 0;
      if (rowCount <= 0) continue;

      const tokens = parseRawGenreTokens(row.g);
      const seenInRow = new Set();

      for (const token of tokens) {
        const key = token.toLowerCase();
        if (seenInRow.has(key)) continue;
        seenInRow.add(key);

        let entry = genreMap.get(key);
        if (!entry) {
          entry = { totalCount: 0, casingCounts: new Map() };
          genreMap.set(key, entry);
        }
        entry.totalCount += rowCount;
        entry.casingCounts.set(token, (entry.casingCounts.get(token) || 0) + rowCount);
      }
    }

    const aggregated = Array.from(genreMap.values())
      .map(entry => {
        let bestName = '';
        let bestCasingCount = -1;
        for (const [variant, count] of entry.casingCounts.entries()) {
          if (count > bestCasingCount) {
            bestName = variant;
            bestCasingCount = count;
          }
        }
        return { name: bestName, count: entry.totalCount };
      })
      .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'pl'));

    const payload = withCounts ? aggregated : aggregated.map(g => g.name);

    return new Response(JSON.stringify(payload), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800',
      },
    });
  } catch (error) {
    console.error('genres API error', error);
    return new Response(JSON.stringify({ error: 'Failed to load genres' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

