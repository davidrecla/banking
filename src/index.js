javascript
export default {
  async fetch(request, env, ctx) {
    return new Response('Hello from Cloudflare Workers!', {
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};
