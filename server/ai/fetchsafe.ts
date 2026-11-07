import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

/** True for loopback, link-local (cloud metadata), and private ranges, in v4 and v6 forms. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const addr = mapped ?? ip.toLowerCase();
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return addr === '::1' || addr === '::' || /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr);
}

async function assertPublic(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https links can be checked');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) throw new Error('Link points at a private network address');
}

/** Fetches a worker-supplied URL without letting it reach this server's internal network. */
export async function safeFetch(raw: string): Promise<{ status: number; body: string; finalUrl: string }> {
  let url = new URL(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'PactVerifier/1.0', Accept: 'text/html,text/plain,*/*' },
    });
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) { url = new URL(next, url); continue; }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader && size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader?.cancel().catch(() => {});
    return { status: res.status, body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_BYTES), finalUrl: url.href };
  }
  throw new Error('Too many redirects');
}
