/* Lumen — Netlify edge function: Anthropic API proxy
   Receives POST /api/analyze from the browser, adds the server-side
   API key, and forwards the request to Anthropic. The key never
   reaches the client.

   Set ANTHROPIC_API_KEY in Netlify → Site settings → Environment variables.
*/

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set on server" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  let payload;

  if (body.action === "analyze" && body.book) {
    // Book heat/tropes/insight analysis (Discovery tab)
    const { title, author, description = "" } = body.book;
    const prompt = [
      "You are an editorial analyst for Lumen, a private reading companion for adult literature.",
      "Analyze the book below and return ONLY a compact JSON object matching this schema:",
      '{ "heat": <integer 1-5>, "tropes": <array of 2-4 short lowercase strings>, "insight": <one calm sentence under 28 words> }.',
      "Rules:",
      "- heat = overall sensual/erotic intensity on a 1 (barely-there) to 5 (unreserved) scale.",
      "- tropes = 2-4 concise narrative tropes (e.g. 'forbidden love', 'slow burn'). No quotes, no full stops.",
      "- insight = one non-judgemental sentence about what kind of reader this suits. Avoid hype. Do not make up facts.",
      "- Output strictly valid JSON, no prose, no backticks.",
      "",
      `Title: ${title}`,
      `Author: ${author || "Unknown"}`,
      `Description: ${String(description).slice(0, 1500)}`
    ].join("\n");

    payload = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }]
    };

  } else if (body.action === "chat" && Array.isArray(body.messages)) {
    // Bianca companion chat
    payload = {
      model: body.model || "claude-sonnet-4-6",
      max_tokens: body.max_tokens || 600,
      messages: body.messages
    };
    if (body.system) payload.system = body.system;

  } else {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Unknown action" }) };
  }

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await upstream.json();
  return {
    statusCode: upstream.status,
    headers: CORS,
    body: JSON.stringify(data)
  };
};
