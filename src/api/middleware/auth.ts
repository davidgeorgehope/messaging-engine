import * as jose from 'jose';
import type { Context, Next } from 'hono';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('auth');

// Encode the JWT secret as Uint8Array for jose
function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(config.admin.jwtSecret);
}

/**
 * Parse JWT expiry string (e.g., '7d', '24h', '30m') into seconds.
 */
function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) {
    return 7 * 24 * 60 * 60; // default 7 days
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 60 * 60;
    case 'd': return value * 24 * 60 * 60;
    default: return 7 * 24 * 60 * 60;
  }
}

export interface TokenPayload {
  sub: string;
  role: string;
  iat?: number;
  exp?: number;
}

/**
 * Generate a JWT token for the given user.
 */
export async function generateToken(username: string, role: string = 'admin'): Promise<string> {
  const secret = getSecretKey();
  const expirySeconds = parseExpiry(config.admin.jwtExpiresIn);

  const token = await new jose.SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(username)
    .setIssuedAt()
    .setExpirationTime(`${expirySeconds}s`)
    .sign(secret);

  logger.debug('Token generated', { username, role, expiresIn: config.admin.jwtExpiresIn });
  return token;
}

/**
 * Verify and decode a JWT token.
 */
export async function verifyToken(token: string): Promise<TokenPayload> {
  const secret = getSecretKey();

  try {
    const { payload } = await jose.jwtVerify(token, secret);

    return {
      sub: payload.sub ?? '',
      role: (payload.role as string) ?? 'admin',
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch (error) {
    if (error instanceof jose.errors.JWTExpired) {
      throw new Error('Token has expired');
    }
    if (error instanceof jose.errors.JWSSignatureVerificationFailed) {
      throw new Error('Invalid token signature');
    }
    throw new Error('Invalid token');
  }
}

/**
 * Hono middleware that requires a valid admin JWT in the Authorization header.
 */
export async function adminAuth(c: Context, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    return c.json({ error: 'Authorization header required' }, 401);
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return c.json({ error: 'Authorization header must be: Bearer <token>' }, 401);
  }

  const token = parts[1];

  try {
    const payload = await verifyToken(token);

    // Attach user info to context
    c.set('user', {
      username: payload.sub,
      role: payload.role,
    });

    logger.debug('Request authenticated', { username: payload.sub, role: payload.role });
    await next();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Authentication failed';
    logger.warn('Authentication failed', {
      error: message,
      path: c.req.path,
    });
    return c.json({ error: message }, 401);
  }
}
