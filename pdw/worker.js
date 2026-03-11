// Cloudflare Worker: Anthropic API Proxy for tatsumosoft.com demos
// Deploy: cd pdw && npx wrangler deploy

export default {
  async fetch(request, env) {
    // Check which origin is making the request
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "https://tatsumosoft.com").split(",").map(s => s.trim());
    const matchedOrigin = allowed.includes(origin) ? origin : allowed[0];

    // CORS headers - return ONLY the matched origin, not the whole list
    const corsHeaders = {
      "Access-Control-Allow-Origin": matchedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    // Handle preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check origin is allowed
    if (!allowed.includes(origin) && !allowed.includes("*")) {
      return new Response(JSON.stringify({ error: "Origin not allowed" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rate limiting via KV (optional, skip if no KV bound)
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.RATE_LIMIT_KV) {
      const key = `rate:${clientIP}`;
      const current = parseInt(await env.RATE_LIMIT_KV.get(key) || "0", 10);
      if (current >= 20) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 3600 });
    }

    try {
      const body = await request.json();

      // Enforce model (don't let client pick expensive models)
      body.model = "claude-sonnet-4-20250514";

      // Enforce max_tokens cap
      if (!body.max_tokens || body.max_tokens > 2500) {
        body.max_tokens = 2000;
      }

      // Strip any tools (no web search from public proxy)
      delete body.tools;
      delete body.tool_choice;

      const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      const data = await anthropicResponse.json();

      return new Response(JSON.stringify(data), {
        status: anthropicResponse.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Proxy error: " + err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};