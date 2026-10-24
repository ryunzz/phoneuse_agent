import { spawn, type ChildProcess } from 'node:child_process';
import { lanAddress } from './config.js';

export const SERVICE_TYPE = '_phonetasks._tcp';

/**
 * Announces the gateway on the LAN with macOS's dns-sd so the iPhone app finds it without a
 * typed address. The TXT record carries the current Wi-Fi IP; it is re-announced when it changes.
 */
export function advertise(port: number): () => void {
  if (process.platform !== 'darwin') return () => {};
  let child: ChildProcess | null = null;
  let announced: string | null = null;

  const announce = () => {
    const ip = lanAddress();
    if (ip === announced) return;
    child?.kill();
    child = null;
    announced = ip;
    if (!ip) return;
    child = spawn('dns-sd', ['-R', 'Phone Use gateway', SERVICE_TYPE, 'local.', String(port), `ip=${ip}`, `port=${port}`, 'v=1'], { stdio: 'ignore' });
    child.on('error', (error) => console.warn(`[bonjour] could not announce: ${error.message}`));
    console.info(`[bonjour] announcing ${SERVICE_TYPE} at http://${ip}:${port}`);
  };

  announce();
  const timer = setInterval(announce, 15_000);
  return () => {
    clearInterval(timer);
    child?.kill();
  };
}
