import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('auth:users');
const SALT_ROUNDS = 12;

export interface CreateUserInput {
  username: string;
  email: string;
  password: string;
  displayName: string;
  role?: 'user' | 'admin';
}

export interface SafeUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

function toSafeUser(user: typeof users.$inferSelect): SafeUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

export async function createUser(input: CreateUserInput): Promise<SafeUser> {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Check if this is the first user — they get admin role
  const existingUsers = await db.query.users.findMany({ columns: { id: true }, limit: 1 });
  const role = existingUsers.length === 0 ? 'admin' : (input.role || 'user');

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
  const id = generateId();

  await db.insert(users).values({
    id,
    username: input.username,
    email: input.email,
    passwordHash,
    displayName: input.displayName,
    role,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  logger.info('User created', { id, username: input.username, role });

  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  return toSafeUser(user!);
}

export async function authenticateUser(username: string, password: string): Promise<SafeUser | null> {
  const db = getDatabase();

  const user = await db.query.users.findFirst({
    where: eq(users.username, username),
  });

  if (!user || !user.isActive) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  // Update last login
  await db.update(users)
    .set({ lastLoginAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(users.id, user.id))
    .run();

  logger.info('User authenticated', { id: user.id, username: user.username });
  return toSafeUser(user);
}

export async function getUserById(id: string): Promise<SafeUser | null> {
  const db = getDatabase();
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!user) return null;
  return toSafeUser(user);
}
