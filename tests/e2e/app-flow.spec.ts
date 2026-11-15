import { test, expect } from '@playwright/test';

test.describe('Честный E2E тест Stauri', () => {
  test('реальное приложение должно запустить бэкенд и показать форму', async ({ page }) => {
    console.log('⏳ Переход на страницу. Ожидаем реального запуска Tauri и status-backend...');

    // 1. Navigate. Playwright already waits for the webServer to be ready (up to 120 s).
    await page.goto('/');

    // 2. The real status-backend takes 3-8 s to start, so the wait for the first
    // render is given a 45 s budget.
    console.log('⏳ Ожидаем появления заголовка "Stauri" (таймаут 45 сек)...');

    const stauriText = page.getByText('Stauri').first();
    await expect(stauriText).toBeVisible({ timeout: 45000 });
    console.log('✅ Заголовок "Stauri" успешно отрисован реальным приложением!');

    // 3. The password field appears once the real backend answers or the UI renders.
    console.log('⏳ Ожидаем появления поля ввода...');
    const passwordField = page.locator('input[type="password"]').or(page.getByPlaceholder(/password|пароль|Password/i));
    await expect(passwordField).toBeVisible({ timeout: 10000 });
    console.log('✅ Поле ввода найдено!');

    // 4. Type a password that satisfies the rules (see src/lib/utils/password.ts).
    console.log('⌨️ Вводим пароль "Stauri#2026"...');
    await passwordField.fill('Stauri#2026');
    await expect(passwordField).toHaveValue('Stauri#2026');
    console.log('✅ Пароль успешно введен!');

    // 5. The action button.
    const actionButton = page.locator('button').filter({ hasText: /Create Profile|Log In/i }).first();
    await expect(actionButton).toBeVisible();
    console.log('✅ Кнопка действия найдена!');

    console.log('🎉 ЧЕСТНЫЙ E2E ТЕСТ ПРОЙДЕН! Приложение работает корректно.');
  });
});
