Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      },
    });
  }
  return new Response("pong", {
    status: 200,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" },
  });
});