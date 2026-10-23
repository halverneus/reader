// Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0.
//
// Hand-rolled rather than @modelcontextprotocol/sdk so the server has zero
// dependencies and installing it can never pull packages in behind a running
// render. The surface MCP actually needs is four methods; swapping in the
// official SDK later is a drop-in if that becomes worth it.
import readline from "node:readline";

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, any>; required?: string[] };
  run(args: any): Promise<string> | string;
}

const PROTOCOL = "2024-11-05";

export function serve(name: string, version: string, tools: Tool[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  // stdout is the transport. Anything that writes to it by accident corrupts
  // the stream, so every diagnostic goes to stderr.
  const send = (msg: any) => process.stdout.write(JSON.stringify(msg) + "\n");
  const log = (s: string) => process.stderr.write(`[metrik-mcp] ${s}\n`);

  // A tool call is async (some of them wait on Studio over the bridge). If
  // stdin closes while one is in flight, exiting immediately throws its reply
  // away and the caller sees silence rather than an answer or an error.
  let inFlight = 0;
  let closed = false;
  const settle = () => { if (closed && inFlight === 0) process.exit(0); };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const raw = line.trim();
    if (!raw) return;
    let req: any;
    try { req = JSON.parse(raw); } catch { return; }
    const { id, method, params } = req;
    const reply = (result: any) => { if (id !== undefined) send({ jsonrpc: "2.0", id, result }); };
    const fail = (code: number, message: string) => { if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code, message } }); };

    try {
      switch (method) {
        case "initialize":
          return reply({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name, version } });
        case "notifications/initialized":
        case "notifications/cancelled":
          return;
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case "tools/call": {
          const t = byName.get(params?.name);
          if (!t) return fail(-32602, `unknown tool "${params?.name}"`);
          inFlight++;
          try {
            const text = await t.run(params?.arguments ?? {});
            return reply({ content: [{ type: "text", text: text || "(no output)" }] });
          } catch (e: any) {
            return reply({ content: [{ type: "text", text: `error: ${e?.message ?? String(e)}` }], isError: true });
          } finally {
            inFlight--; settle();
          }
        }
        default:
          return fail(-32601, `unknown method "${method}"`);
      }
    } catch (e: any) {
      log(`handler threw: ${e?.stack ?? e}`);
      fail(-32603, String(e?.message ?? e));
    }
  });

  rl.on("close", () => {
    closed = true;
    settle();
    // never hang on a tool that will not come back
    setTimeout(() => process.exit(0), 10_000).unref();
  });
  log(`${name} ${version} ready (${tools.length} tools)`);
}
