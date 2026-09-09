export default {
  async fetch(request, env, ctx) {
    return new Response('Hello world! this is my first worker deployed in Github 2!', {
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}; 
