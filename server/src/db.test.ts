import { afterEach, describe, expect, it, vi } from 'vitest';

const { readFileSync } = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock('node:fs', () => ({ readFileSync }));
vi.mock('pg', () => ({ Pool: class Pool {} }));

import { clientCertificateSsl } from './db';

const originalCert = process.env.PGSSLCERT;
const originalKey = process.env.PGSSLKEY;

afterEach(() => {
  if (originalCert === undefined) delete process.env.PGSSLCERT;
  else process.env.PGSSLCERT = originalCert;
  if (originalKey === undefined) delete process.env.PGSSLKEY;
  else process.env.PGSSLKEY = originalKey;
  vi.clearAllMocks();
});

describe('clientCertificateSsl', () => {
  it('does not override node-postgres TLS configuration without certificate paths', () => {
    delete process.env.PGSSLCERT;
    delete process.env.PGSSLKEY;

    expect(clientCertificateSsl()).toBeUndefined();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('loads the configured certificate and private key with verification enabled', () => {
    process.env.PGSSLCERT = '/tls/tls.crt';
    process.env.PGSSLKEY = '/tls/tls.key';
    readFileSync.mockReturnValueOnce(Buffer.from('client certificate'))
      .mockReturnValueOnce(Buffer.from('client key'));

    expect(clientCertificateSsl()).toEqual({
      cert: Buffer.from('client certificate'),
      key: Buffer.from('client key'),
      rejectUnauthorized: true,
    });
    expect(readFileSync).toHaveBeenNthCalledWith(1, '/tls/tls.crt');
    expect(readFileSync).toHaveBeenNthCalledWith(2, '/tls/tls.key');
  });

  it('fails closed when only one client-certificate path is configured', () => {
    process.env.PGSSLCERT = '/tls/tls.crt';
    delete process.env.PGSSLKEY;

    expect(clientCertificateSsl).toThrow('PGSSLCERT and PGSSLKEY must be set together');
  });
});
