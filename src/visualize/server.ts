import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { buildGraph, type WikiGraph } from "./graph.js";
import { CSP, EMBEDDED_CSP, EMBEDDED_PAGE, PAGE } from "./page.js";
import { loadVisualizerAssets, type VisualizerAssets } from "./static-export.js";

const HOST = "127.0.0.1"; // loopback only (never expose the wiki on the network)
const PORT_ATTEMPTS = 20; // ports to try before giving up when the preferred one is busy
const WATCH_DEBOUNCE_MS = 150; // collapse a burst of file-change events into one rebuild

/**
 * Inputs for a single visualizer server run. Every field is required: the CLI parser
 * fills the defaults, so the server itself never has to guess.
 */
export interface VisualizeServerOptions {
  /**
   * Resolved absolute path to the wiki directory to serve.
   */
  wikiRoot: string;

  /**
   * Preferred TCP port; the server increments from here when it is already in use.
   */
  port: number;

  /**
   * Whether to open the default browser once the server is listening.
   */
  open: boolean;

  /** Precompiled assets supplied by an embedding application. */
  assets?: VisualizerAssets;
}

/** Start the visualizer without taking ownership of the host process. */
export async function startEmbeddedVisualizeServer(
  options: VisualizeServerOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  const { wikiRoot } = options;
  await assertWikiDir(wikiRoot);
  const assets = options.assets ?? await loadVisualizerAssets();
  let graph = await buildGraph(wikiRoot);
  const sseClients = new Set<ServerResponse>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let rebuilding = Promise.resolve();

  const rebuild = (): void => {
    rebuilding = rebuilding.then(async () => {
      if (closed) return;
      try {
        const next = await buildGraph(wikiRoot);
        if (closed) return;
        graph = next;
        for (const client of sseClients) client.write("event: reload\ndata: 1\n\n");
      } catch (error) {
        process.stderr.write(`OpenWiki visualizer refresh failed: ${String(error)}\n`);
      }
    });
  };

  const watcher = watch(wikiRoot, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, WATCH_DEBOUNCE_MS);
  });
  watcher.on("error", (error) => {
    process.stderr.write(`OpenWiki visualizer watcher failed: ${String(error)}\n`);
  });
  const server = createServer(createRequestHandler({
    getGraph: () => graph,
    ...assets,
    sseClients,
  }));
  let boundPort: number;
  try {
    boundPort = await listen(server, options.port, PORT_ATTEMPTS);
  } catch (error) {
    watcher.close();
    clearTimeout(timer);
    throw error;
  }
  server.on("error", (error) => {
    process.stderr.write(`OpenWiki visualizer server failed: ${String(error)}\n`);
  });
  const url = `http://${HOST}:${boundPort}`;
  if (options.open) openBrowser(url);
  let closing: Promise<void> | undefined;
  return {
    url,
    close: () => {
      if (closing) return closing;
      closed = true;
      watcher.close();
      clearTimeout(timer);
      for (const client of sseClients) client.end();
      sseClients.clear();
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      }).then(async () => { await rebuilding; });
      return closing;
    },
  };
}

/** Standalone CLI entry: wait for SIGINT, then close only this server. */
export async function runVisualizeServer(options: VisualizeServerOptions): Promise<void> {
  const server = await startEmbeddedVisualizeServer(options);
  printBanner(options.wikiRoot, server.url);
  await new Promise<void>((resolve, reject) => {
    process.once("SIGINT", () => {
      server.close().then(resolve, reject);
    });
  });
}

/**
 * Dependencies for the visualizer HTTP request handler. The handler is a pure
 * router over a fixed set of routes; everything it needs is passed in so it can
 * be exercised without booting a real server.
 */
export interface RequestHandlerDeps {
  /**
   * Read the current wiki graph. A getter (not the graph itself) because the
   * server reassigns the graph on every rebuild, and each request must serve the
   * latest one.
   */
  getGraph: () => WikiGraph;

  /**
   * Compiled browser client module, served verbatim at `/client.js`.
   */
  clientJs: string;

  /**
   * Compiled browser client library module, served verbatim at `/client-lib.js`.
   */
  clientLibJs: string;

  /**
   * Visualizer stylesheet, served verbatim at `/styles.css`.
   */
  stylesCss: string;

  /** Additional browser libraries at fixed same-origin paths. */
  browserAssets?: Record<string, string>;

  /**
   * Live set of open Server-Sent-Events responses; the handler registers new
   * `/events` subscribers here and drops them when the connection closes.
   */
  sseClients: Set<ServerResponse>;
}

/**
 * Build the visualizer HTTP request handler. Routing is locked to a fixed set of
 * routes (`/`, `/index.html`, `/client.js`, `/client-lib.js`, `/styles.css`,
 * `/api/graph`, `/events`); no filesystem path is ever derived from `req.url`, and
 * `/` carries the strict Content-Security-Policy. Any other path is a 404.
 */
export function createRequestHandler(
  deps: RequestHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { getGraph, clientJs, clientLibJs, stylesCss, browserAssets, sseClients } = deps;

  return (req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? "/").split("?", 1)[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": browserAssets ? EMBEDDED_CSP : CSP,
      });
      res.end(browserAssets ? EMBEDDED_PAGE : PAGE);
      return;
    }
    if (url === "/client.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(clientJs);
      return;
    }
    if (url === "/client-lib.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(clientLibJs);
      return;
    }
    if (url === "/styles.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(stylesCss);
      return;
    }
    const libraryName = url.slice(1);
    if (["force-graph.js", "marked.js", "purify.js", "mermaid.js"].includes(libraryName)
        && browserAssets?.[libraryName] !== undefined) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(browserAssets[libraryName]);
      return;
    }
    if (url === "/api/graph") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(getGraph()));
      return;
    }
    if (url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      sseClients.add(res);
      res.on("close", () => sseClients.delete(res));
      return;
    }
    // Only these fixed routes exist; no filesystem path is ever derived from req.url.
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  };
}

/* v8 ignore start */
/**
 * Fail early with a friendly message when the wiki directory is missing.
 */
async function assertWikiDir(wikiRoot: string): Promise<void> {
  try {
    const info = await stat(wikiRoot);
    if (!info.isDirectory()) {
      throw new Error(`Not a directory: ${wikiRoot}`);
    }
  } catch {
    throw new Error(
      `Wiki directory not found: ${wikiRoot}. Run \`openwiki --init\` first, or pass a path.`,
    );
  }
}

/**
 * Try the preferred port, incrementing on EADDRINUSE.
 */
async function listen(server: Server, port: number, attemptsLeft: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE" && attemptsLeft > 0 && port < 65535) {
        void listen(server, port + 1, attemptsLeft - 1).then(resolve, reject);
      } else {
        reject(error);
      }
    };
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Visualizer did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * Open the default browser without a shell (URL is never interpolated).
 */
function openBrowser(url: string): void {
  const opener: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(opener[0], opener[1], () => {});
}

/**
 * Print the startup banner: where the wiki lives, the URL, and how to stop.
 */
function printBanner(wikiRoot: string, url: string): void {
  process.stdout.write(`\n  OpenWiki visualizer\n`);
  process.stdout.write(`  wiki:  ${wikiRoot}\n`);
  process.stdout.write(`  open:  \x1b[36m${url}\x1b[0m\n`);
  process.stdout.write(
    `  live:  editing pages under the wiki refreshes the browser\n\n`,
  );
  process.stdout.write(`  Ctrl-C to stop.\n\n`);
}
/* v8 ignore stop */
