// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import MainEntryScreen from './MainEntryScreen.svelte';
import { resetState, setAccounts } from '$lib/stores/statusStore.svelte';

describe('MainEntryScreen Component', () => {
  const mockOnLogin = vi.fn();
  const mockOnCreate = vi.fn();
  const mockOnRecovery = vi.fn();
  const mockOnNetworkChange = vi.fn();

  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  it('должен показывать только CreateProfileBlock, если профилей нет', () => {
    setAccounts([]);

    render(MainEntryScreen, {
      props: {
        hasProfiles: false,
        selectedAccountKeyUid: '',
        selectedNetwork: 'mainnet',
        onLogin: mockOnLogin,
        onCreate: mockOnCreate,
        onRecovery: mockOnRecovery,
        onNetworkChange: mockOnNetworkChange
      }
    });

    // ProfileLoginBlock (with the Log In button) must not render.
    expect(screen.queryByText('Log In')).not.toBeInTheDocument();

    // CreateProfileBlock (headed "Create new profile") must be present.
    expect(screen.getByText('Create new profile')).toBeInTheDocument();

    // The "+ Create new profile" button must not be visible.
    expect(screen.queryByText(/\+ Create new profile/i)).not.toBeInTheDocument();
  });

  it('должен показывать ProfileLoginBlock и кнопку "+ Create", если профили есть', () => {
    setAccounts([{ 'key-uid': 'uid-1' }]);

    render(MainEntryScreen, {
      props: {
        hasProfiles: true,
        selectedAccountKeyUid: 'uid-1',
        selectedNetwork: 'mainnet',
        onLogin: mockOnLogin,
        onCreate: mockOnCreate,
        onRecovery: mockOnRecovery,
        onNetworkChange: mockOnNetworkChange
      }
    });

    // ProfileLoginBlock renders the "Log In" button.
    expect(screen.getByText('Log In')).toBeInTheDocument();

    // The "+ Create new profile" button must be present.
    expect(screen.getByText(/\+ Create new profile/i)).toBeInTheDocument();

    // CreateProfileBlock (with "Create new profile" as its h3) must not be visible.
    expect(screen.queryByText('Create new profile')).not.toBeInTheDocument();
  });

  it('должен показывать CreateProfileBlock при клике на "+ Create new profile"', async () => {
    setAccounts([{ 'key-uid': 'uid-1' }]);

    render(MainEntryScreen, {
      props: {
        hasProfiles: true,
        selectedAccountKeyUid: 'uid-1',
        selectedNetwork: 'mainnet',
        onLogin: mockOnLogin,
        onCreate: mockOnCreate,
        onRecovery: mockOnRecovery,
        onNetworkChange: mockOnNetworkChange
      }
    });

    // CreateProfileBlock is absent at first.
    expect(screen.queryByText('Create new profile')).not.toBeInTheDocument();

    // Click "+ Create new profile".
    const createButton = screen.getByText(/\+ Create new profile/i);
    await fireEvent.click(createButton);

    // CreateProfileBlock must appear now.
    expect(screen.getByText('Create new profile')).toBeInTheDocument();

    // ProfileLoginBlock does not disappear.
    expect(screen.getByText('Log In')).toBeInTheDocument();
  });

  it('должен вызывать onRecovery при клике на "Log in by recovery phrase"', async () => {
    render(MainEntryScreen, {
      props: {
        hasProfiles: false,
        selectedAccountKeyUid: '',
        selectedNetwork: 'mainnet',
        onLogin: mockOnLogin,
        onCreate: mockOnCreate,
        onRecovery: mockOnRecovery,
        onNetworkChange: mockOnNetworkChange
      }
    });

    const recoveryButton = screen.getByText(/Log in by recovery phrase/i);
    await fireEvent.click(recoveryButton);

    expect(mockOnRecovery).toHaveBeenCalledTimes(1);
  });
});
