#!/usr/bin/env bash
# Build the eval fixture diffs from real git, so they are what git actually produces.
set -euo pipefail
out="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q -b main .; git config user.email f@e.c; git config user.name F
DIFF=(git -c core.quotePath=false diff --no-color --no-ext-diff --find-renames --src-prefix=a/ --dst-prefix=b/ -U3)

# --- auth-clock: a bug fix that needed a new abstraction ---------------------
mkdir -p auth http test
cat > auth/token.ts <<'EOF'
export function isExpired(exp: number): boolean {
  if (exp === undefined) return true;
  const now = Math.floor(Date.now() / 1000);
  return exp < now;
}

export function decode(raw: string): { exp: number } {
  return JSON.parse(raw);
}
EOF
cat > http/middleware.ts <<'EOF'
import { decode, isExpired } from '../auth/token';

export function authenticate(raw: string) {
  const token = decode(raw);
  if (isExpired(token.exp)) return null;
  return token;
}
EOF
cat > http/server.ts <<'EOF'
import { authenticate } from './middleware';

export function handle(request: { token: string }) {
  const session = authenticate(request.token);
  if (!session) throw new Error('unauthorized');
  return session;
}
EOF
cat > test/token.test.ts <<'EOF'
import { isExpired } from '../auth/token';

it('rejects an expired token', () => {
  expect(isExpired(0)).toBe(true);
});
EOF
echo '{"name":"app","dependencies":{}}' > package.json
echo 'lockfileVersion: 6.0' > pnpm-lock.yaml
git add -A; git commit -q -m base

# The change: introduce a clock port, fix the boundary, thread it through, test it.
cat > auth/clock.ts <<'EOF'
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
};
EOF
cat > auth/token.ts <<'EOF'
import { systemClock, type Clock } from './clock';

export function isExpired(exp: number, clock: Clock = systemClock): boolean {
  if (exp === undefined) return true;
  const now = clock.now();
  return exp <= now;
}

export function decode(raw: string): { exp: number } {
  return JSON.parse(raw);
}
EOF
cat > http/middleware.ts <<'EOF'
import { decode, isExpired } from '../auth/token';
import { systemClock, type Clock } from '../auth/clock';

export function authenticate(raw: string, clock: Clock = systemClock) {
  const token = decode(raw);
  if (isExpired(token.exp, clock)) return null;
  return token;
}
EOF
cat > http/server.ts <<'EOF'
import { authenticate } from './middleware';
import { systemClock, type Clock } from '../auth/clock';

export function handle(request: { token: string }, clock: Clock = systemClock) {
  const session = authenticate(request.token, clock);
  if (!session) throw new Error('unauthorized');
  return session;
}
EOF
cat > test/token.test.ts <<'EOF'
import { isExpired } from '../auth/token';

const at = (t: number) => ({ now: () => t });

it('rejects an expired token', () => {
  expect(isExpired(0, at(100))).toBe(true);
});

it('rejects a token expiring exactly now', () => {
  expect(isExpired(100, at(100))).toBe(true);
});
EOF
echo 'lockfileVersion: 6.0
packages:
  clock: 1' > pnpm-lock.yaml
git add -A
"${DIFF[@]}" --cached HEAD > "$out/auth-clock.diff"
echo "wrote $out/auth-clock.diff"
