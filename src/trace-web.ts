import { createServer, type Server } from "node:http";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
} from "node:fs";

import type { WorkflowTrace } from "./trace.js";

export interface TraceWebViewerOptions {
  load: () => WorkflowTrace;
  port?: number;
}

export interface TraceWebViewer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent Workflow Trace</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 1100px; margin: 0 auto; padding: 24px; line-height: 1.45; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
    h1, h2 { margin-bottom: .4rem; }
    .muted { opacity: .7; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 10px; }
    .card { border: 1px solid color-mix(in srgb, currentColor 24%, transparent); border-radius: 10px; padding: 12px; }
    code { overflow-wrap: anywhere; }
    ul { padding-left: 22px; }
    details { margin: 8px 0; }
    .failed, .blocked, .cancelled { color: #d55; }
    .completed { color: #2a6; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <header><h1>Workflow Trace</h1><span id="connection" class="muted">loading</span></header>
  <main id="app"></main>
  <script>
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const duration = ms => ms == null ? 'unknown' : Math.floor(ms / 1000) + 's';
    const usage = item => item.status + ': input=' + item.value.input_tokens + ', cached=' + item.value.cached_input_tokens + ', output=' + item.value.output_tokens + ', reasoning=' + item.value.reasoning_output_tokens;
    const fast = item => 'requested=' + item.requested_service_tier + ' (' + (item.requested_fast == null ? 'unknown' : item.requested_fast) + '), effective=' + (item.effective_service_tier ?? 'unknown') + ' (' + (item.effective_fast == null ? 'unknown' : item.effective_fast) + ')';
    const agents = items => '<ul>' + items.map(a => '<li><strong>' + esc(a.role) + '</strong> <code>' + esc(a.id) + '</code> <span class="' + esc(a.status) + '">' + esc(a.status) + '</span><div class="muted">' + esc(a.model) + ' / ' + esc(a.reasoning_effort) + ' / ' + esc(a.profile) + ' · ' + esc(duration(a.duration_ms)) + '</div><div>Fast: ' + esc(fast(a.fast)) + '</div><div>Usage: ' + esc(usage(a.usage)) + '</div><div>Quota equivalent: unknown</div>' + agents(a.children) + '</li>').join('') + '</ul>';
    const render = trace => {
      const w = trace.workflow;
      const artifacts = [...new Map(trace.artifacts.map((a, i) => [a.kind + '\\0' + a.path, {...a, index:i}])).values()];
      document.title = 'Workflow ' + w.id;
      document.getElementById('app').innerHTML =
        '<section class="grid">' +
          '<div class="card"><strong>Status</strong><div class="' + esc(w.status) + '">' + esc(w.status) + '</div></div>' +
          '<div class="card"><strong>Route</strong><div>' + esc(w.execution_route) + (w.retry_route ? ' → ' + esc(w.retry_route) : '') + '</div></div>' +
          '<div class="card"><strong>Duration</strong><div>' + esc(duration(w.duration_ms)) + '</div></div>' +
          '<div class="card"><strong>Usage</strong><div>' + esc(usage(w.usage)) + '</div></div>' +
          '<div class="card"><strong>Fast</strong><div>requested=' + esc(w.fast.requested ?? 'unknown') + ', effective=' + esc(w.fast.effective ?? 'unknown') + '</div></div>' +
          '<div class="card"><strong>Quota equivalent</strong><div>unknown</div></div>' +
        '</section>' +
        '<h2>Workflow</h2><div class="card"><code>' + esc(w.id) + '</code><p>' + esc(w.summary ?? 'No summary yet') + '</p><p class="muted">Started ' + esc(w.started_at) + ' · Completed ' + esc(w.completed_at ?? 'running') + '</p>' + (w.failure_kind ? '<p>Failure: <strong>' + esc(w.failure_kind) + '</strong></p>' : '') + (w.recovery_requires_user_approval ? '<p><strong>Explicit user approval is required before a semantically different recovery.</strong></p>' : '') + '</div>' +
        '<h2>Agents</h2>' + (trace.agents.length ? agents(trace.agents) : '<p>None</p>') +
        '<h2>Timeline</h2><ol>' + trace.timeline.map(e => '<li><code>#' + e.sequence + '</code> ' + esc(e.created_at) + ' <strong>' + esc(e.type) + '</strong>' + (e.run_id ? ' <code>' + esc(e.run_id) + '</code>' : '') + '</li>').join('') + '</ol>' +
        '<h2>Checkpoints</h2><ul>' + trace.checkpoints.map(c => '<li>' + esc(c.kind) + ' <code>' + esc(c.commit_id) + '</code></li>').join('') + '</ul>' +
        '<h2>Recovery decisions</h2><ul>' + trace.recovery_decisions.map(d => '<li>' + esc(d.decision) + ' <code>' + esc(d.decision_id) + '</code>' + (d.note ? ': ' + esc(d.note) : '') + '</li>').join('') + '</ul>' +
        '<h2>Artifacts</h2><ul>' + artifacts.map(a => '<li>' + esc(a.kind) + ': ' + (a.exists && a.regular_file ? '<a href="/artifact?index=' + a.index + '" target="_blank" rel="noreferrer"><code>' + esc(a.path) + '</code></a>' : '<code>' + esc(a.path) + '</code>') + ' <span class="muted">' + (a.exists ? (a.regular_file ? a.size_bytes + ' bytes' : 'not a regular file') : 'missing') + '</span></li>').join('') + '</ul>' +
        '<h2>Evidence</h2><ul>' + trace.evidence.map(e => '<li><strong>' + esc(e.issue) + '</strong>: ' + esc(e.evidence) + '</li>').join('') + '</ul>';
    };
    let revision = null;
    async function refresh() {
      try {
        const response = await fetch('/api/trace', {cache:'no-store'});
        if (!response.ok) throw new Error(await response.text());
        const trace = await response.json();
        if (trace.revision !== revision || trace.workflow.status === 'running') { revision = trace.revision; render(trace); }
        document.getElementById('connection').textContent = 'live · ' + new Date().toLocaleTimeString();
      } catch (error) {
        document.getElementById('connection').textContent = 'error: ' + error;
      }
    }
    refresh(); setInterval(refresh, 1000);
  </script>
</body>
</html>`;

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  };
}

export async function startTraceWebViewer(
  options: TraceWebViewerOptions,
): Promise<TraceWebViewer> {
  const server = createServer((request, response) => {
    const host = request.headers.host ?? "";
    if (!/^127\.0\.0\.1(?::[0-9]+)?$/.test(host)) {
      response.writeHead(421, securityHeaders("text/plain; charset=utf-8"));
      response.end("Invalid Host header\n");
      return;
    }
    const url = new URL(request.url ?? "/", `http://${host}`);
    try {
      if (request.method !== "GET") {
        response.writeHead(405, securityHeaders("text/plain; charset=utf-8"));
        response.end("Method not allowed\n");
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
        response.end(HTML);
        return;
      }
      const trace = options.load();
      if (url.pathname === "/api/trace") {
        response.writeHead(
          200,
          securityHeaders("application/json; charset=utf-8"),
        );
        response.end(`${JSON.stringify(trace)}\n`);
        return;
      }
      if (url.pathname === "/artifact") {
        const index = Number(url.searchParams.get("index"));
        const item = Number.isInteger(index) ? trace.artifacts[index] : undefined;
        if (item === undefined || !item.exists || !item.regular_file) {
          response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
          response.end("Artifact not found\n");
          return;
        }
        let fd: number | null = null;
        try {
          fd = openSync(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const current = fstatSync(fd);
          if (!current.isFile()) {
            closeSync(fd);
            fd = null;
            response.writeHead(
              409,
              securityHeaders("text/plain; charset=utf-8"),
            );
            response.end("Artifact is no longer a regular file\n");
            return;
          }
          response.writeHead(200, {
            ...securityHeaders("text/plain; charset=utf-8"),
            "content-length": String(current.size),
          });
          const stream = createReadStream(item.path, {
            fd,
            autoClose: true,
          });
          fd = null;
          stream.pipe(response);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            response.writeHead(
              409,
              securityHeaders("text/plain; charset=utf-8"),
            );
            response.end("Artifact changed into a symbolic link\n");
            return;
          }
          throw error;
        } finally {
          if (fd !== null) {
            closeSync(fd);
          }
        }
        return;
      }
      response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
      response.end("Not found\n");
    } catch (error) {
      response.writeHead(500, securityHeaders("text/plain; charset=utf-8"));
      response.end(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Trace viewer did not expose a TCP address");
  }
  const url = `http://127.0.0.1:${address.port}/`;
  return {
    server,
    url,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) =>
          error === undefined ? resolvePromise() : rejectPromise(error),
        );
      }),
  };
}
