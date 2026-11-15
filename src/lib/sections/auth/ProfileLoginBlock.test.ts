// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ProfileLoginBlock from './ProfileLoginBlock.svelte';
import { statusState, resetState, setAccounts } from '$lib/stores/statusStore.svelte';

describe('ProfileLoginBlock Component', () => {
  const mockOnLogin = vi.fn();

  beforeEach(() => {
    resetState();
    vi.clearAllMocks();

    // Test accounts for the login list.
    setAccounts([
      { 'key-uid': '0x1234567890abcdef1234567890abcdef', displayName: 'Account 1' },
      { 'key-uid': '0xabcdef1234567890abcdef1234567890', displayName: 'Account 2' }
    ]);
  });

  it('должен корректно отображать список аккаунтов в select', () => {
    render(ProfileLoginBlock, {
      props: {
        selectedAccountKeyUid: '0x1234567890abcdef1234567890abcdef',
        password: '',
        onLogin: mockOnLogin
      }
    });

    // The select exists.
    const selectElement = screen.getByRole('combobox');
    expect(selectElement).toBeInTheDocument();

    // Options are rendered, trimmed to 16 characters as the component does.
    expect(screen.getByText('0x1234567890abcd...')).toBeInTheDocument();
    expect(screen.getByText('0xabcdef12345678...')).toBeInTheDocument();
  });

  it('должен вызывать onLogin при клике на кнопку входа', async () => {
    render(ProfileLoginBlock, {
      props: {
        selectedAccountKeyUid: '0x1234567890abcdef1234567890abcdef',
        password: 'Stauri#2026',
        onLogin: mockOnLogin
      }
    });

    // Find the button by text; the i18n lookup resolves to the English label in tests.
    const loginButton = screen.getByRole('button', { name: /log in|войти/i });

    await fireEvent.click(loginButton);

    expect(mockOnLogin).toHaveBeenCalledTimes(1);
  });

  it('не пускает со слабым паролем и объясняет причину', async () => {
    render(ProfileLoginBlock, {
      props: {
        selectedAccountKeyUid: '0x1234567890abcdef1234567890abcdef',
        password: 'qwer',
        onLogin: mockOnLogin
      }
    });

    await fireEvent.click(screen.getByRole('button', { name: /log in|войти/i }));

    expect(mockOnLogin).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
  });

  it('не пускает с пустым паролем', async () => {
    render(ProfileLoginBlock, {
      props: {
        selectedAccountKeyUid: '0x1234567890abcdef1234567890abcdef',
        password: '',
        onLogin: mockOnLogin
      }
    });

    await fireEvent.click(screen.getByRole('button', { name: /log in|войти/i }));

    expect(mockOnLogin).not.toHaveBeenCalled();
    expect(screen.getByText(/enter a password/i)).toBeInTheDocument();
  });

  it('Enter проверяет пароль так же, как кнопка', async () => {
    render(ProfileLoginBlock, {
      props: {
        selectedAccountKeyUid: '0x1234567890abcdef1234567890abcdef',
        password: 'password',
        onLogin: mockOnLogin
      }
    });

    await fireEvent.keyDown(screen.getByPlaceholderText(/password/i), { key: 'Enter' });

    expect(mockOnLogin).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
  });

  it('после исправления пароля ошибка исчезает и вход проходит', async () => {
    render(ProfileLoginBlock, {
      props: {
        selectedAccountKeyUid: '0x1234567890abcdef1234567890abcdef',
        password: 'qwer',
        onLogin: mockOnLogin
      }
    });

    await fireEvent.click(screen.getByRole('button', { name: /log in|войти/i }));
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();

    // Editing the field clears the hint.
    await fireEvent.input(screen.getByPlaceholderText(/password/i), {
      target: { value: 'Stauri#2026' }
    });
    expect(screen.queryByText(/at least 8 characters/i)).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: /log in|войти/i }));
    expect(mockOnLogin).toHaveBeenCalledTimes(1);
  });

  it('должен корректно работать с пустым списком аккаунтов', () => {
    setAccounts([]);

    render(ProfileLoginBlock, {
      props: {
        selectedAccountKeyUid: '',
        password: '',
        onLogin: mockOnLogin
      }
    });

    const selectElement = screen.getByRole('combobox');
    expect(selectElement).toBeInTheDocument();
    // No options are expected.
    expect(selectElement.children.length).toBe(0);
  });
});
