export interface TokenStore {
  getAccessToken(): string | null;
  setAccessToken(token: string | null): void;
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string | null): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private access: string | null = null;
  private refresh: string | null = null;

  getAccessToken(): string | null {
    return this.access;
  }
  setAccessToken(token: string | null): void {
    this.access = token;
  }
  getRefreshToken(): Promise<string | null> {
    return Promise.resolve(this.refresh);
  }
  setRefreshToken(token: string | null): Promise<void> {
    this.refresh = token;
    return Promise.resolve();
  }
}

/** Web: access token in memory; the refresh token lives in an httpOnly cookie. */
export function createCookieTokenStore(): TokenStore {
  let access: string | null = null;
  return {
    getAccessToken: () => access,
    setAccessToken: (token) => {
      access = token;
    },
    getRefreshToken: () => Promise.resolve(null),
    setRefreshToken: () => Promise.resolve(),
  };
}
