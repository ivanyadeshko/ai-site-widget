import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export type FakeCall = { method: string; url: string; headers: Record<string, string>; body: unknown };
export type FakeReply = { status: number; body: unknown; delayMs?: number };

export class FakeCore {
  readonly calls: FakeCall[] = [];
  private readonly queue: FakeReply[] = [];
  private server!: Server;
  private port = 0;

  enqueue(reply: FakeReply): this { this.queue.push(reply); return this; }

  /**
   * Сброс НЕДОРАЗОБРАННЫХ ответов между тестами: `core` в файле — один
   * долгоживущий инстанс на весь suite (реальный HTTP-сервер, поднимать заново
   * на каждый тест дорого), и `enqueue`, не съеденный своим тестом (например,
   * под мутацией, которая нарочно делает МЕНЬШЕ запросов, чем ожидалось),
   * иначе тихо просачивается в следующий тест и путает его результат.
   */
  resetQueue(): void { this.queue.length = 0; }

  get baseUrl(): string { return `http://127.0.0.1:${this.port}/api`; }

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        this.calls.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
          body: raw ? JSON.parse(raw) : null,
        });
        const reply = this.queue.shift() ?? { status: 500, body: { error: { code: 'fake_unset', message: 'очередь фейка пуста' } } };
        const send = (): void => {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(reply.status === 204 ? '' : JSON.stringify(reply.body));
        };
        if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
      });
    });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> { this.server.close(); await once(this.server, 'close'); }
}
