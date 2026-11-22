const apiPort = Number(process.env.VAULT_API_PORT ?? 4310);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) throw new Error('Invalid VAULT_API_PORT');

export default {
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `http://127.0.0.1:${apiPort}/api/:path*` }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    }];
  },
};
