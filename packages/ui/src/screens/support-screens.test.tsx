import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppLocation, BackendProfile } from '@94ai/client';
import { GettingStartedScreen } from './GettingStartedScreen';
import { HelpScreen } from './HelpScreen';
import { SettingsScreen } from './SettingsScreen';
import { WelcomeScreen } from './WelcomeScreen';

describe('public-ready support screens', () => {
  it('explains the product and privacy before authentication', () => {
    const navigate = vi.fn<(location: AppLocation) => void>();
    render(<WelcomeScreen onNavigate={navigate} />);
    expect(screen.getByRole('heading', { name: /手機查看 AI 額度/ })).toBeInTheDocument();
    expect(screen.getByText(/Provider 憑證留在 Mac/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '開始設定' }));
    expect(navigate).toHaveBeenCalledWith({ route: 'getting-started' });
    fireEvent.click(screen.getByRole('button', { name: '先看隱私說明' }));
    expect(navigate).toHaveBeenCalledWith({ route: 'help' });
  });

  it('keeps setup understandable without Firebase or Node jargon as primary copy', () => {
    const signIn = vi.fn(async () => undefined);
    render(<GettingStartedScreen signedIn={false} onSignIn={signIn} onNavigate={() => undefined} />);
    expect(screen.getByRole('heading', { name: '開始使用' })).toBeInTheDocument();
    expect(screen.getAllByText(/安裝 Mac Companion/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/連接你的 AI 工具/).length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole('button', { name: '使用 Google 登入' }));
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('explains privacy and settings without exposing provider credentials', () => {
    render(<HelpScreen onNavigate={() => undefined} />);
    expect(screen.getByRole('heading', { name: '使用說明與隱私' })).toBeInTheDocument();
    expect(screen.getByText(/Provider Token 不會上傳/)).toBeInTheDocument();
    const profile: BackendProfile = { mode: 'self-hosted', label: 'My Firebase' };
    render(<SettingsScreen userName="Alice" backendProfile={profile} onNavigate={() => undefined} onSignOut={async () => undefined} />);
    expect(screen.getByText('Self-hosted')).toBeInTheDocument();
    expect(screen.queryByText(/access[_-]?token|refresh[_-]?token|api[_-]?key/i)).not.toBeInTheDocument();
  });
});
