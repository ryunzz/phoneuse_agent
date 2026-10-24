import { spawn, type ChildProcess } from 'node:child_process';
import { lanAddresses } from './config.js';

export const SERVICE_TYPE = '_phonetasks._tcp';

/**
 * Announces the gateway with macOS's dns-sd so the iPhone app finds it without a typed address,
 * over Wi-Fi or over the USB cable when the phone's Personal Hotspot is on. The TXT record lists
 * every address the Mac has (the app tries each); it is re-announced when they change.
 */
export function advertise(port: number): () => void {
  if (process.platform !== 'darwin') return () => {};
  let child: ChildProcess | null = null;
  let announced: string | null = null;

  const announce = () => {
    const ips = lanAddresses().join(',');
    if (ips === announced) return;
    child?.kill();
    child = null;
    announced = ips;
    if (!ips) return;
    child = spawn('dns-sd', ['-R', 'Phone Use gateway', SERVICE_TYPE, 'local.', String(port), `ips=${ips}`, `port=${port}`, 'v=2'], { stdio: 'ignore' });
    child.on('error', (error) => console.warn(`[bonjour] could not announce: ${error.message}`));
    console.info(`[bonjour] announcing ${SERVICE_TYPE} on ${ips} port ${port}`);
  };

  announce();
  const timer = setInterval(announce, 15_000);
  return () => {
    clearInterval(timer);
    child?.kill();
  };
}
