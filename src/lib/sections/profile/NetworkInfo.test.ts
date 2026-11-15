import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import NetworkInfo from './NetworkInfo.svelte';
import { statusState, resetState, setNetworkInfo } from '$lib/stores/statusStore.svelte';

describe('NetworkInfo Component', () => {
  beforeEach(() => {
    // A clean state before every test.
    resetState();
  });

  it('должен корректно отображать информацию о Mainnet', () => {
    setNetworkInfo('mainnet', 'https://ethereum-rpc.publicnode.com', 'status.prod', false, 1);

    render(NetworkInfo);

    // Texts.
    expect(screen.getByText('Ethereum Mainnet')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument(); // Chain ID
    expect(screen.getByText('https://ethereum-rpc.publicnode.com')).toBeInTheDocument();
    expect(screen.getByText('status.prod')).toBeInTheDocument();

    // The Mainnet badge is present and the Testnet badge is not.
    expect(screen.getByText('Mainnet')).toBeInTheDocument();
    expect(screen.queryByText('Testnet')).not.toBeInTheDocument();
  });

  it('должен корректно отображать информацию о Sepolia Testnet', () => {
    setNetworkInfo('sepolia', 'https://rpc.sepolia.org', 'status.test', true, 11155111);

    render(NetworkInfo);

    expect(screen.getByText('SEPOLIA')).toBeInTheDocument();
    expect(screen.getByText('11155111')).toBeInTheDocument();
    expect(screen.getByText('https://rpc.sepolia.org')).toBeInTheDocument();
    expect(screen.getByText('status.test')).toBeInTheDocument();

    // The Testnet badge is present and the Mainnet badge is not.
    expect(screen.getByText('Testnet')).toBeInTheDocument();
    expect(screen.queryByText('Mainnet')).not.toBeInTheDocument();
  });

  it('должен корректно отображать информацию о Holesky Testnet', () => {
    setNetworkInfo('holesky', 'https://ethereum-holesky-rpc.publicnode.com', 'status.test', true, 17000);

    render(NetworkInfo);

    expect(screen.getByText('HOLESKY')).toBeInTheDocument();
    expect(screen.getByText('17000')).toBeInTheDocument();
    expect(screen.getByText('Testnet')).toBeInTheDocument();
  });

  it('должен отображать "unknown" для нераспознанной сети', () => {
    // Simulate a custom network that `getChainId()` does not know.
    statusState.networkName = 'custom-network';
    statusState.isTestnet = true;
    statusState.rpcUrl = 'https://custom.rpc';
    statusState.wakuFleet = 'custom.fleet';

    render(NetworkInfo);

    expect(screen.getByText('CUSTOM-NETWORK')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });
});
