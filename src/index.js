export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    const value = url.searchParams.get('value');

    // Store a value
    if (key && value) {
      await env.BANK_KV.put(key, value);
      return new Response(`Stored: ${key} = ${value}`);
    }

    // Retrieve a value
    if (key) {
      const stored = await env.BANK_KV.get(key);
      return new Response(`Value: ${stored || 'not found'}`);
    }

    return new Response('Usage: ?key=name&value=data or ?key=name');
  }
};
