// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import NetworkPicker from './NetworkPicker.svelte';

describe('NetworkPicker', () => {
  const mockOnSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('должен показывать Mainnet как выбранный по умолчанию', () => {
    render(NetworkPicker, {
      props: {
        selectedNetwork: 'mainnet',
        onSelect: mockOnSelect,
      },
    });

    // Mainnet must be highlighted (success token: border-success).
    const mainnetButton = screen.getByText('Mainnet').closest('button');
    expect(mainnetButton).toHaveClass('border-success');
  });

  it('должен раскрывать список тестнетов при клике на Testnet', async () => {
    render(NetworkPicker, {
      props: {
        selectedNetwork: 'mainnet',
        onSelect: mockOnSelect,
      },
    });

    // Initially Sepolia and Holesky are hidden.
    expect(screen.queryByText('Sepolia')).not.toBeInTheDocument();
    expect(screen.queryByText('Holesky')).not.toBeInTheDocument();

    await fireEvent.click(screen.getByText('Testnet'));

    // Both are now visible.
    expect(screen.getByText('Sepolia')).toBeInTheDocument();
    expect(screen.getByText('Holesky')).toBeInTheDocument();
  });

  it('должен вызывать onSelect при выборе Sepolia', async () => {
    render(NetworkPicker, {
      props: {
        selectedNetwork: 'mainnet',
        onSelect: mockOnSelect,
      },
    });

    // Expand the list.
    await fireEvent.click(screen.getByText('Testnet'));

    // Click Sepolia.
    await fireEvent.click(screen.getByText('Sepolia'));

    expect(mockOnSelect).toHaveBeenCalledWith('sepolia');
  });

  it('должен вызывать onSelect при выборе Mainnet', async () => {
    render(NetworkPicker, {
      props: {
        selectedNetwork: 'sepolia',
        onSelect: mockOnSelect,
      },
    });

    // Click Mainnet.
    await fireEvent.click(screen.getByText('Mainnet'));

    expect(mockOnSelect).toHaveBeenCalledWith('mainnet');
  });

  it('должен подсвечивать выбранный тестнет', () => {
    render(NetworkPicker, {
      props: {
        selectedNetwork: 'sepolia',
        onSelect: mockOnSelect,
      },
    });

    // Testnet must be highlighted (warning token: border-warning).
    const testnetButton = screen.getByText('Testnet').closest('button');
    expect(testnetButton).toHaveClass('border-warning');
  });
});
