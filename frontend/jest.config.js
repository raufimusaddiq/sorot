/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // layout.tsx imports globals.css; Jest can't parse CSS.
    '\\.css$': '<rootDir>/test/styleMock.js',
  },
  // Jest must not try to run the Playwright e2e suite — those tests call
  // Playwright's own `test` function and crash when imported here.
  testPathIgnorePatterns: ['/node_modules/', '/e2e/', '/.next/'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!**/node_modules/**',
  ],
  // Project gate (AGENTS.md): >= 95% coverage. Branches are reported but not gated.
  coverageThreshold: {
    global: { statements: 95, lines: 95, functions: 95 },
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react-jsx',
        },
      },
    ],
  },
};
