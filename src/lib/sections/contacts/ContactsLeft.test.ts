// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ContactsLeft from './ContactsLeft.svelte';
import { contactsState } from '$lib/stores/contactsStore.svelte';

// The store is mocked so the real load is not triggered.
vi.mock('$lib/stores/contactsStore.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/stores/contactsStore.svelte')>();
  return {
    ...actual,
    loadContacts: vi.fn(), // Keep the load itself out of the test.
  };
});

// getDisplayName is mocked as well.
vi.mock('$lib/utils/user', () => ({
  getDisplayName: (contact: any) => contact.displayName || contact.id.slice(0, 8),
}));

describe('ContactsLeft', () => {
  beforeEach(() => {
    contactsState.items = [
      { id: '0x123abc', displayName: 'Alice', mutual: true },
      { id: '0x456def', displayName: 'Bob', contactRequestRemoteState: 3, contactRequestLocalState: 0 },
    ];
    contactsState.isLoading = false;
  });

  it('должен отображать список контактов', () => {
    render(ContactsLeft);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('должен фильтровать контакты по поиску', async () => {
    render(ContactsLeft);
    const searchInput = screen.getByPlaceholderText(/Search by name or key/i);

    await fireEvent.input(searchInput, { target: { value: 'Alice' } });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('должен показывать кнопку Accept для pending-запроса', () => {
    render(ContactsLeft);
    // Bob sent a request (RemoteState = Received) and was never added, so the
    // Accept button must appear.
    expect(screen.getAllByText(/Accept/i).length).toBeGreaterThan(0);
  });
});
