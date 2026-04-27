import dashboard from "../public/index.html";
import { createAppContext, retryDueCallbacks } from "./services";
import { corsHeaders, json } from "./http";
import { createApiRoutes } from "./routes";
import { getAdminPath } from "./auth";

export function startServer() {
  const ctx = createAppContext();
  const port = Number(Bun.env.PORT ?? 3000);
  const adminPath = getAdminPath(ctx);
  const server = Bun.serve({
    port,
    development: Bun.env.NODE_ENV !== "production",
    routes: {
      [adminPath]: dashboard as never,
      [`${adminPath}/`]: dashboard as never,
      "/pay/:id": dashboard as never,
      "/pay/:id/": dashboard as never,
      ...createApiRoutes(ctx)
    },
    fetch(req) {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        return json({ error: "接口不存在" }, { status: 404 });
      }

      return new Response("Not Found", { status: 404 });
    }
  });

  const timer = setInterval(() => {
    void retryDueCallbacks(ctx);
  }, 30_000);
  timer.unref?.();

  console.log(`PeerPay server listening on ${server.url}`);
  console.log(`PeerPay admin path: ${new URL(adminPath, server.url).toString()}`);
  return server;
}

if (import.meta.main) {
  startServer();
}
