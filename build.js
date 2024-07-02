import path from "path";
import fs from "node:fs/promises";

const LIVE_SERVER_PORT = 8181;
const WEB_SOCKET_PORT = 8182;

/* class ElementHandler {
  element(element) {
    console.log(element);
  }
}

let test = await Bun.file("./src/index.html").text();
let resp = new HTMLRewriter()
  .on("*", {
    element(el) {
      if (el.tagName == "c-include") {
        let src = el.getAttribute("src");
        console.log(src);
      }
    },
  })
  .transform(test);

//console.log(resp);
 */

if (Bun.argv[2] && Bun.argv[2] == "watch") {
  await watch();
} else {
  build();
}

function build() {}

async function watch() {
  let live_reload_script = (
    await Bun.file("./.build/livereload.js").text()
  ).replace("!!PORT!!", WEB_SOCKET_PORT);

  async function servePath(route) {
    if (await fs.exists(route)) {
      let route_stat = await fs.stat(route);
      if (route_stat.isDirectory()) {
        return servePath(path.join(route, "index.html"));
      } else if (route_stat.isFile()) {
        let file = Bun.file(route);
        let body = await file.text();
        let type;

        if (route.endsWith(".html")) {
          body += `\n\n<script>${live_reload_script}</script>`;
          type = "text/html";
        } else {
          type = file.type;
        }

        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": type,
          },
        });
      }
    }

    return null;
  }

  /* Live server */
  Bun.serve({
    async fetch(req) {
      let method = req.method.toLowerCase();

      if (method == "get") {
        let route = path.normalize(
          path.join(__dirname, "src", new URL(req.url).pathname)
        );

        let response = await servePath(route);
        if (response) {
          return response;
        }
      }

      return new Response("404", { status: 404 });
    },

    port: LIVE_SERVER_PORT,
  });

  /* Websocket server */
  let server = Bun.serve({
    fetch(req, server) {
      if (server.upgrade(req)) {
        return;
      }

      return new Response("Upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("live_reload");
      },
    },
    port: WEB_SOCKET_PORT,
  });

  const watcher = fs.watch(path.join(__dirname, "src"), { recursive: true });

  for await (const event of watcher) {
    server.publish("live_reload", `reload`);
  }
}
