// App code logs every subprocess and stage transition; keep test output
// readable unless TEST_LOGS=1.
if (!process.env.TEST_LOGS) {
  for (const level of ["info", "warn", "error"] as const) console[level] = () => {};
}
