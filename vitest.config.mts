import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // These "unit" tests spawn real git and build real repositories on disk, so their
    // budget is process startup, not computation. On the Windows runner a cold spawn
    // costs seconds — `doctor`, which spawns five, blew the 5s default while the same
    // call took 200ms once the runner was warm. 20s is headroom for the slowest
    // platform, still short enough that a genuine hang fails rather than hanging CI.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
