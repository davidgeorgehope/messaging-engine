import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('auth middleware', () => {
  describe('admin-env sentinel value', () => {
    const authSourcePath = resolve('/root/messaging-engine/src/api/middleware/auth.ts');
    const authSource = readFileSync(authSourcePath, 'utf-8');

    it('should contain the admin-env sentinel ID for env-var admin tokens', () => {
      // The workspaceAuth middleware sets id: 'admin-env' for tokens without a userId.
      // This must be a non-null string so downstream code never sees a null user id.
      expect(authSource).toContain("id: 'admin-env'");
    });

    it('should set admin-env in the else branch of workspaceAuth (no userId)', () => {
      // Verify the pattern: when payload.userId is falsy, the middleware
      // falls back to a hardcoded user object with id: 'admin-env'
      const elseBlockMatch = authSource.match(/}\s*else\s*\{[^}]*id:\s*'admin-env'/s);
      expect(elseBlockMatch).not.toBeNull();
    });

    it('should set displayName from payload.sub for admin-env users', () => {
      // After the else branch that sets id: 'admin-env', displayName should come from payload.sub
      expect(authSource).toContain('displayName: payload.sub');
    });

    it('should have both adminAuth and workspaceAuth middleware exports', () => {
      expect(authSource).toContain('export async function adminAuth');
      expect(authSource).toContain('export async function workspaceAuth');
    });

    it('should verify token and check for inactive users in workspaceAuth', () => {
      expect(authSource).toContain('verifyToken(token)');
      expect(authSource).toContain('!user.isActive');
    });
  });
});
