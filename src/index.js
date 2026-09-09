export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // File upload/download via R2
    if (url.pathname === '/file') {
      if (request.method === 'POST') {
        const file = await request.arrayBuffer();
        await env.BANK_BUCKET.put('uploaded-file.bin', file);
        return new Response('Uploaded!');
      }

      const object = await env.BANK_BUCKET.get('uploaded-file.bin');
      if (!object) {
        return new Response('Not found', { status: 404 });
      }

      return new Response(object.body);
    }

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
