import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthState } from '@agent-console/shared';
import { AppDatabase } from '../db/database.js';
import { nowIso } from '../lib/time.js';
import { generateCsrfToken, generateSessionId, sealCookieValue, unsealCookieValue, verifyPasswordHash } from './password.js';
import type { AppConfig } from '../config/schema.js';

interface AuthSessionRow {
  id: string;
  userLogin?: string;
  displayName?: string;
  via: 'password' | 'tailscale';
  csrfToken: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
}

export class AuthService {
  readonly cookieName = 'agent_console_session';

  constructor(private readonly config: AppConfig, private readonly db: AppDatabase) {}

  verifyPassword(password: string): boolean {
    return verifyPasswordHash(password, this.config.security.passwordHash);
  }

  async ensureAuthenticated(request: FastifyRequest, reply: FastifyReply, requireCsrf = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS'): Promise<AuthSessionRow> {
    const session = await this.getOrBootstrapSession(request, reply);
    if (!session) {
      reply.code(401).send({ error: 'Authentication required.' });
      throw new Error('Authentication required');
    }
    if (requireCsrf) {
      const header = request.headers['x-csrf-token'];
      if (typeof header !== 'string' || header !== session.csrfToken) {
        reply.code(403).send({ error: 'Invalid CSRF token.' });
        throw new Error('Invalid CSRF token');
      }
    }
    return session;
  }

  async getAuthState(request: FastifyRequest, reply: FastifyReply): Promise<AuthState> {
    const session = await this.getOrBootstrapSession(request, reply);
    if (!session) {
      return {
        authenticated: false,
        tailscaleEnabled: this.config.security.trustTailscaleHeaders,
      };
    }
    return {
      authenticated: true,
      tailscaleEnabled: this.config.security.trustTailscaleHeaders,
      user: {
        login: session.userLogin,
        displayName: session.displayName,
        via: session.via,
      },
      csrfToken: session.csrfToken,
    };
  }

  async loginWithPassword(reply: FastifyReply): Promise<AuthState> {
    const session = this.createSession({ via: 'password' });
    this.setCookie(reply, session.id);
    return {
      authenticated: true,
      user: { via: 'password' },
      csrfToken: session.csrfToken,
    };
  }

  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionId = this.resolveCookieSessionId(request.cookies?.[this.cookieName]);
    if (sessionId) {
      this.db.deleteAuthSession(sessionId);
    }
    reply.clearCookie(this.cookieName, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.security.cookieSecure,
    });
  }

  authenticateRawHeaders(headers: Record<string, string | string[] | undefined>, remoteAddress?: string): boolean {
    const cookieHeader = typeof headers.cookie === 'string' ? headers.cookie : undefined;
    const cookies = parseCookieHeader(cookieHeader);
    const sessionId = this.resolveCookieSessionId(cookies[this.cookieName]);
    if (sessionId) {
      const session = this.db.getAuthSession(sessionId);
      if (session && session.expiresAt > nowIso()) return true;
    }
    if (!this.canTrustTailscaleHeaders(remoteAddress)) return false;
    const login = typeof headers['tailscale-user-login'] === 'string' ? headers['tailscale-user-login'] : undefined;
    if (!login) return false;
    if (this.config.security.tailscaleAllowedUserLogin && login !== this.config.security.tailscaleAllowedUserLogin) {
      return false;
    }
    return true;
  }

  private async getOrBootstrapSession(request: FastifyRequest, reply: FastifyReply): Promise<AuthSessionRow | undefined> {
    const session = this.getSessionFromCookie(request.cookies?.[this.cookieName]);
    if (session) return session;

    if (!this.canTrustTailscaleHeaders(request.raw.socket.remoteAddress)) return undefined;
    const login = request.headers['tailscale-user-login'];
    if (typeof login !== 'string' || login.length === 0) return undefined;
    if (this.config.security.tailscaleAllowedUserLogin && login !== this.config.security.tailscaleAllowedUserLogin) return undefined;

    const displayName = typeof request.headers['tailscale-user-name'] === 'string' ? request.headers['tailscale-user-name'] : undefined;
    const created = this.createSession({ via: 'tailscale', userLogin: login, displayName });
    this.setCookie(reply, created.id);
    return created;
  }

  private createSession(input: { via: 'password' | 'tailscale'; userLogin?: string; displayName?: string }): AuthSessionRow {
    this.db.deleteExpiredAuthSessions(nowIso());
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + this.config.security.sessionTtlHours * 60 * 60 * 1000).toISOString();
    const session: AuthSessionRow = {
      id: generateSessionId(),
      userLogin: input.userLogin,
      displayName: input.displayName,
      via: input.via,
      csrfToken: generateCsrfToken(),
      expiresAt,
      createdAt,
      lastSeenAt: createdAt,
    };
    this.db.upsertAuthSession(session);
    return session;
  }

  private getSessionFromCookie(cookieValue: string | undefined): AuthSessionRow | undefined {
    this.db.deleteExpiredAuthSessions(nowIso());
    const sessionId = this.resolveCookieSessionId(cookieValue);
    if (!sessionId) return undefined;
    const session = this.db.getAuthSession(sessionId);
    if (!session) return undefined;
    if (session.expiresAt <= nowIso()) {
      this.db.deleteAuthSession(session.id);
      return undefined;
    }
    const touched: AuthSessionRow = { ...session, lastSeenAt: nowIso() };
    this.db.upsertAuthSession(touched);
    return touched;
  }

  private resolveCookieSessionId(cookieValue: string | undefined): string | undefined {
    return unsealCookieValue(cookieValue, this.config.security.sessionSecret);
  }

  private setCookie(reply: FastifyReply, sessionId: string): void {
    reply.setCookie(this.cookieName, sealCookieValue(sessionId, this.config.security.sessionSecret), {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.security.cookieSecure,
      maxAge: this.config.security.sessionTtlHours * 60 * 60,
    });
  }

  private canTrustTailscaleHeaders(remoteAddress?: string): boolean {
    return this.config.security.trustTailscaleHeaders && isLoopbackAddress(remoteAddress);
  }
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    result[key] = rest.join('=');
  }
  return result;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}
