import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const scopes = {
  list: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  read: 'https://www.googleapis.com/auth/calendar.events.readonly',
  write: 'https://www.googleapis.com/auth/calendar.events',
};

export class GoogleError extends Error {
  constructor(status, code) {
    super(`Google returned ${status}${code ? ` (${code})` : ''}`);
    this.status = status;
    this.code = code;
  }
}

export function googleClient({ clientId, secret, redirect, key, fetcher = fetch }) {
  const accesses = new Map();
  const request = async (url, options) => {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(20_000) });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new GoogleError(response.status, data?.error?.errors?.[0]?.reason ??
        (typeof data?.error === 'string' ? data.error : undefined));
    }
    return data;
  };
  const token = fields => request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, ...fields }),
  });
  return {
    exchange: (code, verifier) => token({
      code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code',
    }),
    profile: access => request('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${access}` },
    }),
    seal(refresh) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(refresh, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    open(box) {
      const bytes = Buffer.from(box, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
    },
    async api(account, path, { method = 'GET', body, etag } = {}) {
      const call = async force => {
        let cached = accesses.get(account.id);
        if (force || cached?.box !== account.refresh || cached.expires < Date.now()) {
          const result = await token({ refresh_token: this.open(account.refresh), grant_type: 'refresh_token' });
          cached = { access: result.access_token, box: account.refresh, expires: Date.now() + (result.expires_in - 60) * 1000 };
          accesses.set(account.id, cached);
        }
        return request(`https://www.googleapis.com/calendar/v3/${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${cached.access}`,
            ...(body && { 'Content-Type': 'application/json' }),
            ...(etag && { 'If-Match': etag }),
          },
          body: body && JSON.stringify(body),
        });
      };
      try { return await call(false); }
      catch (error) {
        if (error.status === 401) return call(true);
        throw error;
      }
    },
    async revoke(account) {
      accesses.delete(account.id);
      await request('https://oauth2.googleapis.com/revoke', {
        method: 'POST', body: new URLSearchParams({ token: this.open(account.refresh) }),
      });
    },
  };
}
