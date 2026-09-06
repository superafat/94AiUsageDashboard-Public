import type { SetupActionCode, SetupReport } from './setup-model';

export interface SetupActionDependencies {
  login: () => Promise<string>;
  installBackground: () => Promise<{ plistPath: string }>;
}

export type SetupActionResult =
  | { state: 'done'; action: SetupActionCode; detail?: string }
  | { state: 'manual'; action: SetupActionCode; instructionCode: string };

export class AgentSetupActionError extends Error {
  constructor(readonly code: 'action_not_allowed') {
    super(code);
    this.name = 'AgentSetupActionError';
  }
}

const ACTION_ORDER: Array<keyof SetupReport['checks']> = ['platform', 'engine', 'backendConfig', 'auth', 'background', 'sync'];

export function nextSetupAction(report: SetupReport): SetupActionCode {
  for (const key of ACTION_ORDER) {
    const action = report.checks[key].nextAction;
    if (action !== 'none') return action;
  }
  return 'none';
}

export async function runSetupStep(action: SetupActionCode, deps: SetupActionDependencies): Promise<SetupActionResult> {
  switch (action) {
    case 'login_firebase': {
      const uid = await deps.login();
      return { state: 'done', action, detail: uid };
    }
    case 'install_background_sync': {
      const result = await deps.installBackground();
      return { state: 'done', action, detail: result.plistPath };
    }
    case 'install_openusage':
      return { state: 'manual', action, instructionCode: 'install_official_openusage' };
    case 'configure_firebase':
      return { state: 'manual', action, instructionCode: 'configure_self_hosted_backend' };
    case 'refresh_provider_login':
      return { state: 'manual', action, instructionCode: 'refresh_provider_login' };
    case 'none':
      return { state: 'done', action };
    default:
      throw new AgentSetupActionError('action_not_allowed');
  }
}

export interface SetupWorkflowDependencies {
  doctor: () => Promise<SetupReport>;
  runAction: (action: SetupActionCode) => Promise<SetupActionResult>;
  sync: () => Promise<void>;
}

export type SetupWorkflowResult =
  | { state: 'ready'; report: SetupReport }
  | { state: 'manual'; action: SetupActionCode; instructionCode: string };

function coreReady(report: SetupReport): boolean {
  return ['platform', 'engine', 'backendConfig', 'auth'].every((key) => report.checks[key as keyof SetupReport['checks']].state === 'ready');
}

export async function runSetupWorkflow(deps: SetupWorkflowDependencies): Promise<SetupWorkflowResult> {
  for (let step = 0; step < 8; step += 1) {
    const report = await deps.doctor();
    if (report.overall === 'error') throw new Error('setup_unhealthy');
    const action = nextSetupAction(report);

    if (action === 'install_openusage' || action === 'configure_firebase' || action === 'refresh_provider_login') {
      const result = await deps.runAction(action);
      if (result.state === 'manual') return result;
      continue;
    }
    if (action === 'login_firebase') {
      await deps.runAction(action);
      continue;
    }
    if (coreReady(report) && report.checks.sync.code !== 'sync_ready') {
      await deps.sync();
      continue;
    }
    if (action === 'install_background_sync') {
      await deps.runAction(action);
      continue;
    }
    return { state: 'ready', report };
  }
  throw new Error('setup_no_progress');
}
