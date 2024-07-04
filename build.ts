import path from "node:path";
import fs from "node:fs/promises";
import { watch as fs_watch } from "node:fs";

const LIVE_SERVER_PORT = 8181;
const WEB_SOCKET_PORT = 8182;

const OUT_DIR = path.join(__dirname, "dist");
const SRC_DIR = path.join(__dirname, "src");
const POSTS_DIR = path.join(__dirname, "posts");

const POST_TEMPLATE = path.join(SRC_DIR, "posts", "_post.html");
const POST_OUTPUT = path.join(OUT_DIR, "posts");

const POST_INDEX = path.join(SRC_DIR, "posts", "_index.html");
const POST_INDEX_OUTPUT = path.join(OUT_DIR, "posts", "index.html");

interface IPost {
  title: string;
  body: string;
  slug: string;
}

class PostParser {
  relative_path: string;

  constructor(relative_path: string) {
    this.relative_path = relative_path;
  }

  async parse(): Promise<IPost> {
    let file_contents = await Bun.file(
      path.join(POSTS_DIR, this.relative_path)
    ).text();

    let title = "Untitled";
    let slug = path.parse(this.relative_path).name;

    let body = await new HTMLRewriter()
      .on("c-post", {
        element(element) {
          title = element.getAttribute("title") || title;
          slug = element.getAttribute("slug") || slug;

          element.removeAndKeepContent();
        },
      })
      .transform(new Response(file_contents))
      .text();

    return { title, body, slug };
  }
}

class PostGenerator {
  template_contents: string;

  async init() {
    this.template_contents = await Bun.file(POST_TEMPLATE).text();
  }

  async generate_post(post: IPost) {
    let file_contents = await new HTMLRewriter()
      .on("[slot]", {
        element(element) {
          let slot_for = element.getAttribute("slot");

          if (slot_for == "title") {
            element.setInnerContent(post.title);
          } else if (slot_for == "body") {
            element.setInnerContent(post.body, { html: true });
          }

          element.removeAttribute("slot");
        },
      })
      .transform(new Response(this.template_contents))
      .text();

    let output_path = path.join(POST_OUTPUT, `${post.slug}.html`);

    await Bun.write(output_path, file_contents);
  }
}

let CPostIndex = {
  element(element: HTMLRewriterTypes.Element) {
    let innner_content = posts
      .map((post) => `<li><a href="/posts/${post.slug}">${post.title}</a></li>`)
      .join("\n");

    element.setInnerContent(innner_content, { html: true });
    element.removeAttribute("slot");
  },
};

async function generate_posts_array() {
  let posts_paths = await fs.readdir(POSTS_DIR);
  let posts: IPost[] = [];

  for (const relative_path of posts_paths) {
    let post = await new PostParser(relative_path).parse();
    posts.push(post);
  }

  return posts;
}

let posts = await generate_posts_array();

namespace Build {
  async function process_route(relative_path: string) {
    let absolute_path = path.join(SRC_DIR, relative_path);
    let stat = await fs.stat(absolute_path);

    if (stat.isDirectory()) {
      let dir = await fs.readdir(absolute_path);
      dir.forEach((item) => process_route(path.join(relative_path, item)));

      return;
    }

    let file_path = path.parse(relative_path);
    if (file_path.name[0] == "_") return;

    if (file_path.ext !== ".html") {
      Bun.write(
        path.join(OUT_DIR, relative_path),
        Bun.file(path.join(SRC_DIR, relative_path))
      );

      return;
    }

    build_html(relative_path);
  }

  export async function build_html(relative_path: string) {
    let file_contents = await Bun.file(
      path.join(SRC_DIR, relative_path)
    ).text();

    let output_contents = await new HTMLRewriter()
      .on(`[slot="post-index"]`, CPostIndex)
      .transform(new Response(file_contents))
      .text();

    Bun.write(path.join(OUT_DIR, relative_path), output_contents);
  }

  export async function generate_posts() {
    let post_generator = new PostGenerator();
    await post_generator.init();

    posts.forEach((post) => post_generator.generate_post(post));
  }

  export async function build() {
    await fs.rm(OUT_DIR, { recursive: true, force: true });

    await process_route(".");
    await generate_posts();
  }
}

namespace Watch {
  async function serve_path(route: string): Promise<Response> {
    if (!(await fs.exists(route))) {
      if (await fs.exists(`${route}.html`)) {
        return serve_path(`${route}.html`);
      }

      return new Response(Bun.file(path.join(OUT_DIR, "404.html")), {
        status: 404,
        headers: {
          "Content-Type": "text/html",
        },
      });
    }

    if ((await fs.stat(route)).isDirectory()) {
      return serve_path(path.join(route, "index.html"));
    }

    let file = Bun.file(route);
    let body = await file.text();
    let type;

    if (route.endsWith(".html")) {
      body += `\n\n<script>new WebSocket("ws://localhost:${WEB_SOCKET_PORT}").addEventListener("message", (_) => location.reload());</script>`;
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

  function start_file_server() {
    Bun.serve({
      async fetch(req) {
        let path_name = new URL(req.url).pathname;
        let route = path.join(OUT_DIR, path_name);

        return await serve_path(route);
      },

      port: LIVE_SERVER_PORT,
    });
  }

  async function start_live_reload() {
    let server = Bun.serve({
      fetch(req, server) {
        if (!server.upgrade(req)) {
          return new Response("Upgrade failed", { status: 500 });
        }
      },
      websocket: {
        message() {},
        open: (ws) => ws.subscribe("live_reload"),
      },
      port: WEB_SOCKET_PORT,
    });

    fs_watch(SRC_DIR, { recursive: true }, async (_, filename) => {
      let file_name = path.parse(filename!).name;
      if (file_name == "_post") {
        await Build.generate_posts();
      }

      server.publish("live_reload", `reload`);
    });

    fs_watch(POSTS_DIR, async (_, filename) => {
      posts = await generate_posts_array();
      await Build.generate_posts();

      await Build.build_html(path.join("posts", "index.html"));

      server.publish("live_reload", `reload`);
    });
  }

  export async function watch() {
    await Build.build();

    start_file_server();
    await start_live_reload();
  }
}

(async () => {
  let arg = Bun.argv[2];

  if (arg == "watch") {
    await Watch.watch();
  } else {
    await Build.build();
  }
})();
