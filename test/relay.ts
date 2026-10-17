import { type ChildProcess, spawn } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;

// Node's WebSocket (undici) takes request headers in its second argument, which the DOM type only knows as protocols.
export const socketFrom = (url: string, origin: string) => new WebSocket(url, { headers: { origin } } as unknown as string[]);

export function relay(httpPort: number, udpPort: number, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(httpPort), NET_PORT: String(udpPort), ...env },
  });
  return new Promise<ChildProcess>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
      if ((!udpPort || output.includes(`UDP ${udpPort} :`)) && output.includes(`:${httpPort}/`)) resolve(child);
    });
    child.on('exit', code => reject(new Error(`relay ${httpPort} stopped (${code})`)));
  });
}
