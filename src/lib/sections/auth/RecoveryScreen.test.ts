// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import RecoveryScreen from './RecoveryScreen.svelte';

const WORDS = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9', 'j10', 'k11', 'l12'];

async function fillWords(): Promise<void> {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"]'));
  expect(inputs.length).toBe(12);
  for (const [i, w] of WORDS.entries()) await fireEvent.input(inputs[i], { target: { value: w } });
}

/** Password fields; `PasswordInput` renders `type="password"`, which has no ARIA role. */
function passwordFields(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'));
}

describe('RecoveryScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('показывает выбор, когда профиль уже на устройстве', async () => {
    const onRestore = vi.fn().mockResolvedValue('opened');
    const onReset = vi.fn();
    render(RecoveryScreen, {
      onBack: vi.fn(),
      onRestore,
      onReset,
      onCheckLocal: vi.fn().mockResolvedValue(true),
    });

    await fillWords();
    await fireEvent.click(screen.getByText('Continue'));

    await waitFor(() => expect(screen.queryByText('Existing profile')).toBeTruthy());
    // The choice is up front, not after a failed attempt.
    expect(screen.queryByText('New local copy')).toBeTruthy();

    // Default is the existing password: one field, no confirmation.
    const fields = passwordFields();
    expect(fields.length).toBe(1);
    await fireEvent.input(fields[0], { target: { value: 'Old1!pass' } });

    await fireEvent.click(screen.getByText('Open the profile'));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(WORDS.join(' '), 'Old1!pass'));
    expect(onReset).not.toHaveBeenCalled();
  });

  it('вкладка «новая копия» открывает onReset', async () => {
    const onReset = vi.fn().mockResolvedValue('restored');
    render(RecoveryScreen, {
      onBack: vi.fn(),
      onRestore: vi.fn(),
      onReset,
      onCheckLocal: vi.fn().mockResolvedValue(true),
    });

    await fillWords();
    await fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(screen.queryByText('New local copy')).toBeTruthy());
    await fireEvent.click(screen.getByText('New local copy'));

    // A new password is confirmed: two fields.
    const fields = passwordFields();
    expect(fields.length).toBe(2);
    await fireEvent.input(fields[0], { target: { value: 'New1!pass' } });
    await fireEvent.input(fields[1], { target: { value: 'New1!pass' } });

    await fireEvent.click(screen.getByText('Remove the local copy and open'));
    await waitFor(() => expect(onReset).toHaveBeenCalledWith(WORDS.join(' '), 'New1!pass'));
  });

  it('без локального профиля — только создание копии', async () => {
    const onReset = vi.fn().mockResolvedValue('restored');
    render(RecoveryScreen, {
      onBack: vi.fn(),
      onRestore: vi.fn(),
      onReset,
      onCheckLocal: vi.fn().mockResolvedValue(false),
    });

    await fillWords();
    await fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(screen.queryByText('Create the local copy and open')).toBeTruthy());
    // No tabs: there is no old password to enter.
    expect(screen.queryByText('Existing profile')).toBeNull();
  });

  it('отказ по паролю не оставляет на том же поле', async () => {
    const refused = new Error('The profile on this device is protected by another password');
    refused.name = 'LocalProfileLockedError';
    const onRestore = vi.fn().mockRejectedValue(refused);
    const onReset = vi.fn().mockResolvedValue('restored');
    render(RecoveryScreen, {
      onBack: vi.fn(),
      onRestore,
      onReset,
      onCheckLocal: vi.fn().mockResolvedValue(true),
    });

    await fillWords();
    await fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(screen.queryByText('Existing profile')).toBeTruthy());

    // An old password that does not open the profile: the refusal must not leave the
    // user on the same field. The screen switches to the new-copy choice on its own.
    const fields = passwordFields();
    await fireEvent.input(fields[0], { target: { value: 'Wrong!pass' } });
    await fireEvent.click(screen.getByText('Open the profile'));

    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    // Now the choice is set: the destructive button is visible.
    await waitFor(() =>
      expect(screen.queryByText('Remove the local copy and open')).toBeTruthy()
    );

    await fireEvent.input(passwordFields()[0], { target: { value: 'New1!pass' } });
    await fireEvent.input(passwordFields()[1], { target: { value: 'New1!pass' } });
    await fireEvent.click(screen.getByText('Remove the local copy and open'));
    await waitFor(() => expect(onReset).toHaveBeenCalledWith(WORDS.join(' '), 'New1!pass'));
  });

  it('старый пароль не проверяется по новым правилам', async () => {
    const onRestore = vi.fn().mockResolvedValue('opened');
    render(RecoveryScreen, {
      onBack: vi.fn(),
      onRestore,
      onReset: vi.fn(),
      onCheckLocal: vi.fn().mockResolvedValue(true),
    });

    await fillWords();
    await fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(screen.queryByText('Existing profile')).toBeTruthy());

    // Pre-scheme passwords do not meet the new rules and must not be refused:
    // the only question is whether it opens the profile.
    const fields = passwordFields();
    expect(fields.length).toBe(1);
    await fireEvent.input(fields[0], { target: { value: 'short' } });
    const button = screen.getByText('Open the profile');
    expect(button).toBeEnabled();
    await fireEvent.click(button);
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(WORDS.join(' '), 'short'));
  });
});
