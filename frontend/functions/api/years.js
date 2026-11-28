// Endpoint zwracający dostępne lata premier filmów i seriali z bazy D1

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (method !== 'GET') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const result = await env.db.prepare(`
      SELECT DISTINCT CAST(substr(release_date, 1, 4) AS INTEGER) AS year
      FROM movies
      WHERE release_date IS NOT NULL
        AND length(release_date) >= 4
        AND substr(release_date, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
      ORDER BY year DESC
    `).all();

    const maxYear = new Date().getFullYear() + 5;
    const yearsSet = new Set();

    for (const row of (result?.results || [])) {
      const y = Number(row.year);
      if (Number.isInteger(y) && y >= 1870 && y <= maxYear) {
        yearsSet.add(y);
      }
    }

    const years = Array.from(yearsSet).sort((a, b) => b - a);

    return new Response(JSON.stringify(years), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800',
      },
    });
  } catch (error) {
    console.error('years API error', error);
    return new Response(JSON.stringify({ error: 'Failed to load years' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
