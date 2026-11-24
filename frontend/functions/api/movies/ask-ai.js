// Proxy dla interaktywnego trybu "Zapytaj AI" (przekazuje zapytanie do FastAPI z ukrytym kluczem X-API-Key).
export async function onRequest(context) {
    const { request, env } = context;

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    try {
        const userId = await getUserIdFromRequest(request);
        if (!userId) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return new Response(JSON.stringify({ error: 'Nieprawidłowy format JSON' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
        if (prompt.length < 2) {
            return new Response(JSON.stringify({ error: 'Wpisz pytanie (min. 2 znaki).' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const fastApiUrl = `https://mvt-api.110187.xyz/movies/user/${userId}/ask-ai`;
        const response = await fetch(fastApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': env.MVT_API_KEY,
            },
            body: JSON.stringify({
                prompt,
                limit: Number.isFinite(Number(body?.limit)) ? Number(body.limit) : 8,
                exclude_watched: body?.exclude_watched !== false,
                include_explanations: body?.include_explanations !== false,
            }),
        });

        const responseText = await response.text();
        let data;
        try {
            data = JSON.parse(responseText);
        } catch {
            data = { error: responseText || `FastAPI error (${response.status})` };
        }

        if (!response.ok) {
            return new Response(JSON.stringify({
                error: data?.detail || data?.error || `Błąd serwera AI (${response.status})`,
            }), {
                status: response.status,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        return new Response(JSON.stringify(data), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('Ask AI proxy error:', error);
        return new Response(JSON.stringify({ error: 'Nie udało się połączyć z silnikiem AI.' }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}

async function getUserIdFromRequest(request) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    try {
        const token = authHeader.substring(7);
        const payload = JSON.parse(atob(token));
        if (payload.exp < Date.now()) {
            return null;
        }
        return payload.userId || null;
    } catch {
        return null;
    }
}
