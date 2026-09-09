export default {
  async fetch(request, env, ctx) {
    const data = {
      message: 'Hello from Cloudflare Workers Branch-22!',
      message: 'Hello from Cloudflare Workers Main!!',
      timestamp: new Date().toISOString(),
      path: new URL(request.url).pathname
    };
    return new Response(JSON.stringify(data, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};