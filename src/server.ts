// HTTP server: JSON API for the dashboard + Airwallex webhook endpoint. No framework, no build step.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaultExtractor } from './agent/evidence.ts';
import { createDemo, runStep, DEMO_STEPS, type DemoRuntime } from './demo/scenario.ts';
import { runGauntlet } from './gauntlet/run.ts';
import { WebhookReceiver } from './airwallex/webhooks.ts';

const PORT = Number(process.env.PORT ?? 4747);
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const extractor = defaultExtractor();
let runtime: DemoRuntime = createDemo(extractor);
await runtime.treasurer.observe();
let busy = false;
const webhooks = new WebhookReceiver(process.env.AIRWALLEX_WEBHOOK_SECRET ?? randomUUID());

const EvidenceInput = z.object({
  from: z.string().min(3).max(200),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(8000),
});
const ApproveInput = z.object({ bindingHash: z.string().regex(/^[0-9a-f]{64}$/) });

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const parseJson = (raw: string): unknown => (raw ? JSON.parse(raw) : {});

const state = () => ({
  success: true,
  data: {
    ...runtime.treasurer.snapshot(),
    steps: DEMO_STEPS,
    completed: runtime.completed,
    claude: extractor.usesClaude,
  },
});

/** Serialise mutations so two clicks can never interleave two cycles. */
const exclusive = async (res: ServerResponse, fn: () => Promise<unknown>): Promise<void> => {
  if (busy) return send(res, 409, { success: false, error: 'a cycle is already running' });
  busy = true;
  try {
    const result = await fn();
    send(res, 200, { ...state(), result: result ?? null });
  } catch (err: unknown) {
    process.stderr.write(`[shadow-treasurer] ${err instanceof Error ? err.stack : String(err)}\n`);
    send(res, 500, { success: false, error: err instanceof Error ? err.message : 'internal error' });
  } finally {
    busy = false;
  }
};

const serveStatic = async (res: ServerResponse, path: string): Promise<void> => {
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (!/^[a-z0-9_-]+\.(html|js|css|svg)$/i.test(file)) return send(res, 404, { success: false, error: 'not found' });
  try {
    const body = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { success: false, error: 'not found' });
  }
};

const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/api/state') return send(res, 200, state());
  if (method === 'GET' && !path.startsWith('/api') && !path.startsWith('/webhooks')) return serveStatic(res, path);

  if (method === 'POST' && path === '/api/reset') return exclusive(res, async () => { runtime = createDemo(extractor); await runtime.treasurer.observe(); });
  if (method === 'POST' && path === '/api/cycle') return exclusive(res, async () => { await runtime.treasurer.runCycle(); });

  const step = path.match(/^\/api\/step\/([a-z]+)$/);
  if (method === 'POST' && step) {
    if (!DEMO_STEPS.some((s) => s.id === step[1])) return send(res, 404, { success: false, error: 'unknown step' });
    return exclusive(res, async () => { runtime = await runStep(runtime, step[1]); });
  }

  const approval = path.match(/^\/api\/approvals\/([\w-]+)\/(approve|reject)$/);
  if (method === 'POST' && approval) {
    const raw = await readBody(req);
    if (approval[2] === 'reject') return exclusive(res, async () => { runtime.treasurer.reject(approval[1]); });
    const parsed = ApproveInput.safeParse(parseJson(raw));
    if (!parsed.success) return send(res, 400, { success: false, error: 'bindingHash required' });
    return exclusive(res, () => runtime.treasurer.approve(approval[1], parsed.data.bindingHash));
  }

  if (method === 'POST' && path === '/api/evidence') {
    const parsed = EvidenceInput.safeParse(parseJson(await readBody(req)));
    if (!parsed.success) return send(res, 400, { success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    return exclusive(res, async () => {
      await runtime.treasurer.ingestEvidence({ id: `ev-${randomUUID().slice(0, 8)}`, kind: 'email', receivedAt: new Date().toISOString(), ...parsed.data });
      await runtime.treasurer.runCycle();
    });
  }

  if (method === 'POST' && path === '/api/gauntlet') {
    const seed = Number(url.searchParams.get('seed') ?? 7);
    const count = Math.min(200, Math.max(1, Number(url.searchParams.get('count') ?? 50)));
    return send(res, 200, { success: true, data: await runGauntlet({ seed, count }) });
  }

  if (method === 'POST' && path === '/webhooks/airwallex') {
    const raw = await readBody(req);
    const result = webhooks.receive(raw, req.headers['x-timestamp'] as string | undefined, req.headers['x-signature'] as string | undefined);
    if (result.status === 'rejected') return send(res, 401, { success: false, error: result.reason });
    if (result.status === 'accepted') await runtime.treasurer.settleAndReconcile();
    return send(res, 200, { success: true, data: result });
  }

  send(res, 404, { success: false, error: 'not found' });
};

createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    process.stderr.write(`[shadow-treasurer] ${err instanceof Error ? err.stack : String(err)}\n`);
    if (!res.headersSent) send(res, 500, { success: false, error: 'internal error' });
  });
}).listen(PORT, HOST, () => {
  process.stdout.write(`Shadow Treasurer on http://${HOST}:${PORT}  (${runtime.port.mode} Airwallex · evidence via ${extractor.usesClaude ? 'Claude' : 'rules'})\n`);
});
