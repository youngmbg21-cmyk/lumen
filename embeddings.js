/* ============================================================
   Lumen — Embeddings (Voyage AI)
   Exposes window.LumenEmbeddings with:
     getApiKey(), setApiKey(key)
       Reads/writes the Voyage key from localStorage under
       "lumen:voyageKey". Mirrors discovery.js's pattern for the
       Claude key (lumen:claude-key).

     embedText(text) -> Promise<number[]>
       Calls Voyage's /v1/embeddings with the general-purpose
       voyage-3 model and returns the embedding as a plain JS
       number array (chosen over Float32Array so the vectors can
       be written straight into the JSON-serialized Lumen store
       without a conversion layer).

       On failure, throws an object shaped as:
         { code, message }
       where code is one of:
         "no-key"   — no Voyage key set in localStorage.
         "quota"    — 429 or quota-ish response from Voyage.
         "network"  — fetch rejected (offline, CORS, DNS, etc).
         "unknown"  — anything else, including 4xx/5xx without a
                      clearer signal.

     similarity(a, b) -> number
       Pure cosine similarity over two equal-length numeric
       arrays. Returns a number in [-1, 1]. Returns 0 when either
       vector is missing or has zero magnitude, so callers never
       see NaN from dividing by zero.

   No UI is wired in this file. Storage key, network call, and
   the pure math are all it does. The Settings view and any
   library/discovery integration are wired in subsequent batches.
   ============================================================ */
(function () {
  "use strict";

  // Storage + endpoint constants. Kept as locals so changing the
  // model or URL is one line; not exported intentionally.
  const KEY_STORAGE = "lumen:voyageKey";
  const ENDPOINT    = "https://api.voyageai.com/v1/embeddings";
  const MODEL       = "voyage-3";

  // --------------- key management ---------------
  function getApiKey() {
    return localStorage.getItem(KEY_STORAGE) || "";
  }
  function setApiKey(key) {
    if (key && String(key).trim()) {
      localStorage.setItem(KEY_STORAGE, String(key).trim());
    } else {
      localStorage.removeItem(KEY_STORAGE);
    }
  }

  // --------------- embedding call ---------------
  // Returns a plain number array (not Float32Array) so the vector
  // round-trips through JSON.stringify when the Lumen store is
  // persisted to localStorage. Never logs the key.
  async function embedText(text) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw { code: "no-key", message: "No Voyage API key set" };
    }
    const input = String(text == null ? "" : text);

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type":  "application/json"
        },
        body: JSON.stringify({
          input: [input],
          model: MODEL
        })
      });
    } catch (e) {
      throw { code: "network", message: (e && e.message) || "Network error contacting Voyage" };
    }

    if (!res.ok) {
      // 429 (and 402-ish responses from some providers) map to
      // "quota"; everything else is "unknown" with the best
      // message we can surface.
      if (res.status === 429 || res.status === 402) {
        throw { code: "quota", message: `Voyage rate limit or quota (HTTP ${res.status})` };
      }
      let detail = "";
      try {
        const body = await res.json();
        detail = (body && (body.detail || body.error || body.message)) || "";
      } catch (_) { /* body wasn't JSON; fall through */ }
      throw {
        code: "unknown",
        message: `Voyage responded HTTP ${res.status}${detail ? " · " + detail : ""}`
      };
    }

    let payload;
    try {
      payload = await res.json();
    } catch (e) {
      throw { code: "unknown", message: "Voyage response was not JSON" };
    }

    const vec = payload && payload.data && payload.data[0] && payload.data[0].embedding;
    if (!Array.isArray(vec) || !vec.length) {
      throw { code: "unknown", message: "Voyage response missing embedding" };
    }
    return vec;
  }

  // --------------- similarity (pure, no I/O) ---------------
  function similarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    const n = Math.min(a.length, b.length);
    if (!n) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < n; i++) {
      const x = +a[i] || 0;
      const y = +b[i] || 0;
      dot  += x * y;
      magA += x * x;
      magB += y * y;
    }
    if (!magA || !magB) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  window.LumenEmbeddings = {
    getApiKey,
    setApiKey,
    embedText,
    similarity
  };
})();
