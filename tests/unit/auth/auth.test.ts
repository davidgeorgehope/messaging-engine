import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('auth middleware', () => {
  describe('admin-env sentinel value', () => {
    const authSourcePath = join(ROOT, 'src/api/middleware/auth.ts');
    const authSource = readFileSync(authSourcePath, 'utf-8');

    it('should contain the admin-env sentinel ID for env-var admin tokens', () => {
      expect(authSource).toContain("id: 'admin-env'");
    });

    it('should NOT contain id: null for env-var admin tokens', () => {
      // The old pattern used id: null which caused downstream ownership check failures
      const elseBlock = authSource.match(/}\s*else\s*\{[^}]*\}/s);
      expect(elseBlock).not.toBeNull();
      expect(elseBlock![0]).not.toContain('id: null');
    });

    it('should set admin-env in the else branch of workspaceAuth (no userId)', () => {
      const elseBlockMatch = authSource.match(/}\s*else\s*\{[^}]*id:\s*'admin-env'/s);
      expect(elseBlockMatch).not.toBeNull();
    });

    it('should have both adminAuth and workspaceAuth middleware exports', () => {
      expect(authSource).toContain('export async function adminAuth');
      expect(authSource).toContain('export async function workspaceAuth');
    });
  });
});

describe('session ownership logic', () => {
  const sessionsServicePath = join(ROOT, 'src/services/workspace/sessions.ts');
  const sessionsSource = readFileSync(sessionsServicePath, 'utf-8');

  it('getSessionWithResults accepts userId and role parameters', () => {
    expect(sessionsSource).toMatch(/function getSessionWithResults\(sessionId:\s*string,\s*userId\?:\s*string,\s*role\?:\s*string\)/);
  });

  it('ownership check allows admin-env sentinel to bypass', () => {
    // The guard must check for admin-env so env-var admin tokens can view any session
    expect(sessionsSource).toContain("userId !== 'admin-env'");
  });

  it('ownership check allows admin role to bypass', () => {
    expect(sessionsSource).toContain("role !== 'admin'");
  });

  it('updateSession also accepts role parameter for admin bypass', () => {
    const updateSessionSource = sessionsSource.match(/function updateSession[\s\S]*?throw new Error\('Not authorized'\)/);
    expect(updateSessionSource).not.toBeNull();
    expect(updateSessionSource![0]).toContain("userId !== 'admin-env'");
    expect(updateSessionSource![0]).toContain("role !== 'admin'");
  });
});

describe('chat endpoint ownership', () => {
  const chatSourcePath = join(ROOT, 'src/api/workspace/chat.ts');
  const chatSource = readFileSync(chatSourcePath, 'utf-8');

  it('imports sessions table for ownership verification', () => {
    expect(chatSource).toContain('sessions');
  });

  it('has a verifySessionAccess helper', () => {
    expect(chatSource).toContain('verifySessionAccess');
  });

  it('chat endpoint verifies session access before proceeding', () => {
    // The POST /:id/chat handler should call verifySessionAccess
    const chatHandler = chatSource.match(/POST.*chat.*\n[\s\S]*?verifySessionAccess/);
    expect(chatHandler).not.toBeNull();
  });

  it('accept endpoint verifies session access', () => {
    const acceptHandler = chatSource.match(/accept.*\n[\s\S]*?verifySessionAccess/);
    expect(acceptHandler).not.toBeNull();
  });

  it('messages endpoint verifies session access', () => {
    const messagesHandler = chatSource.match(/messages.*\n[\s\S]*?verifySessionAccess/);
    expect(messagesHandler).not.toBeNull();
  });
});
