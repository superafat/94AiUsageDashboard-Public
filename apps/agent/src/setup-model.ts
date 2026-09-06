export type SetupActionCode =
  | 'install_openusage'
  | 'configure_firebase'
  | 'login_firebase'
  | 'install_background_sync'
  | 'refresh_provider_login'
  | 'none';

export type CheckState = 'ready' | 'needs-action' | 'warning' | 'error';

export interface SetupCheck {
  state: CheckState;
  code: string;
  label: string;
  nextAction: SetupActionCode;
}

export interface SetupChecks {
  platform: SetupCheck;
  engine: SetupCheck;
  backendConfig: SetupCheck;
  auth: SetupCheck;
  background: SetupCheck;
  sync: SetupCheck;
}

export interface SetupReport {
  schemaVersion: 1;
  overall: CheckState;
  checks: SetupChecks;
}

const RANK: Record<CheckState, number> = { ready: 0, warning: 1, 'needs-action': 2, error: 3 };

export function buildSetupReport(checks: SetupChecks): SetupReport {
  const overall = (Object.values(checks) as SetupCheck[]).reduce<CheckState>((worst, item) => RANK[item.state] > RANK[worst] ? item.state : worst, 'ready');
  return { schemaVersion: 1, overall, checks };
}
