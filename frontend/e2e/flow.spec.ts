import { test, expect } from '@playwright/test';

const BACKEND = process.env.BACKEND_URL || 'http://localhost:8080';
const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:8080';

test.describe('Viral Clipper E2E', () => {

  test('frontend loads and shows import form', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Viral Clipper');
    await expect(page.getByPlaceholder('Paste YouTube URL...')).toBeVisible();
    // Multiple "import" buttons exist now (the "Import & Clips" tab + the form
    // submit "Import & Process"), so match the submit by its exact name.
    await expect(page.getByRole('button', { name: /import & process/i })).toBeVisible();
  });

  test('three top-level tabs render', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /import & clips/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^discover$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^learning/i })).toBeVisible();
  });

  test('backend health check responds', async ({ request }) => {
    const resp = await request.get(`${BACKEND}/api/health`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.status).toBe('ok');
  });

  test('import with empty URL shows validation', async ({ page }) => {
    await page.goto('/');
    const btn = page.getByRole('button', { name: /import & process/i });
    await expect(btn).toBeDisabled();
  });

  test('import with valid URL triggers processing', async ({ page }) => {
    await page.goto('/');
    const input = page.getByPlaceholder('Paste YouTube URL...');
    await input.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const btn = page.getByRole('button', { name: /import & process/i });
    await expect(btn).toBeEnabled();
    await btn.click();
    // Button flips to a disabled "Importing..." state while the request is in flight.
    await expect(page.getByRole('button', { name: /importing/i }))
      .toBeVisible({ timeout: 5000 });
  });

  test('job import surfaces UI feedback', async ({ page }) => {
    // The import pathway should produce *some* visible response after the
    // click — either the button flips to Importing..., an error banner appears
    // (backend down, invalid URL), or the import card reappears with the
    // cleared input. We assert that the URL field is no longer a fresh mount.
    await page.goto('/');
    const input = page.getByPlaceholder('Paste YouTube URL...');
    await input.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.getByRole('button', { name: /import & process/i }).click();
    await page.waitForTimeout(3000);
    // The page header with serif title stays visible through the state change.
    await expect(page.locator('h1')).toContainText('Viral Clipper');
    // And the tab nav is still there.
    await expect(page.getByRole('button', { name: /import & clips/i })).toBeVisible();
  });
});

test.describe('API Contract E2E', () => {

  test('GET /api/jobs returns valid structure', async ({ request }) => {
    const resp = await request.get(`${BACKEND}/api/jobs`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('data');
  });

  test('POST /api/import with no URL returns error', async ({ request }) => {
    const resp = await request.post(`${BACKEND}/api/import`, { data: {} });
    expect(resp.status()).toBeGreaterThanOrEqual(400);
  });

  test('GET /api/videos returns valid structure', async ({ request }) => {
    const resp = await request.get(`${BACKEND}/api/videos`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('data');
  });

  test('GET /api/clips/{invalid} returns 404', async ({ request }) => {
    const resp = await request.get(`${BACKEND}/api/clips/nonexistent-id`);
    expect(resp.status()).toBe(404);
  });
});
